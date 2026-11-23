#!/usr/bin/env python3
"""Turn the speech in an audio or video file into text, optionally labelled by speaker.

    python transcribe.py meeting.m4a                # transcript only
    python transcribe.py meeting.m4a --speakers 2   # label who said what (A, B, ...)
    python transcribe.py cafe.m4a --keep-loud 2     # only the two people near the mic

Writes <name>.txt, <name>.srt and <name>.json next to the input (or into --out-dir).
Models come from ./models, or failing that the models folder beside the venv running
this script. fetch_models.py fills it.
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SR = 16000
FRAME = SR // 20  # 50 ms, the unit for measuring how loud a line is
THREADS = os.cpu_count() or 4
WHISPER_DIR = "whisper-large-v3"
SEG_MODEL = Path("diar") / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
EMB_MODEL = Path("diar") / "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
# Without a prompt Whisper drops punctuation and guesses at script and homophones. The prompt
# must read like transcript, not describe it: "以下是一段錄音逐字稿" got echoed back on a loop.
ZH_PROMPT = "嗯，好的。那我們開始吧。"


def default_models():
    """./models beside this script; failing that, the models folder beside the venv running it."""
    here = HERE / "models"
    if here.is_dir() or sys.prefix == sys.base_prefix:
        return here
    return Path(sys.prefix).parent / "models"


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def clock(sec, srt=False):
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    if srt:
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def pick_device(choice):
    if choice != "auto":
        return choice
    try:
        import ctranslate2

        return "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    except Exception:
        return "cpu"


def transcribe(audio, args):
    from faster_whisper import WhisperModel

    device = pick_device(args.device)
    compute = args.compute_type or ("float16" if device == "cuda" else "int8")
    model = args.model
    local = Path(args.models) / WHISPER_DIR
    if model == "large-v3" and (local / "model.bin").exists():
        model = str(local)
    log(f"loading whisper {model} on {device} ({compute}) ...")
    t0 = time.time()
    wm = WhisperModel(model, device=device, compute_type=compute, cpu_threads=THREADS)
    log(f"  loaded in {time.time() - t0:.0f}s, transcribing {len(audio) / SR / 60:.1f} min of audio ...")

    language = None if args.language == "auto" else args.language
    prompt = args.prompt
    if prompt is None and language == "zh":
        prompt = ZH_PROMPT
    t0 = time.time()
    segments, _ = wm.transcribe(
        audio,
        language=language,
        beam_size=5,
        vad_filter=True,
        word_timestamps=True,
        initial_prompt=prompt or None,
    )
    out = []
    for s in segments:
        words = [(w.start, w.end, w.word) for w in (s.words or [])]
        out.append({"start": s.start, "end": s.end, "text": s.text.strip(), "words": words})
        log(f"  [{clock(s.start)}] {s.text.strip()}")
    log(f"  transcribed in {time.time() - t0:.0f}s")
    return out


def diarize(audio, args, num_speakers):
    import sherpa_onnx

    seg, emb = Path(args.models) / SEG_MODEL, Path(args.models) / EMB_MODEL
    for p in (seg, emb):
        if not p.exists():
            sys.exit(f"missing {p} - run fetch_models.py first")
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(seg)),
            num_threads=THREADS,
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(emb), num_threads=THREADS),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=num_speakers, threshold=args.threshold),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not config.validate():
        sys.exit("speaker model config did not validate - check the files under models/diar")
    log("finding speakers ...")
    t0 = time.time()
    result = sherpa_onnx.OfflineSpeakerDiarization(config).process(audio).sort_by_start_time()
    turns = [(r.start, r.end, r.speaker) for r in result]
    found = len({spk for _, _, spk in turns})
    log(f"  {len(turns)} turns from {found} speakers in {time.time() - t0:.0f}s")
    return turns


def speaker_at(a, b, turns):
    """The speaker whose turn overlaps [a, b] most, else the nearest turn."""
    best, overlap = None, 0.0
    for s, e, spk in turns:
        if s >= b:
            break
        o = min(b, e) - max(a, s)
        if o > overlap:
            best, overlap = spk, o
    if best is None:
        mid = (a + b) / 2
        best = min(turns, key=lambda t: max(t[0] - mid, mid - t[1], 0))[2]
    return best


def label(segments, turns):
    """Split each segment wherever the speaker changes, word by word."""
    lines = []
    for seg in segments:
        words = seg["words"] or [(seg["start"], seg["end"], seg["text"])]
        runs = []
        for a, b, w in words:
            spk = speaker_at(a, b, turns)
            if runs and runs[-1][0] == spk:
                runs[-1][2], runs[-1][3] = b, runs[-1][3] + w
            else:
                runs.append([spk, a, b, w])
        # a blip under 0.5 s between two runs of one speaker is noise, not a turn
        for i in range(1, len(runs) - 1):
            if runs[i - 1][0] == runs[i + 1][0] != runs[i][0] and runs[i][2] - runs[i][1] < 0.5:
                runs[i][0] = runs[i - 1][0]
        merged = []
        for r in runs:
            if merged and merged[-1][0] == r[0]:
                merged[-1][2], merged[-1][3] = r[2], merged[-1][3] + r[3]
            else:
                merged.append(list(r))
        for spk, a, b, text in merged:
            if text.strip():
                lines.append({"start": a, "end": b, "speaker": spk, "text": text.strip()})
    return lines


def name_speakers(lines):
    """Rename speaker ids to A, B, ... in order of first appearance."""
    names = {}
    for ln in lines:
        if ln.get("speaker") is None:
            continue
        if ln["speaker"] not in names:
            i = len(names)
            names[ln["speaker"]] = chr(ord("A") + i) if i < 26 else f"S{i + 1}"
        ln["speaker"] = names[ln["speaker"]]
    return lines


def level_db(audio, a, b):
    """How loud [a, b] is, in dBFS: the mean RMS of its louder half of 50 ms frames, so the
    pauses between words do not drag a line down."""
    import numpy as np

    x = audio[int(a * SR):int(b * SR)].astype(np.float64)
    n = max(1, -(-len(x) // FRAME))
    x = np.pad(x, (0, n * FRAME - len(x)))
    rms = np.sqrt(np.mean(x.reshape(n, FRAME) ** 2, axis=1))
    return float(20 * np.log10(np.sort(rms)[n // 2:].mean() + 1e-9))


def loud_cut(audio, segments, margin):
    """The level below which a line counts as background, and every segment's level.

    The reference is the level reached by the loudest 10% of speech time. That is the people
    next to the microphone as long as they do at least a tenth of the talking; anything more
    than `margin` dB under it is someone further away."""
    import numpy as np

    levels = np.array([level_db(audio, s["start"], s["end"]) for s in segments])
    durations = np.array([s["end"] - s["start"] for s in segments])
    order = np.argsort(levels)
    cum = np.cumsum(durations[order])
    ref = levels[order[min(int(np.searchsorted(cum, 0.9 * cum[-1])), len(order) - 1)]]
    log(f"loud speech is at {ref:.1f} dBFS; dropping lines quieter than {ref - margin:.1f}")
    return ref - margin, levels


def drop_quiet(audio, lines, cut, levels=None):
    """Keep the lines at or above `cut`, noting each line's level in it as 'db'."""
    kept = []
    for i, ln in enumerate(lines):
        db = float(levels[i]) if levels is not None else level_db(audio, ln["start"], ln["end"])
        ln["db"] = round(db, 1)
        if db >= cut:
            kept.append(ln)
        else:
            log(f"  drop [{clock(ln['start'])}] {db:.1f} dB  {ln['text']}")
    return kept


def silence_except(audio, segments, pad=0.1):
    """A copy of the audio with everything outside `segments` silenced, so the speaker
    model only has the kept voices to tell apart."""
    import numpy as np

    out = np.zeros_like(audio)
    for s in segments:
        a, b = max(0, int((s["start"] - pad) * SR)), int((s["end"] + pad) * SR)
        out[a:b] = audio[a:b]
    return out


def write(lines, out_dir, stem, formats):
    def tag(ln):
        return f"{ln['speaker']}: " if ln.get("speaker") else ""

    written = []
    if "txt" in formats:
        p = out_dir / f"{stem}.txt"
        p.write_text("".join(f"[{clock(ln['start'])}] {tag(ln)}{ln['text']}\n" for ln in lines), encoding="utf-8")
        written.append(p)
    if "srt" in formats:
        p = out_dir / f"{stem}.srt"
        blocks = [
            f"{i}\n{clock(ln['start'], True)} --> {clock(ln['end'], True)}\n{tag(ln)}{ln['text']}\n"
            for i, ln in enumerate(lines, 1)
        ]
        p.write_text("\n".join(blocks), encoding="utf-8")
        written.append(p)
    if "json" in formats:
        p = out_dir / f"{stem}.json"
        rows = [
            {"start": round(ln["start"], 2), "end": round(ln["end"], 2), "speaker": ln.get("speaker"), "text": ln["text"]}
            | ({"db": ln["db"]} if "db" in ln else {})
            for ln in lines
        ]
        p.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
        written.append(p)
    return written


def speaker_count(value):
    if value == "auto":
        return -1
    if value.isdigit():
        return int(value)
    raise argparse.ArgumentTypeError("expected a number of speakers or 'auto'")


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="audio or video file (wav, mp3, m4a, mp4, ...)")
    ap.add_argument("--speakers", type=speaker_count, help="how many people talk; labels each line A, B, ... "
                    "'auto' guesses the count but tends to invent extra speakers")
    ap.add_argument("--language", default="zh", help="language code such as zh, en, ja, or 'auto' (default zh)")
    ap.add_argument("--prompt", help="text that steers wording and script; defaults to a Traditional "
                    "Chinese hint for zh. Pass \"\" to turn it off")
    ap.add_argument("--model", default="large-v3", help="whisper model name or folder (default large-v3)")
    ap.add_argument("--models", default=str(default_models()),
                    help="models folder (default ./models, else the one beside the venv)")
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    ap.add_argument("--compute-type", help="default int8 on cpu, float16 on cuda")
    ap.add_argument("--keep-loud", type=int, metavar="N", help="keep only the N people nearest the "
                    "microphone (the loudest), label them A, B, ... and drop quieter background talk. "
                    "Takes the place of --speakers N")
    ap.add_argument("--loud-margin", type=float, default=18.0, metavar="DB", help="with --keep-loud, "
                    "drop lines more than this many dB below the loud speech (default 18; lower drops more)")
    ap.add_argument("--threshold", type=float, default=0.5, help="clustering threshold for --speakers auto")
    ap.add_argument("--out-dir", help="where to write results (default: next to the input)")
    ap.add_argument("--formats", default="txt,srt,json", help="comma list of txt, srt, json")
    args = ap.parse_args()
    if args.keep_loud is not None:
        if args.keep_loud < 1:
            ap.error("--keep-loud needs a number of people, 1 or more")
        if args.speakers not in (None, args.keep_loud):
            ap.error("--keep-loud N already labels N speakers; leave out --speakers")
        args.speakers = args.keep_loud

    src = Path(args.input)
    if not src.is_file():
        sys.exit(f"no such file: {src}")
    out_dir = Path(args.out_dir) if args.out_dir else src.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    from faster_whisper.audio import decode_audio

    started = time.time()
    log(f"decoding {src.name} ...")
    audio = decode_audio(str(src), sampling_rate=SR)
    segments = transcribe(audio, args)

    cut, voices = None, audio
    if args.keep_loud and segments:
        # Whole Whisper lines, before the speaker model runs, so that it never hears the
        # background. Speaker-split lines get one more pass below, for a quiet 嗯 or 對 that
        # the split leaves on its own. Cutting quiet stretches out of the middle of a kept
        # line was tried and removed: on a real recording every cut was the foreground
        # speaker talking softly, 13 to 17 dB under the reference, not background.
        cut, levels = loud_cut(audio, segments, args.loud_margin)
        segments = drop_quiet(audio, segments, cut, levels)
        voices = silence_except(audio, segments)

    if args.speakers and args.speakers != 1 and segments:
        turns = diarize(voices, args, args.speakers)
        if turns:
            lines = label(segments, turns)
        else:
            log("  no speech turns found, writing without speaker labels")
            lines = [{k: s[k] for k in ("start", "end", "text")} for s in segments]
    else:
        lines = [{k: s[k] for k in ("start", "end", "text")} for s in segments]
    if cut is not None:
        lines = drop_quiet(audio, lines, cut)
        log(f"  kept {len(lines)} lines at or above {cut:.1f} dBFS")
    name_speakers(lines)

    for p in write(lines, out_dir, src.stem, set(args.formats.split(","))):
        print(p)
    log(f"done in {time.time() - started:.0f}s, {len(lines)} lines")


if __name__ == "__main__":
    main()
