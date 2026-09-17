# Reading LINE messages in real time — what works, what doesn't

> **Superseded.** This was the plan before the Chrome extension's DOM was found to
> carry reply quotes. For real-time reading use `LINEX.watch()` from
> `scripts/extract-dom.js` (see `extension-dom.md`): a `MutationObserver` delivers
> each new message as exact JSON, with no polling, screenshots or OCR. What below is
> still accurate: the measurements (WAL mtime behaviour, PrintWindow cost) and the
> dead ends. Kept for the reasoning, not as instructions.

Findings from investigating how to get LINE desktop message text out of the app
continuously, rather than by repeatedly running a full chat export.

Measured on LINE for Windows 9.3.0.3440, 2026-09-12.

## The premise that turned out to be wrong

Repeated exporting was assumed to cost too much space. It doesn't: a two-year,
1019-message chat exports to **40 KB**. Hourly exports kept forever would be about
1 MB/day, and only the latest is needed.

The real cost of `Export-LineChat` is **time and interruption** — roughly 10 seconds
per run, and opening the `···` menu is the one step that has to take window focus,
because Qt will not raise a popup for an inactive window.

So the thing worth avoiding is running the export *often*, not storing its output.

## Reading the app's internal state: three dead ends

| Route | Result |
| --- | --- |
| Local message database | `%LOCALAPPDATA%\LINE\Data\db\qw*.edb`, 430 MB. Header is `3c 25 ce 19 …`, not `SQLite format 3` — SQLCipher-encrypted. Reading it means extracting the key from LINE.exe's memory: large effort, breaks on every update. |
| UI Automation | The window exposes 78 elements. **0** have a non-empty `Name`; 70 advertise Text/Value patterns but every one returns empty. LINE's QML declares no `Accessible` properties. |
| Network capture | LINE pins certificates, and the chat menu itself states the conversation is protected with **Letter Sealing** (end-to-end encryption). Intercepted traffic would be ciphertext. |

There is no supported entry point into the app's own state. Everything below works
*around* the app rather than inside it.

## What is available, measured

### Trigger: the encrypted DB's WAL file

`%LOCALAPPDATA%\LINE\Data\db\qw*.edb-wal`

The file is pre-allocated, so its **size never changes** (5862792 bytes throughout)
— but its **mtime updates on every database write** (observed 02:31 → 03:33). Polling
that timestamp costs essentially nothing and fires for all activity, **including
muted chats**.

It says *when* something happened, never *what*.

### Content: PrintWindow capture

`Save-WindowShot` on a 563x882 chat window:

- **20.8 ms** per capture (10 captures in 208 ms)
- **27.8 KB** per PNG
- Does not move the cursor, does not take focus, and works while LINE is behind
  other windows

Cheap enough to run on every WAL tick, hash, and discard when unchanged.

This is also the **only** layer that can see reply quotes — see below.

### Secondary signal: the Windows notification database

`%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db` is **plain, unencrypted
SQLite**. LINE registers as handler `LINE.RC_x486b4ff3yryg!LINE.RC` (RecordId 399), and
notification payloads are toast XML whose `<text>` nodes carry sender and message body.

Three hard limits make it unsuitable as the primary source:

1. Muted chats never raise a notification, and most group chats here are muted.
2. The `Notification` table holds only notifications **currently on screen** — 14 rows
   at the time of checking. Dismissed ones are gone; it is a live queue, not a log.
3. A notification carries the body only — no reply quote.

## Reply quotes exist only as pixels

Three text routes were each tested and each drops the quoted message:

| Route | Result |
| --- | --- |
| Windows `Save chat` export | Reply becomes an ordinary message line |
| Phone export (`[LINE](name).txt`) | Same — 2844 messages parsed, no reply marker anywhere |
| Right-click → `Copy` | Clipboard receives the body only |

The Windows result was established by experiment in Keep memo: send `TEST_A`, send
`TEST_B`, reply to one of them, export. `TEST_A` appears exactly once in the `.txt`
(the original), and the reply is a bare line with nothing pointing back.

So any design that needs reply structure has to read the rendered window.

## Proposed architecture

Three layers, each doing only what it is good at.

**1. Trigger — watch the WAL mtime.**
Near-zero cost, catches every chat including muted ones.

**2. Content — capture and OCR on change.**
On each tick, `PrintWindow` the open chat window (20.8 ms), hash the bitmap, and drop
it if unchanged. When it changed, send the PNG to PaddleOCR locally (`/opt/ocr/venv`
in WSL Ubuntu) and discard the image, keeping only text. This layer recovers reply
quotes: a quote renders as an indented sub-block *above* the message body, so its text
appears in OCR output and is absent from the export.

**3. Ground truth — a full export, once a day.**
40 KB, corrects any OCR drift. The export's exact text is what gets stored; OCR is
only used to decide *which* message is a reply and *what it points at*, matched
fuzzily against lines the export already contains. That way OCR quality never degrades
the stored text — it only adds or fails to add a link.

## Honest limits

- The OCR layer is heuristic. No claim of 100% accuracy.
- Only the **open chat window** can be captured. Messages in chats that aren't open
  are caught only by layer 3's periodic export.
- Windows may suppress notifications while LINE is in the foreground, so the
  notification signal has blind spots.
- `SetForegroundWindow` is refused unpredictably by Windows' foreground lock, which
  makes anything menu-driven (export, unsend) the least reliable part of the tool.

## Status

Layers 1 and 3 are built and verified (`line-bridge.ps1`, `parse_export.py`).
Layer 2 was never built; the DOM route replaced it.
