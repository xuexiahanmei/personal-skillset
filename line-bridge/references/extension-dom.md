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
  },
  "reactions": [
    {
      "url": "https://stickershop.line-scdn.net/sticonshop/v1/sticon/6124aa4ae72c607c18108562/android/020_animation.png",
      "productId": "6124aa4ae72c607c18108562",
      "sticonId": "020"
    }
  ]
}
```

`reactions` is present only when the message has at least one; the summary counts
such messages as `reacted`. A reaction is a sticon image, so what it *means* (OK,
heart, ...) is only in the picture - look at `url`. The markup does not say **who**
reacted or **when**: in a 1:1 chat a reaction on an incoming message is most likely
the user's own, and a reaction may have been added long after the message. Only a
single reaction per message has been seen; any text on a bubble (a count, a "+N")
is kept verbatim as `text`, uninterpreted.

`kind` is one of `text`, `sticker` (with `sticker.productId`, `sticker.url`),
`image`, `call` (with `duration`), `system`, `unknown`. Text messages may carry
`urls` and `preview.title` / `preview.description`.

The reply object has no id of the message it answers. Link a reply to its original
by matching `replyTo.senderMid` + `replyTo.text` against earlier messages; on a real
chat this resolved 23 of 23 replies.

Neither file export carries any of: reply quotes, reactions, second-level time,
message ids, sender mids, read state, E2EE flag, sticker ids, link previews.

## API

| Call | Does |
| --- | --- |
| `LINEX.dump({log:false})` | Extract what is rendered; copy JSON to the clipboard |
| `LINEX.loadAll({ copy? })` | Scroll the list up until it stops growing, then dump; `copy: false` skips the clipboard (use it through the bridge) |
| `LINEX.watch(fn?)` | `MutationObserver`; calls `fn(message)` for each new one (a reaction added later to an existing message is not reported) |
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
    <div class="reactionPopover-module__reaction_popover__…">…</div>   <!-- "add a reaction" button, NOT a reaction -->
    <div class="reactionBubblelist-module__reaction_bubble_list__…" data-stack="false">   <!-- empty when none -->
      <button class="reactionBubble-module__reaction_bubble__…" data-more="false" data-fallback="false">
        <img class="reactionBubble-module__image__…" src="https://stickershop.line-scdn.net/sticonshop/v1/sticon/<productId>/android/<sticonId>_animation.png">
      </button>
    </div>
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

## The message box and sending (`send-dom.js`)

The open chat, its header and the message box, as rendered on 2026-09-30:

```html
<div class="chatroom-module__chatroom__…" data-mid="U…">   <!-- the chat's id; one per page -->
<div class="chatroomHeader-module__header__…">…王小明…</div>   <!-- first line of innerText = chat name -->
…
<div class="message_list" role="log">…</div>
…
<div class="chatroomEditor-module__editor_area__…">
  <textarea-ex data-is-empty="true" class="text chatroomEditor-module__textarea__…"
               placeholder="輸入訊息" maxlength="10000">
    #shadow-root (open)
      <textarea part="input" class="input" placeholder="輸入訊息" maxlength="10000"></textarea>
      <div class="cover" part="cover"></div>
  </textarea-ex>
  <div class="actionGroup-module__action_box__…">   <!-- Send file / Capture screen / Select sticker -->
</div>
</div>
```

The chatroom element's `data-mid` is the chat's id: it equals the `#/chats/<id>`
route and, in a 1:1 chat, the contact's mid on every incoming message (checked
2026-09-30). Header, message list and box all sit inside it. `send-dom.js` looks
the box up inside the editor area, and the relay pins this id at `start`, so
another chat with the same display name cannot take its place. Whether the list
can briefly lag the header during a chat switch is not known (not observed); in a
1:1 chat (an id starting with `U`) the relay therefore also forwards only rows
whose `data-mid` is the contact's.

`<textarea-ex>` is a Lit web component (its instance carries `_$E…` fields and
`renderOptions`). Its `.value` is an **array**: `[]` when empty, `["text"]` with
text. There is **no send button** - Enter sends.

What sends a message, verified live: set the inner `<textarea>`'s value through the
native `HTMLTextAreaElement.prototype` value setter (the verified way; a plain
`.value =` was not tried), dispatch an `input` `InputEvent` (bubbles, composed) - the
component then reports `data-is-empty="false"` and `.value == ["text"]` - and
dispatch a synthetic `keydown` Enter on the same textarea. The app calls
`preventDefault` on it (so `handled: true` from `commit`), sends, and empties the
box. The first send this way was cross-checked in the desktop app's chat list,
which syncs from LINE's servers, so it is a real send, not only a rendered bubble.

Not verified: multi-line text (Shift+Enter), inserting emoji or sticons, stickers,
texts near the 10000-character limit, and whether the extension ever shows sticker
suggestions after a short greeting the way the desktop app does. One greeting-like
send (`早安～今天也順利`, 2026-10-01) went out as plain text. `send-dom.js` refuses
multi-line text.

"Empty" means both `data-is-empty="true"` and an empty inner textarea: the
attribute is updated by the component and can lag behind the textarea.

`LINESEND.verify()` treats a send as landed when the number of outgoing messages
with exactly that text (as `LINEX` reads it: trimmed, emoji restored from `alt`)
has grown since `stage`. It does not require the box to be empty again - the user
may start typing the moment the bubble lands - but reports it as `boxEmpty`.

A result that is not ok says which kind it is. `notSent: true`: nothing went out -
refused before Enter, or Enter not taken (the box still held the text afterwards).
`unconfirmed: true`: the box emptied but no matching bubble appeared - the message
may have been sent, so read the chat before sending it again.

**The relay's page side** fetches `http://127.0.0.1:<port>` from the extension
page. That works: no CSP block and no local-network permission prompt (Chrome, as
of 2026-09-30). If a Chrome update starts blocking it, `LINESEND.relay.status()`
shows the error in `lastError` and the relay never logs `PAGE installed`.

## The chat list and switching chats

One row per chat, as rendered on 2026-10-01:

```html
<div class="chatlistItem-module__chatlist_item__…" data-mid="U…"        <!-- the chat's id -->
     aria-current="true" aria-selected="false"                         <!-- current = the open chat -->
     style="position: absolute; top: 71px; height: 71px; …">           <!-- virtualised list -->
  <div class="profileImage-module__thumbnail_wrap__…" data-mid="U…">…</div>
  <div class="chatlistItem-module__info__…">
    <strong class="chatlistItem-module__title_box__…">
      <span class="chatlistItem-module__text__…"><pre><span>王小明</span></pre>…</span>
    </strong>
    <time class="chatlistItem-module__date__…" datetime="Thu Oct 01 2026 09:42:24 GMT+0800 (…)">上午 9:42</time>
    <div class="chatlistItem-module__description__…">…preview of the last message…</div>
    <span class="chatlistItem-module__message_count__…">2</span>      <!-- only while there are unread messages -->
  </div>
  <button role="link" type="button" aria-label="Go chatroom" class="chatlistItem-module__button_chatlist_item__…"></button>
</div>
```

What was checked live, with the extension page in the background
(`document.visibilityState === 'hidden'`):

- **The row updates within about a second** of a new message in that chat, open or
  not: `datetime` (to the second), the preview, and the unread badge for incoming
  ones. The relay compares the three together to decide a chat has news.
- **`button.click()` on the row's button opens the chat** in 0.1-0.9 s: the
  chatroom's `data-mid`, the header and the `#/chats/<id>` route all follow.
- **A chat not opened since the page loaded shows nothing** when it is opened this
  way: `.message_list` holds one empty spacer and no notice, although the row has
  a preview. After the user opened it once by hand (window visible), opening it
  from a script in the background shows its messages, new ones included. The
  relay's start visits each chat and fails with the chat's name when it sees an
  empty list next to a non-empty preview.
- **The list is virtualised**: rows scrolled out of view do not exist. Pinned chats
  stay at the top, so the relay asks for the followed chats to be pinned.

Not verified: group chats (ids starting with `C`), a chat whose only content is
unsent messages, and what happens to a typed draft when the chat is switched (the
relay does not switch while the box holds text).

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
2. Load `extract-dom.js` and `send-dom.js` - pasting by hand is the reliable way;
   SKILL.md has a snippet that puts both on the clipboard at once. Re-pasting
   either replaces the old version; re-pasting `send-dom.js` also stops a running
   relay page side.
3. Drive them with short calls through `Invoke-DevToolsJS` (`scripts/devtools-bridge.ps1`):

```powershell
. "$SkillDir\scripts\devtools-bridge.ps1"
Invoke-DevToolsJS -Code "[typeof LINEX, typeof LINESEND]" -Raw   # ["object","object"] when loaded
$json = Invoke-DevToolsJS -Code "LINEX.collect()" -Raw
[IO.File]::WriteAllText("$scratch\chat.json", $json, (New-Object Text.UTF8Encoding $false))
```

Then analyse the file with Python. Do not print the JSON into the conversation:
52 messages is ~15k tokens raw and ~400 tokens as a summary.

If `Invoke-DevToolsJS` must load the script itself, read it with
`[IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)` - see gotchas, Encoding.

For reading and one-off replies the user picks the chat in the extension. Only the
relay switches chats by itself, and only between the chats it was told to follow
(above).
