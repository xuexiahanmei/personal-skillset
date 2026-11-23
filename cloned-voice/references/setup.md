# How the voice was built, and how to rebuild it

Everything below lives inside the Ubuntu WSL distro. Nothing here belongs in this
repo: the reference clips are a real person's recording.

## Layout

```
/opt/voxcpm/venv/                 paddle-free venv: voxcpm 2.0.3, torch 2.x+cpu, fastapi
/opt/voxcpm/tts_server.py         the service
/opt/voxcpm/say.sh                bash half of scripts/say.ps1
/opt/voxcpm/voice/
    voice.json                    cfg, steps, per-register settings
    ref_calm.wav  eq_calm.npy     4.56 s reference + its EQ curve
    ref_loud.wav  eq_loud.npy     6.97 s reference + its EQ curve
/opt/voxcpm/ref/source_48k.wav    full 53 s audio extracted from the source video
/etc/systemd/system/voxcpm-tts.service
/var/log/voxcpm/tts.log
```

Model weights: `/root/.cache/huggingface/hub/models--openbmb--VoxCPM2`, 4.7 GB.

## The recipe, and why each part is there

Each was measured against a held-out real clip - one line of the original
recording kept out of every reference, regenerated, then compared. Similarity is
the cosine of mean MFCCs.

| Step | Setting | Why |
| --- | --- | --- |
| Mode | Ultimate Cloning (`prompt_wav_path` + `prompt_text` + `reference_wav_path`) | plain `reference_wav_path` alone scored lower |
| Reference | several same-register clips concatenated with 150 ms gaps | concatenated beat single-clip on both registers (0.979 vs 0.972 calm, 0.960 vs 0.943 loud) |
| `cfg_value` | 4.0 | drives pace. 1.5 ran 1.34 s long on a 2.82 s line; 3.0-4.0 matched it. Above 4.0 the loud register degrades badly (centroid 1547 -> 1330 at cfg 6.0) |
| `inference_timesteps` | 10 | 30 was worse on every measure and twice as slow |
| Time-stretch | to the register's real chars/sec | generation length varies run to run (no seed parameter exists), so a fixed ratio will not do. calm 5.51, loud 4.45 chars/s, measured from the original clips |
| EQ | per-register curve, 1/3-octave smoothed, +/-8 dB | the source went through a phone mic and AAC, which the model does not reproduce. Without it the output is audibly "clean" and flat |

Scores against the held-out clips: calm 0.984, loud 0.988-0.992.

## The EQ must be derived per register

The two curves are not alike - calm wants only high end, loud wants body:

| | calm | loud |
| --- | --- | --- |
| 100 Hz | -2.5 dB | +8.0 dB |
| 500 Hz | -0.2 dB | +5.5 dB |
| 4 kHz | +8.0 dB | +7.3 dB |
| 8 kHz | +8.0 dB | +0.2 dB |

Deriving one curve from all the source audio at once produced a curve 13 dB too
bright: it pushed high-frequency share to 24% against a target of 11% and dropped
similarity from 0.979 to 0.916. Average only clips of the register you are fixing.

## Rebuilding

`/opt/voxcpm/build_voice.py` regenerates `voice.json`, both references and both EQ
curves from `source_48k.wav` plus a hardcoded segment table and transcripts. Run
it, then `systemctl restart voxcpm-tts`.

To add a register, extend `PROFILE` in that script with the segment ids for it
(`ref` needs trustworthy transcripts, `eq` and `rate` do not), rerun, and add the
name to the skill's table. The service picks up whatever `voice.json` lists.

Segment boundaries came from a 20 ms RMS envelope over the source, splitting on
true digital silence; the register split came from spectral centroid, which
separated cleanly at about 1333 Hz.

## Transcripts must be right

Ultimate Cloning feeds `prompt_text` as the transcript of the reference audio, so
an error there degrades the clone. These were produced by faster-whisper large-v3
per clip (whole-file transcription was measurably worse) and checked by the user.
Breeze-ASR-25 was tried and is wrong for this material - it is tuned for Taiwanese
Mandarin and the recording is mainland Mandarin; it returned nonsense on one clip.

## Service notes

- `MemoryMax=8G`. Do not lower it: loading peaks near 7.3 GB before settling at
  5.7 GB, and a 7G cap stalls the load indefinitely with no error in the log.
- One `threading.Lock` around generation, another around model loading. The second
  matters: the startup preload thread and the first request both used to trigger a
  load, and two concurrent 6 GB loads killed the box.
- `Restart=always`, enabled at boot. It does not survive `wsl --shutdown`; the next
  WSL start brings it back.
