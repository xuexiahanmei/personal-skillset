#!/usr/bin/env python3
"""Download the models transcribe.py uses (about 3 GB, once).

    python fetch_models.py            # whisper + speaker models
    python fetch_models.py --no-diar  # whisper only

They go into ./models, or when that does not exist and a venv is running this script,
into a models folder beside the venv - the same place transcribe.py looks.
"""
import argparse
import shutil
import sys
import tarfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
WHISPER_REPO = "Systran/faster-whisper-large-v3"
RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
SEG_URL = f"{RELEASES}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
# "recongition" is the real upstream tag name, typo included
EMB_URL = f"{RELEASES}/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"


def default_models():
    """./models beside this script; failing that, the models folder beside the venv running it."""
    here = HERE / "models"
    if here.is_dir() or sys.prefix == sys.base_prefix:
        return here
    return Path(sys.prefix).parent / "models"


def download(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    with urllib.request.urlopen(url, timeout=60) as r, open(part, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    part.replace(dest)


def fetch_whisper(models):
    dest = models / "whisper-large-v3"
    if (dest / "model.bin").exists():
        print(f"whisper: already in {dest}")
        return
    from huggingface_hub import snapshot_download

    print(f"whisper: downloading {WHISPER_REPO} (~3 GB) ...", flush=True)
    snapshot_download(WHISPER_REPO, local_dir=str(dest))
    print(f"whisper: done -> {dest}")


def fetch_diar(models):
    diar = models / "diar"
    seg = diar / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
    if seg.exists():
        print("speaker segmentation: already there")
    else:
        print("speaker segmentation: downloading ...", flush=True)
        archive = diar / "segmentation.tar.bz2"
        download(SEG_URL, archive)
        with tarfile.open(archive, "r:bz2") as tar:
            member = next(m for m in tar.getmembers() if m.name.endswith("/model.onnx"))
            seg.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(member) as src, open(seg, "wb") as dst:
                shutil.copyfileobj(src, dst)
        archive.unlink()
        print(f"speaker segmentation: done -> {seg}")

    emb = diar / "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
    if emb.exists():
        print("speaker embedding: already there")
    else:
        print("speaker embedding: downloading ...", flush=True)
        download(EMB_URL, emb)
        print(f"speaker embedding: done -> {emb}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", default=str(default_models()),
                    help="where to put them (default ./models, else beside the venv)")
    ap.add_argument("--no-diar", action="store_true", help="skip the speaker-labelling models")
    args = ap.parse_args()
    models = Path(args.models)
    fetch_whisper(models)
    if not args.no_diar:
        fetch_diar(models)
    print("all models ready")


if __name__ == "__main__":
    main()
