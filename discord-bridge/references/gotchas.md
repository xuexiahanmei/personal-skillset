# Gotchas

Everything here was hit for real while building this skill, on 2026-09-18 against
Discord web in Chrome. Each entry says what proved it, because the fix only makes
sense if the cause is clear.

## Contents

- [Sending](#sending)
- [Reading the DOM](#reading-the-dom)
- [The tools themselves](#the-tools-themselves)
- [Coordinates](#coordinates)
- [Encoding and files](#encoding-and-files)

## Sending

**A message on screen is not a message that was sent.** Discord paints your message
the instant you press Return, using an id it generates locally, then replaces it
with the server's copy under a *different* id and removes the first one. Until that
swap happens the local copy is indistinguishable from a real message: it has a
plausible snowflake id, a timestamp, full opacity, and no warning of any kind.

Proved twice. Two test messages were confirmed present in the DOM with ids and
`sending: false`, and were simply gone after a reload - the tab they were sent from
died before the request reached the server. Later, `watch()` caught a single sent
message **twice**, under ids ending 7504 and 4257; only 4257 survived in the page.

The only reliable confirmation is to navigate to the conversation again and look
for the message. `DISCORDX.collect()` applies the same idea automatically: it drops
buffered messages whose element is no longer in the document.

**The composer is a Slate editor.** Assigning `textContent` or `innerText` does not
register - Slate keeps its own document model and the DOM is only its output. Type
with the `computer` tool's `type` action. `document.execCommand('insertText')` also
reaches Slate's input handling, but real typing is what has been verified here.

**Clicking the composer by element reference has silently failed.** A `find` +
click-by-`ref` sequence reported success, the typing went nowhere, and the message
was never sent. Clicking by coordinate worked immediately afterwards. Click by
coordinate, then read the composer back before pressing Return.

**After a successful send the composer is not an empty string.** It reads
`"\uFEFF\n"` - a zero-width no-break space and a newline. Strip zero-width
characters before testing it for emptiness.

**The hover toolbar depends on who wrote the message.** On your own message it
offers 加入反應 / 編輯 / 轉發 / 更多 - there is no reply button. Reply lives in the
**更多** menu. Menu items carry stable ids (`message-actions-reply`,
`message-actions-edit`, `message-actions-mark-unread`, `message-actions-copy-link`,
`message-actions-delete`), so target those rather than the localized labels.

**There is no keyboard shortcut for reply.** Focusing a message and pressing `r`
just types "r" into the composer - Discord redirects stray keystrokes there. Clear
the composer if this happens.

## Reading the DOM

**A reply's `<li>` contains the quoted message inside it**, which means it holds two
of everything: two elements whose id starts with `message-content-`, and two
username elements. In both cases the **quoted** one comes first in document order,
so `li.querySelector(...)` returns the wrong one.

The sender bug is the nastier of the two because it is plausible: every reply gets
attributed to the person being replied to. Caught by the fixture tests, not by
looking at the page. Look both up by exact id instead:
`getElementById('message-content-' + messageId)` and `'message-username-' + messageId`.

**Consecutive messages from one person have no header at all.** Only the first
`<li>` of a run carries `groupStart` and a username; the rest have a timestamp but
no sender anywhere in their DOM. Carry the sender forward while walking the list.

**System messages** (joins, pins) have `isSystemMessage` in their class, no sender,
and **no `<time>` element**. Their timestamp has to come from the snowflake:
`(BigInt(id) >> 22n) + 1420070400000n` is the creation time in milliseconds.

**Date separators sit above the group they introduce**, matching reading order.
(LINE puts them below, which is worth remembering if both skills are in play.)
They can be ignored entirely here - every message carries an exact `datetime`.

**`(edited)` renders inside the content element**, so it lands in the message text
unless it is removed first. It is UI chrome, not something anyone typed.

**Class names are hashed CSS modules** (`messageListItem__5126c`) and change with
every Discord build. Match by prefix with `[class*="..."]`. The `id` and
`data-list-id` attributes are the stable part and are what this skill leans on.

**The `<ol>` is not the scrolling element.** Its ancestor with `overflow-y: scroll`
is - walk up until `scrollHeight > clientHeight`. Setting `scrollTop` on the `<ol>`
does nothing and looks like the page refusing to scroll.

**Only about 50 messages are rendered.** The list is virtualized; older messages
load asynchronously when you scroll up. Scroll, wait in a separate call, then dump.

## The tools themselves

**Never `await` a timer inside `javascript_tool`.**
`await new Promise(r => setTimeout(r, 300))` makes the call hang until the 45-second
CDP timeout, and the tab stops responding to screenshots meanwhile. This happened
twice and was first misdiagnosed as "writing to the editor broke the page" - the
tab was fine, the evaluate call was not. Do the waiting in a separate `computer`
`wait` action.

**Any JSON key containing "author" is redacted.** The harness's secret scanner is
guarding "authorization" and blanks the value to `[BLOCKED: Sensitive key]`
regardless of what it is - tested with a plain string, a boolean, a number, and a
nested object; `sender` and `who` pass through untouched. An extractor that returns
an `author` field silently returns nothing useful. This is why the field is called
`sender`, and the tests assert it.

**Long tracking parameters in message text trigger the same scanner.** A URL carrying a long
opaque tracking parameter, or a passphrase-shaped string, gets part of the output
redacted. Strip query strings from attachment URLs (the extractor does) and expect
the occasional blocked digest when real messages contain token-like text.

**If screenshots start failing, the tab is dying.** Repeated
`Script injection timed out` while `javascript_tool` still works means the tab is
half-dead; it may then be recreated under a new id, at which point everything
targeting the old id fails with "not in Claude's tab group". Open a fresh tab
rather than fighting it - and treat anything that tab reported as unconfirmed.

**A batch beats separate calls for anything involving hover or menus**, because a
hover toolbar or context menu can close between calls. `browser_batch` runs the
interaction and the inspection in one round trip.

## Coordinates

**Rectangles from JavaScript are not in the `computer` tool's frame.** Measured:
`innerWidth` 1920 and `innerHeight` 911 against a tool frame of 1568x744 - a
consistent factor of **0.8167** on both axes. Passing a raw `getBoundingClientRect()`
value gets either a silent miss or "outside the coordinate frame".

```js
const k = FRAME_WIDTH / innerWidth;          // FRAME_WIDTH from the last screenshot
const point = [Math.round((r.left + r.width / 2) * k),
               Math.round((r.top + r.height / 2) * k)];
```

Take a screenshot first to learn the current frame - it changes when the window is
resized, and it is reported on every screenshot result.

**Re-read a rectangle right before using it.** The message list scrolls on its own
when new messages arrive.

## Encoding and files

**`sed` turned `\u200B` escapes into real zero-width characters** in
`extract-dom.js`. The regex still worked - a character class of literal zero-width
characters is equivalent - but the source became invisible in an editor. The class
is now built with `new RegExp("[\\u200B-\\u200D\\uFEFF]", "g")` so a rewriting tool
cannot quietly mangle it. After any `sed` pass over a file with escapes, check with
`od -c`.

**Discord pads message text with zero-width characters.** Strip
`\u200B`-`\u200D` and `\uFEFF` or equality checks against message text fail for no
visible reason.
