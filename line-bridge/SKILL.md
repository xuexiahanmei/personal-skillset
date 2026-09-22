---
name: line-bridge
description: "Read, reply to, export and watch LINE chats on this Windows machine by driving the LINE desktop app and the LINE Chrome extension. Use this whenever the user wants anything done in LINE - seeing what someone sent, replying to a contact (幫我回 XXX 的訊息, 看一下 XXX 傳了什麼, 發 XXX 你好), summarising or saving a conversation, getting the quoted message behind a reply, exporting chat history, or keeping an eye on LINE for new messages - even when they never mention automation. Covers sending without taking the user's mouse or keyboard, reading messages exactly and cheaply through the extension's DOM instead of screenshots, and a set of verified traps (Escape closes chat windows, a locked screen blocks keyboard input, CJK window titles need Unicode APIs, reply quotes are missing from every export)."
---

# LINE bridge

LINE on this machine has two surfaces, and each is good at different things:

- **LINE desktop app** (Qt). Input goes in with `PostMessage` and screenshots come
  out with `PrintWindow`, so it works in the background - the cursor never moves -
  and keeps working while the Windows session is locked. It is the way to **send**.
  It has no text API at all, so reading it means screenshots.
- **LINE Chrome extension**. Its messages are plain DOM, so `extract-dom.js` reads
  them as exact JSON, including the **quoted message behind every reply**, which no
  export contains. Getting code into its DevTools console needs the real keyboard,
  so the session must be unlocked.

`scripts/` sits next to this file. Every PowerShell tool call is a new process, so
dot-source in each call: `. "<this skill's directory>\scripts\line-bridge.ps1"`.
Save screenshots to the session scratchpad. Save exports and message dumps outside
any repository - they are the user's private conversations.

## Pick the path

| The user wants | Use | Because |
| --- | --- | --- |
| What someone said, with reply context or reactions | Extension DOM | exact text, quotes and reactions; 52 messages cost ~400 tokens as a summary |
| To read while the screen is locked, or the extension is not open | Desktop app, cropped screenshots | the only thing that works while locked |
| Complete history as plain text | `Export-LineChat` + `parse_export.py` | exact, byte-stable; no quotes; briefly takes focus |
| To send a message | Desktop app | background input, works while locked |
| New messages as they arrive | `LINEX.watch()` | event-driven, no polling |

Run `Test-SessionLocked` before choosing. If it is true, only the desktop-app path
can work - say so rather than trying the extension and failing.

## Replying to someone

A sent message cannot be taken back, and the person on the other end is real. So
the order is always: read, draft, get the text approved, type, look, send, look.

1. **Read the context** (sections below). Opening a chat marks its messages read -
   mention that if the user might want the unread badge kept. If the name is short
   or common, run `Find-LineChat -Name X -PreviewPath <png>` and look at the results
   before opening anything.
2. **Draft in the user's own voice.** Their recent outgoing messages show how they
   write (line length, particles, punctuation); match that. Offer a few directions
   and say which you would pick and why. Do not invent a relationship: if the sender
   is unfamiliar - no history, no call button in the chat header - ask who they are.
3. **Get the exact text approved.** A clear instruction such as "發 X 你好" is
   approval of that text.
4. **Type without sending, then look.** `Save-ComposeShot` shows the chat title, the
   draft and the last bubbles for ~200 tokens. Check the recipient and the text.
5. **Deal with the sticker panel only if it is there.** Short greetings can open a
   sticker-suggestion panel over the chat; if the shot shows it, call
   `Close-LineStickerSuggestion` and look again. Do not press Escape otherwise: with
   nothing to dismiss, Escape closes the chat window and the send silently fails.
6. **Send, then look again.** `Send-LineEnter`, then `Save-ComposeShot`: the new
   bubble must be there and the box empty. Only then tell the user it was sent.
7. **Multi-line text becomes separate messages.** Shift+Enter cannot be sent in
   the background, so send each line on its own and tell the user.

```powershell
. "$SkillDir\scripts\line-bridge.ps1"
$chat = Open-LineChatByName -Name "王小明"         # throws if the first hit is another chat
[void](Post-ClickWindow -Win $chat -X 200 -Y ($chat.H - 151))
[void](Post-TextToWindow -Win $chat -Text "哈哈 有可能")
Save-ComposeShot -Win $chat -Path "$scratch\draft.png"     # read it before going on
```

```powershell
. "$SkillDir\scripts\line-bridge.ps1"
$chat = Open-LineChatByName -Name "王小明"         # reuses the open pop-out
Send-LineEnter -Win $chat
Save-ComposeShot -Win $chat -Path "$scratch\sent.png"      # read it before reporting
```

Keep a decision that needs a screenshot in its own tool call, so the image can be
read before the next step runs.

## Reading through the extension

The user does a one-time setup: open the LINE extension window, right-click ->
Inspect, undock DevTools into its own window, open **Console**, type
`allow pasting`, and paste `scripts/extract-dom.js`. Pasting it by hand is the
reliable part; after that, short calls can be driven from PowerShell:

```powershell
. "$SkillDir\scripts\devtools-bridge.ps1"
Invoke-DevToolsJS -Code "typeof LINEX" -Raw        # "object" once loaded
$json = Invoke-DevToolsJS -Code "LINEX.collect()" -Raw
[IO.File]::WriteAllText("$scratch\chat.json", $json, (New-Object Text.UTF8Encoding $false))
```

Then analyse the file with Python (`PYTHONIOENCODING=utf-8`) and bring only what
is needed into the conversation - the last few messages, the reply chains, a
summary. The raw JSON for 52 messages is ~15k tokens; a summary is a few hundred.

The extension shows whichever chat the user has open in it; switching chats is up
to the user. `Invoke-DevToolsJS` refuses to type unless DevTools is truly in the
foreground and throws if the console never ran the code - trust those errors.

Details, the JSON shape, the markup the extractor depends on, and what to do when
the extension changes: `references/extension-dom.md`.

## Reading through the desktop app

```powershell
. "$SkillDir\scripts\line-bridge.ps1"
$chat = Open-LineChatByName -Name "王小明"
Save-WindowShot -Win $chat -Path "$scratch\msgs.png" -Crop @(0, 110, $chat.W, ($chat.H - 110))
[void](Post-ScrollWindow -Win $chat -X 280 -Y 350 -Notches 10)   # positive scrolls up
```

A whole 563x882 chat window costs ~660 tokens to look at and shows about six
messages; crop to the part that matters. Scrolling does not always move the view -
check the next capture rather than assuming. The main (chat-list) window cannot
display a conversation; always work in the pop-out.

## Exporting history

`Export-LineChat` drives LINE's own **Save chat** and `parse_export.py` turns the
file into JSONL. Format, parser behaviour, what the export drops, and the dead ends
already ruled out (encrypted local DB, empty UI Automation tree, extension storage,
notification DB): `references/export-format.md`.

## Keeping the token cost down

Images always land in the conversation; files do not have to. Prefer getting data
into a file and summarising it with a script. When a screenshot is needed, crop it:
cost scales with pixel area (about width x height / 750 tokens). Screenshots are for
checking state before and after an action, not for reading history.

## Traps that cost the most time

Full list with the evidence behind each: `references/gotchas.md`.

- Escape closes a pop-out chat window when no popup is open.
- Posting Enter proves nothing; confirm every send with a screenshot.
- A locked session blocks everything that needs the foreground, and the failures
  look like flaky automation. Check `Test-SessionLocked` first.
- Window-title APIs must be the Unicode variants, or CJK names read as `?` and never
  match.
- PowerShell 5.1 reads BOM-less UTF-8 as ANSI. Read files with
  `[IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)`; keep `.ps1` files ASCII.
- A clipboard left over from an earlier run looks like a fresh result.

## Files

| Path | What |
| --- | --- |
| `scripts/line-bridge.ps1` | Desktop app: find/open chats, background click/scroll/type/send, cropped capture, export, lock check |
| `scripts/devtools-bridge.ps1` | Run a JS expression in the undocked DevTools console and get the result back, safely |
| `scripts/extract-dom.js` | Paste into the extension's console: `LINEX.dump / collect / loadAll / watch / stop` (text, reply quotes, reactions) |
| `scripts/dom-probe.js` | Diagnostic for when the extension's markup changes |
| `scripts/parse_export.py` | "Save chat" `.txt` -> JSONL |
| `references/gotchas.md` | Every verified trap, plus layout coordinates |
| `references/extension-dom.md` | Extension markup, extractor output, console setup |
| `references/export-format.md` | Export format, what it drops, ruled-out approaches |
| `references/realtime-design.md` | Earlier real-time design, superseded; measurements still valid |
| `tests/` | `npm install && npm test` - validates the extractor against a transcribed fixture |
