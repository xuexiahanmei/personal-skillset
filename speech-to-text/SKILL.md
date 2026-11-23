---
name: speech-to-text
description: "Transcribe the speech in an audio or video file into timestamped text on this machine, optionally labelling who said what (speaker A, B, ...) - Whisper large-v3 plus speaker diarization, fully local, nothing uploaded. Use this whenever the user wants a recording, voice memo, voice message, meeting, interview, call, lecture, podcast or video turned into text, subtitles or minutes, wants to know what was said or who said it, or wants a recording summarised - even when they only give a file path. Triggers include English like 'transcribe this', 'make subtitles for this video', 'who said what in this meeting', and Traditional Chinese like 語音轉文字, 幫我轉逐字稿, 聽打, 會議記錄, 這段錄音在講什麼, 幫我做字幕, 誰說了什麼, 把影片轉成文字, 只要比較大聲的兩個人, 背景的人聊天不用. Covers the command, picking the speaker count, keeping only the people near the microphone and dropping background chatter (--keep-loud), the Chinese prompt, the output files, and the traps (a run takes about as long as the recording, the automatic speaker count invents people, one-word replies get misattributed)."
---

# Speech to text

Local transcription. faster-whisper (Whisper large-v3, int8 on CPU) produces the words;
sherpa-onnx (pyannote segmentation plus 3D-Speaker voiceprints) works out who spoke.
Anything with an audio track works: wav, mp3, m4a, mp4, mov, a saved LINE or Discord
voice message.

| | |
| --- | --- |
| Entry point | `scripts/transcribe.py` in this skill |
| Python | `C:\dev-workspace\tools\speech-to-text\venv\Scripts\python.exe` - this venv, never the system Python |
| Models | `C:\dev-workspace\tools\speech-to-text\models` (3 GB), found automatically beside the venv |

## Running it

```powershell
& "C:\dev-workspace\tools\speech-to-text\venv\Scripts\python.exe" "<this skill's directory>\scripts\transcribe.py" "D:\rec\meeting.m4a" --speakers 2
```

This writes `meeting.txt`, `meeting.srt` and `meeting.json` next to the input (or into
`--out-dir`) and prints their paths on stdout. Progress, including each line as it is
recognised, goes to stderr.

**Run anything longer than a couple of minutes in the background.** On this machine's CPU
a run takes 1 to 1.4 times the length of the recording: a 4.3-minute meeting took 4 to 6
minutes, and loading the model adds about 5 seconds. Tell the user the expected wait up
front (about an hour for an hour-long recording), start it with `run_in_background`, and
read the output file when it finishes.

The `.txt` looks like this; `.srt` carries the same labels, and `.json` holds rows of
`{start, end, speaker, text}` (plus `db` with `--keep-loud`), which is the format to use
for any further processing.

```
[00:00] A: Good morning. Did you finish the report for the client?
[00:04] B: Not yet. I still need the sales numbers from last week.
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--speakers N` | off | Label lines A, B, ... for N people. `auto` guesses the count, badly |
| `--keep-loud N` | off | Keep only the N people nearest the microphone, labelled A, B, ...; drop background talk. Use instead of `--speakers N` |
| `--loud-margin DB` | `18` | With `--keep-loud`: drop lines more than this many dB under the loud speech. Lower drops more |
| `--language` | `zh` | `zh`, `en`, `ja`, ..., or `auto` |
| `--prompt` | a short Chinese phrase for `zh` | Steers wording and spelling. `""` turns it off |
| `--out-dir` | next to the input | Where the results go |
| `--formats` | `txt,srt,json` | Any subset |
| `--device` | `auto` | This machine has no NVIDIA GPU, so it always runs on the CPU |

## Choosing `--speakers`

- Labels are only worth having when the user cares who said what, as in meeting minutes or
  interviews. Leave them off for a voice memo or a lecture.
- Pass the real headcount. If the user wants labels and you do not know how many people
  talk, ask. `auto` invents speakers: on a two-person meeting it found 12 to 20.
- Labels are letters in order of first appearance, not names. Map A and B to people only
  from what the user tells you or what the recording itself says (introductions, someone
  addressed by name), and say which mapping you assumed.

## Background chatter: `--keep-loud N`

Use it when the user wants only the people next to the phone and not the room around them
(只要比較大聲的兩個人, 背景聊天不用), as with a discussion recorded in an office, café or
restaurant. N is the number of foreground people; it replaces `--speakers N`.

- **What it does.** After Whisper, it measures every line's level. The reference is the
  level the loudest 10% of speech time reaches, which is the foreground as long as they do a
  tenth of the talking. Lines more than `--loud-margin` (18) dB under it go. The speaker
  model then hears only what was kept, silenced everywhere else, and splits it into exactly
  N voices. A last pass drops a quiet 嗯 or 對 that the speaker split left on its own.
- **Measured on a real recording** (12.7 min, two people discussing a spec in an office
  with others chatting): the foreground's soft passages ran down to 15 dB under the
  reference, and the self-test's background voice sits about 24 dB under, hence 18. The
  labels came out as exactly two people, and only a few quiet fillers (嗯, 對, 好, 就是)
  were dropped. The room's chatter never reached the transcript at all: Whisper skips
  faint speech.
- **Words inside a line are never cut.** Cutting quiet stretches out of a kept line was
  tried and removed: every cut on the real recording was the foreground speaker talking
  softly. So background that Whisper runs into the same sentence as a foreground line
  stays in it.
- **Do not fake it with extra speakers.** Running `--speakers 4` on a two-person recording
  to give the background "its own" labels failed: the model split one foreground person
  into two clusters instead, and picking clusters by loudness would have thrown away the
  person who did most of the talking.
- **Check what went.** stderr logs the reference, the cut, and every dropped line with its
  level; tell the user how many lines were dropped. Each `.json` row carries `db`.
- **Tuning.** Background still in: filter the `.json` by `db` for a stricter cut (for
  example 15 dB under the reference), no rerun needed. Foreground lost (on-topic lines in
  the drop log): rerun with `--loud-margin 22` or so, which means a full transcription
  again. That asymmetry is why the default leans towards keeping.
- **It judges loudness, not identity.** Someone in the background who shouts or walks up
  to the phone passes, and is credited to one of the N people. A foreground speaker who
  turns away or mumbles can lose soft lines. Faint background often never gets transcribed
  at all; then the option mostly drops quiet fillers and keeps the labels to N real voices.

## Chinese, spelling and jargon

- `--language zh` is the default and sends `嗯，好的。那我們開始吧。` as Whisper's initial
  prompt. Without it, Whisper dropped punctuation and wrote homophones (易岸 instead of
  議案). Mixed Mandarin and English technical talk comes through fine.
- For names and jargon, put them into a natural spoken sentence:
  `--prompt "嗯，好的。今天討論議案變更跟 hash 同步。"`. Never write a prompt that
  *describes* the recording, such as `以下是一段繁體中文的錄音逐字稿。`: Whisper repeated
  that sentence back as the transcript, over and over, and took eight times as long.
- For an English recording pass `--language en`; the Chinese prompt applies only to `zh`.

## After transcribing

- Read the output file rather than the stderr log, which is only progress.
- Whisper still mishears Mandarin homophones, for example 出發 for 觸發 and 起標 for 旗標.
  When summarising, fix the obvious ones from context, but quote the transcript as it is
  and say when you corrected a word.
- For a long transcript, do not paste the whole thing into the chat. Give the file path,
  then the summary, minutes or passages the user asked for.

## Traps

- **One-word replies and fragments at a speaker change get misattributed.** 嗯, 好, 對 and
  the first few characters after someone takes over are often credited to whoever was
  talking around them. Long turns are reliable. Say so when attribution matters.
- **Overlapping speech is not separated**; it all goes to one speaker.
- **Use this venv and do not upgrade anything in it.** It pins `av==18.1.0`, because av 19
  breaks faster-whisper 1.2.1 (`TypeError: open() got an unexpected keyword argument
  'metadata_errors'`).
- **Run one transcription at a time.** One run peaks at about 2.8 GB. The cloned-voice
  service holds 5.7 GB inside WSL on this 15.6 GB machine, so the two fit together, but
  two transcriptions on top of that are pushing it.
- **From PowerShell, do not redirect the script's stderr** (`2>&1`, `2>$null`) while
  `$ErrorActionPreference` is `Stop`. PowerShell 5.1 turns every progress line into an
  error record and aborts the run.
- **Ignore `/opt/asr` inside WSL.** Those are one-off experiment scripts from building the
  cloned voice, with hard-coded input paths.
- **Recordings are real people's conversations.** Transcripts go next to the input by
  default. Never write them into this repo, and do not post them anywhere yourself.

## When it fails

- `missing ...\models\diar\...`, or Whisper cannot load its model: the models folder is
  missing or incomplete. Run
  `& "C:\dev-workspace\tools\speech-to-text\venv\Scripts\python.exe" "<this skill's directory>\scripts\fetch_models.py"`,
  which downloads only what is missing.
- `TypeError: ... 'metadata_errors'`: av was upgraded. Reinstall `av==18.1.0` into the venv.
- To check the whole chain, run `tests\selftest.ps1`. In about a minute it transcribes a
  synthetic two-voice conversation, then the same with a quiet third voice in between, and
  checks the words, the labels, and that `--keep-loud 2` drops the quiet voice.

`references/INSTALL.md` rebuilds everything from nothing, on this machine or another one.
It is self-contained, with both scripts embedded, so it can be handed to an agent on a
fresh machine. After changing anything in `scripts/`, run
`python tests\check_install_md.py --fix` so that the copy inside `INSTALL.md` stays
identical.
