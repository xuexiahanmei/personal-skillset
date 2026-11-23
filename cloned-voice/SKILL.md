---
name: cloned-voice
description: "Speak text aloud in the user's cloned voice - a specific woman's voice built from a reference recording, with a calm register and a shouting register. Use this whenever the user wants something said out loud, voiced, dubbed, read aloud, turned into audio or a voice message (念出來, 用她的聲音說, 語音回覆, 配音, 轉語音), or when a bot should answer with speech instead of text. The two registers are separate voice references and the tone CANNOT be steered by wording or by an instruction in the text - you must classify each sentence yourself and pass calm or loud. Covers single lines, passages that change tone partway through, the WSL service that holds the model resident, and the traps (Windows cannot reach the WSL port directly, about 20 s per call, 300 character cap)."
---

# Cloned voice

A VoxCPM2 service inside WSL holds a 2B model resident and speaks in a cloned
voice. `scripts/say.ps1` is the only entry point; it shells into WSL because
Windows cannot reach the service's port (see Traps).

**You choose the tone.** The voice has two registers, each cloned from different
reference clips. Nothing in the text changes the delivery - writing "she shouted"
or passing an instruction does nothing. This was measured: a calm reference asked
to say an angry line came back with a spectral centroid of 913 Hz against the calm
reference's 915 Hz, i.e. completely unmoved. Classify, then pass `calm` or `loud`.

## Picking the register

| Use `loud` | Use `calm` |
| --- | --- |
| Shouting, anger, an outburst | Ordinary statements and questions |
| Confrontation, an accusation, an insult | Explanations, apologies, small talk |
| An order barked at someone | A firm but level refusal |
| Text carrying `!` in a hostile sense | Text carrying `!` in a cheerful sense |

`loud` is anger, not volume or excitement. Happy shouting is still `calm` - the
reference clips are all from an argument, so `loud` always sounds hostile. When
a line is merely emphatic, pick `calm`; a wrongly hostile delivery is much more
jarring than a flat one.

## Speaking one line

```powershell
& "<this skill's directory>\scripts\say.ps1" -Text "the line" -Emotion calm
```

Returns the output path. Without `-Out` it writes to `%TEMP%`. Add `-Format mp3`
for anything being uploaded - Discord and the like prefer it to 48 kHz WAV.

## Passages that change tone

Do not force one register onto a passage that shifts. Split it and let each
sentence carry its own, which is the main reason this skill has two registers:

```powershell
$json = '[{"text":"...","emotion":"calm"},{"text":"...!","emotion":"loud"}]'
& "<this skill's directory>\scripts\say.ps1" -Script $json -Out C:\tmp\a.wav
```

Segments are joined with a 180 ms gap (`-GapMs`). One segment per tone change,
not one per sentence - consecutive sentences in the same register belong in the
same segment so the prosody flows.

## Before a long job

`-Probe` returns the service health without generating anything. `model_loaded:
false` means the next call pays about 30-50 s of load on top of generation, so
probe first and tell the user to expect the wait.

```powershell
& "<this skill's directory>\scripts\say.ps1" -Text x -Probe
```

## Traps

- **About 20 s per call** once the model is warm, roughly 1.5x the spoken length.
  Say so before voicing anything long, and prefer answering in text first with the
  audio following.
- **300 characters per request**, counted across all segments. Longer text must be
  split into several calls; there is no queue, so they run one after another.
- **Windows cannot reach the service's port.** It listens on 127.0.0.1:18790
  inside WSL and that is unreachable from Windows even in mirrored networking
  mode. `say.ps1` goes through `wsl.exe` instead. Do not "fix" this by binding the
  service to 0.0.0.0 - that publishes it to the LAN.
- **The service eats about 5.7 GB.** This machine has 15.6 GB with a 9 GB WSL cap,
  and it has been OOM-killed before. If other heavy work is starting, stop it:
  `wsl -d Ubuntu -u root -- systemctl stop voxcpm-tts`.
- **The reference clips are a real person's recording.** They live in WSL at
  `/opt/voxcpm/voice/` and must never be committed to this repo. Generated audio
  is the user's business, but do not post it anywhere yourself, and do not use the
  voice to imitate that person to somebody who would believe it.

## When it fails

`say.ps1` throws with the exact command to run. In order:

```powershell
wsl -d Ubuntu -u root -- systemctl status voxcpm-tts
wsl -d Ubuntu -u root -- tail -30 /var/log/voxcpm/tts.log
wsl -d Ubuntu -u root -- systemctl restart voxcpm-tts
```

The unit restarts itself on failure, so a dead service usually means the whole
distro was shut down (`wsl --shutdown`, a reboot, or sleep). Starting WSL again
brings it back; the first call after that pays the load.

`references/setup.md` covers how the voice was built and how to rebuild it,
retune it, or add a third register.
