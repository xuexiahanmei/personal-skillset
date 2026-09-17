# LINE Chrome extension: DOM and extraction

The LINE Chrome extension (`ophjlpahpchlmihnnnihgmmeilfjmjjc`, main page
`chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc/index.html`) renders messages
into ordinary light DOM - no shadow roots, no iframes. It is the only place where
reply quotes can be read as text.

## What `extract-dom.js` returns

`LINEX.dump()` returns `{ summary, messages }` and copies it to the clipboard.

```json
{
  "id": "900000000000000001",
  "selectId": "01789182169503-900000000000000001",
  "ts": 1789182169503,
  "datetime": "Sat Sep 12 2026 11:02:49 GMT+0800 (台北標準時間)",
  "displayTime": "上午 11:02",
  "date": "2026-09-12",
  "sender": "王小明",
  "senderMid": "U...",
  "direction": "incoming",
  "e2ee": true,
  "read": false,
  "kind": "text",
  "text": "the reply body",
  "replyTo": {
    "sender": "李小華",
    "senderMid": "U...",
    "text": "the full text of the message being answered",
    "kind": "text"
  }
}
```

`kind` is one of `text`, `sticker` (with `sticker.productId`, `sticker.url`),
`image`, `call` (with `duration`), `system`, `unknown`. Text messages may carry
`urls` and `preview.title` / `preview.description`.

The reply object has no id of the message it answers. Link a reply to its original
by matching `replyTo.senderMid` + `replyTo.text` against earlier messages; on a real
chat this resolved 23 of 23 replies.

Neither file export carries any of: reply quotes, second-level time, message ids,
sender mids, read state, E2EE flag, sticker ids, link previews.

## API

| Call | Does |
| --- | --- |
| `LINEX.dump({log:false})` | Extract what is rendered; copy JSON to the clipboard |
| `LINEX.loadAll()` | Scroll the list up until it stops growing, then dump |
| `LINEX.watch(fn?)` | `MutationObserver`; calls `fn(message)` for each new one |
| `LINEX.stop()` | Stop watching |
| `LINEX.collect()` | The array, without copying |

The list only holds what the extension has rendered - roughly the last week of a
busy chat. `loadAll()` scrolls to pull in older history.

## Markup it relies on

Stable hooks are `data-*` attributes; class names carry CSS-module hashes
(`message-module__message__7odk3`) that change when the extension updates, so every
class selector matches on the prefix (`[class*="message-module__message__"]`).

```html
<div class="message_list" role="log">          <!-- newest FIRST -->
  <div class="replyMessage-module__message__… message-module__message__…"
       data-direction=""                           <!-- "" incoming, "reverse" outgoing -->
       data-timestamp="1789182169503"
       data-message-select-id="0<ts>-<messageId>"
       data-message-content-prefix="11:02 王小明 "   <!-- HH:MM + sender + space -->
       data-mid="U…"                              <!-- sender -->
       data-is-e2ee-message="true"
       data-message-content="貼圖">               <!-- only on stickers (貼圖) / images (圖片) -->
    <div class="replyMessageContent-module__content_wrap__…">
      <button aria-label="See in chat">          <!-- the QUOTE -->
        <div class="…thumbnail_wrap…" data-mid="U…"/>
        <pre class="username-module__username__…"><span>李小華</span></pre>
        <p class="replyMessageContent-module__text__…"><span>quoted text</span></p>
      </button>
      <div class="replyMessageContent-module__reply_content__…">   <!-- the BODY -->
        <pre class="textMessageContent-module__text__…"><span data-is-message-text="true">body</span></pre>
      </div>
    </div>
    <span class="metaInfo-module__read_count__…">已讀</span>
    <time class="metaInfo-module__send_time__…" datetime="Sat Sep 12 2026 11:02:49 GMT+0800 (…)">上午 11:02</time>
  </div>
  <div class="systemMessage-module__message__…">…以下為尚未閱讀的訊息…</div>
  <div class="messageDate-module__date_wrap__…" data-message-content="2026.9.12 星期六">
</div>
```

Things that went wrong in the extractor, and why the code looks the way it does:

- **The list is newest-first and each date separator sits BELOW its group.**
  Carrying the last separator forward tags every message with the next day. Dates
  are derived from `data-timestamp` instead.
- **A reply whose body is a sticker also has `data-message-content="貼圖"`.**
  Checking that attribute before looking for the quote drops the reply link, so the
  reply check runs first.
- **Emoji are `<img class="emoji" alt="💡">`**, so `textContent` loses them.
  `readText` puts the `alt` back.
- **The sender name can contain spaces**, so it is sliced off the fixed-width
  `HH:MM ` prefix rather than split on whitespace.
- **Zero-width joiners** separate some nodes; they are stripped.

## When the extension changes

`scripts/dom-probe.js` is a read-only diagnostic: paste it with a known message on
screen (set `NEEDLE`) and it reports whether the text is reachable, where it lives
(light DOM, shadow root, iframe), the `data-*` attributes present, and the markup
around it. Update `SEL` in `extract-dom.js`, add the new shape to
`tests/fixture.html`, and run the tests.

A quick check that needs nothing loaded:

```js
[document.body.innerText.includes('text on screen'),
 document.body.textContent.includes('text on screen'),
 document.querySelectorAll('iframe').length]
```

`[false, true, 0]` means present but not rendered; `[false, false, 0]` a shadow
root; a non-zero third value an iframe. A plain `false` can also just mean the text
is in a different chat than the one open - check that first.

## Getting the script into the console

1. The user opens the extension window, right-clicks -> Inspect, undocks DevTools
   (separate window), opens **Console**, types `allow pasting` once.
2. Load `extract-dom.js` - pasting by hand is the reliable way.
3. Drive it with short calls through `Invoke-DevToolsJS` (`scripts/devtools-bridge.ps1`):

```powershell
. "$SkillDir\scripts\devtools-bridge.ps1"
Invoke-DevToolsJS -Code "typeof LINEX" -Raw                 # "object" when loaded
$json = Invoke-DevToolsJS -Code "LINEX.collect()" -Raw
[IO.File]::WriteAllText("$scratch\chat.json", $json, (New-Object Text.UTF8Encoding $false))
```

Then analyse the file with Python. Do not print the JSON into the conversation:
52 messages is ~15k tokens raw and ~400 tokens as a summary.

If `Invoke-DevToolsJS` must load the script itself, read it with
`[IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)` - see gotchas, Encoding.

Switching the extension to another chat is not implemented; the user clicks it.
