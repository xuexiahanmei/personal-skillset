# Gotchas

Every item here was hit for real. Grouped by where it bites.

## Contents

- [Sending](#sending)
- [Finding and opening chats](#finding-and-opening-chats)
- [Window handling](#window-handling)
- [Locked session](#locked-session)
- [DevTools bridge](#devtools-bridge)
- [Encoding](#encoding)
- [Coordinates and DPI](#coordinates-and-dpi)

## Sending

**Escape closes the pop-out chat window when nothing is open to dismiss.**
Escape was once sent "just in case" before Enter. No popup was open, so Escape
closed the window, the Enter went to a dead handle, and nothing was sent - while
the script printed "sent". Only press Escape (`Close-LineStickerSuggestion`) when a
compose screenshot shows the sticker-suggestion panel.

**Typing a greeting can open the sticker-suggestion panel.** Words like 你好 make
LINE pop up matching stickers over the conversation, and the typed text renders
highlighted. Enter in that state may send a sticker instead of the text. When the
compose screenshot shows the panel, dismiss it, screenshot again, then send.

**Never report a send without looking.** Posting Enter proves nothing. Take a
`Save-ComposeShot` afterwards: the new bubble must be there and the input box empty.

**Newlines cannot be typed.** LINE sends on Enter and inserts a newline on
Shift+Enter. `PostMessage` cannot carry the Shift state (Qt reads modifiers with
`GetKeyState`, which posted messages do not update), and `WM_CHAR 0x0A` is silently
swallowed - `AAA<LF>BBB` arrives as `AAABBB`. Send each line as its own message and
tell the user the bubbles will be separate.

**Opening a chat marks its messages read.** Mention it before opening a chat whose
unread badge the user may want to keep.

**Unsend and Delete need a confirmation dialog**, and a modal LINE dialog closes the
moment its window is deactivated. Every PowerShell tool call is a separate process,
so the whole right-click -> Unsend -> confirm sequence has to run inside a single
call. Right-click menus also need the window active, which `SetForegroundWindow`
does not reliably grant - treat unsend as best-effort and prefer asking the user.

## Finding and opening chats

**The main window cannot show a conversation.** It snaps back to a narrow,
chat-list-only layout within a second of being widened or maximized, and clicking
its expand chevron does not stick. Always pop the chat out (`Open-LineChat` /
`Open-LineChatByName`) and work in that window.

**The first search result is usually - not always - the exact-name chat.** Groups
whose names contain the search text, or message hits, can come first. When the name
is short or common, run `Find-LineChat -PreviewPath` and look before opening.

**A freshly opened pop-out needs a moment.** Poll for the new window rather than
sleeping once; LINE can take a few seconds to create it and set its title.

**LINE raises a newly opened pop-out to the front.** That is LINE's behavior, not
the script's. Everything after opening is quiet.

**A chat with no call button in its header** usually means the other person is not
a mutual friend (they added you, or you have not added them back). Useful context
when deciding how to answer an unfamiliar sender.

## Window handling

**`MainWindowHandle` drifts.** Windows repoints the process's main window at
whichever LINE window was last activated, so after a pop-out has been used it no
longer means "the chat list". `Get-LineMainWindow` finds the list by its title.

**A minimized window's rect collapses to about 158x26**, so size filters that
ignore small windows also hide the minimized chat list. `Get-LineWindows` lets
iconic windows through.

**Popup menus and dialogs are separate untitled top-level windows.** They do not
show up in `Get-LineWindows`; find them by diffing the visible windows before and
after (`Find-LinePopup`).

**`EnumWindows` callbacks run in their own PowerShell scope.** `$list += $x` inside
one only changes a local copy and the list comes back empty. Accumulate into an
`ArrayList`.

**Pop-out windows do not survive.** If the user closes one, its handle is dead;
look windows up again instead of caching handles across calls.

## Locked session

When the Windows session is locked the foreground window belongs to `LockApp`
("Windows 預設鎖定畫面" on a zh-TW system). Measured behavior:

| Mechanism | Locked |
| --- | --- |
| `PrintWindow` capture | works |
| `PostMessage` input to LINE (Qt) | works |
| `SetForegroundWindow`, `AttachThreadInput` | fail |
| `SendKeys`, real mouse, the DevTools bridge | cannot work |

`Test-SessionLocked` checks this. Several "the paste did not land" failures turned
out to be nothing but a locked screen.

## DevTools bridge

**Chrome ignores `PostMessage` input.** Unlike LINE's Qt window, the DevTools and
extension windows only respond to real input, which needs the foreground.

**Misdirected keystrokes are dangerous in a browser.** If focus did not move,
`Ctrl+L`, `Ctrl+V`, `Enter` means "address bar, paste, navigate".
`Invoke-DevToolsJS` refuses to type unless DevTools really is in the foreground.

**The foreground is not enough - Console must be the active panel.** DevTools was
in front but showing Elements: the paste did nothing and `Enter` opened the
selected node's `class` attribute for editing. A second call would have pasted
over that attribute and committed it, rewriting the live page. The bridge threw
"Console never ran the code" as designed. When it does, capture the DevTools
window before retrying; if it is not on Console, press Escape (cancels an
attribute edit without changes) and have the user switch back. Seen 2026-09-22.

**A stale clipboard looks like success.** Scripts that `copy()` their result leave
the previous result on the clipboard when they never ran. `Invoke-DevToolsJS`
checks the clipboard changed away from what it pasted; when doing it by hand,
compare hashes between runs.

**Large pastes are the unreliable part.** A 10 KB paste repeatedly failed to land
while short expressions went through. Load `extract-dom.js` once (by hand is fine)
and drive it with short calls.

**`allow pasting`** must be typed once per DevTools session before Chrome accepts a
paste into the console.

**Claude in Chrome cannot open `chrome-extension://` pages**, and a Chrome extension
cannot script another extension's pages anyway. Launching Chrome with
`--remote-debugging-port` is refused by Chrome 136+ for the default profile and is
also blocked in this harness. The DevTools console on the user's own window is the
way in.

**The console keeps definitions between pastes.** `extract-dom.js` assigns
`globalThis.LINEX` so re-pasting a newer version replaces the old one instead of
throwing "already declared".

## Encoding

**Window titles need the Unicode API.** A C# `DllImport` without
`CharSet=CharSet.Unicode` binds `GetWindowTextA`. On a machine whose non-Unicode
code page is 1252, every CJK character comes back as `?`, and comparing a window
title to a contact name silently never matches. This was first misdiagnosed as a
timing problem.

**PowerShell 5.1 reads BOM-less files as ANSI.** `Get-Content -Raw` on a UTF-8 file
without a BOM mangles CJK. When `extract-dom.js` was pasted that way, its
`'貼圖'` / `'圖片'` literals turned into mojibake and every sticker and image was
reported as `unknown` (the tell: `…` showed up as `â€¦` in the console). Use
`[IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)`. The `.ps1` files in this skill
are kept pure ASCII so dot-sourcing them never has this problem.

**Python on this machine prints with cp1252 by default.** Set
`PYTHONIOENCODING=utf-8` before printing anything with CJK in it.

**`grep -P` does not work in this Git Bash locale** and fails quietly behind
`|| echo 0`. Use Python for anything involving non-ASCII.

## Coordinates and DPI

**Call `SetProcessDPIAware()` before reading any rectangle.** Without it, the display
scaling (150% here) shrinks every rect and clicks land in the wrong place. The
lookup functions do it; hard-coded rects read in one process and reused in another
are the trap.

**Button messages take client coordinates; `WM_MOUSEWHEEL` takes screen
coordinates.**

**`SW_RESTORE` can move a window.** Re-read its rect after restoring.

**Known layout offsets** (default sizes, DPI-aware pixels):

| Where | Offset |
| --- | --- |
| Chat-list search box (546px-wide main window) | (295, 123) |
| First search result row | (300, ~250) |
| Pop-out message box | (200, H - 151) |
| Pop-out `...` menu button | (531, 87) |
| "Save chat" in a 1:1 chat's 285x669 menu | y = 403 |
| "Save chat" in Keep Memo's 285x393 menu | y = 208 |
| Message context menu (176x365): Reply / Copy / Unsend | y = 45 / 86 / 168 |
| Unsend confirm dialog (420x381): plain "Unsend" | (210, 256) |

When a window is a different size, capture it once and measure instead of guessing.
