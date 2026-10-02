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
| `LINEX.loadAll({ copy?, deadlineMs?, sleep? })` | Scroll the list up until it stops growing, then dump; `copy: false` skips the clipboard (use it through the bridge). `deadlineMs` stops on the clock; a load that did not reach the end returns `truncated: true` |
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

`LINESEND.verify()` treats a send as landed when an outgoing bubble that was not
there at `stage` (by its `selectId`) is now in the same chat with that text, and is
not older than what was newest at `stage` (less two minutes, for two clocks that
need not agree): an old message with the same text that scrolls into view while
waiting is not the one just sent (tests/send.js, "an older bubble with the same
text"). The text is compared after the clean-up `LINEX` applies when it reads -
trimmed, emoji restored from `alt`, zero-width characters dropped, runs of
whitespace collapsed: in the mock page a byte-for-byte comparison called a sent
emoji sequence (which holds a zero-width joiner) unconfirmed; how real emoji read
back has not been tried. It does not require the box to be empty again -
the user may start typing the moment the bubble lands - but reports it as
`boxEmpty`. With another chat open than the one typed in, it answers `moved`
instead of counting that chat's bubbles: before this, a send that never left was
reported `ok` when the user switched to a chat that already held the same text
(tests/send.js, "the chat changed right after Enter").

A result that is not ok says which kind it is. `notSent: true`: nothing went out -
refused before Enter, called off by `beforeCommit`, or Enter not taken (the app did
not call `preventDefault` and the box still held the text afterwards).
`unconfirmed: true`: the message may have been sent, so read the chat before
sending it again - the box emptied but no matching bubble appeared, another chat
was opened right after Enter, or the app took the Enter and the text is still in
the box (then it is left there, not cleared). `send()` waits on the clock
(`timeoutMs`), not for a number of sleeps: a hidden page's timers run about once a
minute, and twenty of them used to hold the relay for twenty minutes.

**The page side** fetches `http://127.0.0.1:<port>` from the extension page. That
works for relay.py's plain requests: no CSP block and no local-network permission
prompt (Chrome, as of 2026-09-30). If a Chrome update starts blocking it,
`LINESEND.relay.status()` shows the error in `lastError` and the relay never logs
`PAGE installed`. The hub's requests carry a custom header, which makes Chrome
send a preflight first; that has not been seen live yet (see "Not verified live").

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

## The hub and the page (`LINESEND.relay.link`, `mcp/hub.mjs`)

`relay.link({ url, token, build })` is the page side of the MCP tools. It asks the
hub for work in a loop and does one item at a time: a message to send, or one of
four ops - `status`, `read`, `follow`, `unfollow`. The ops live in a `Map`; nothing
that arrives is run as code, and the URL and token cannot be changed from the hub.

```
GET  /poll?wait=..   -> { epoch, follow: [chat ids], items: [0 or 1] }   409: a newer paste took over, stop
POST /commit {id}    -> { go }                          asked right before Enter
POST /sent  {id, chat, chatId, text, ok | notSent | unconfirmed, why}
POST /result {id, ok, value | why}                      an op's answer
POST /in    {chat, chatId, selectId, ts, sender, kind, text, replyTo, sticker}
POST /log   {event: linked | unfollowed | not-restored, ...}
GET  /wait?ms=..                                        a wait timed by the hub
```

Every request carries the page token in the header `x-line-bridge-token` (a URL
shows up in the page's resource timings) and `i` (a random id for this paste), `l`
(when it linked) and `b` (the build, a hash of the two scripts as pasted) in the query.
The page token is not the control secret: it only opens the page's endpoints, and
only for the LINE extension's origin. It does stay where a paste leaves things -
the clipboard, Windows' clipboard history if that is on, the DevTools console
history - until `line_setup` runs again with no page linked, which replaces it.

What keeps a message from going out twice, late or to the wrong chat. Each rule
has a check in `tests/hub.test.js`, `tests/hub-page.test.js` or `tests/send.js`,
and on 2026-10-01 each check was shown to fail with its rule taken out (34 rules
broken one at a time in a copy of the code; all 34 noticed):

- **Ids come from the caller** (a UUID per tool call), and the hub never runs one
  twice. The page also remembers the ids it handled - for as long as that paste
  lives; a new paste starts empty.
- **One hand-over.** The hub gives an item to the page once. relay.py leases a
  reply for 60 s and then offers it again - to a freshly pasted page, which would
  send it a second time.
- **The go before Enter.** The page types, waits 300 ms, and asks `POST /commit`.
  The hub says go only while the caller still waits, the time limit (75 s from
  the request) has not passed and, for an auto-reply, its approval still stands;
  without a go the page takes its text back and reports `notSent`. A go that the
  page gets to act on more than 5 s after asking (a debugger pause, a frozen tab)
  is not acted on either. So "timed out before the go" is a definite `notSent`,
  and only "go, then no report" is `unconfirmed`.
- **Reports are kept.** A `/sent` the hub did not get stays in the page and is
  offered again each round, also to another hub on the same port, which logs it
  with `late: true`. The exception is a page that was told to stop (a newer paste,
  a refused token): what it had not reported stays unreported, and the caller is
  told `unconfirmed`.
- **The chat is bound by id.** A send names `chatId`; the row's name must still go
  with it, and the hub only accepts an (id, name) pair this page reported.
- **Switching chats** (only in link mode): not while the message box holds text,
  not while the LINE window has the keyboard focus (`document.hasFocus()`: the
  user's next keystroke would land in the chat switched to). After a switch,
  nothing is read or typed until the list has stopped showing every message it
  held before the click (by `selectId`; 2 s, then a refusal) - in case the list
  can lag the header. A chat whose messages did not load is refused before
  anything is typed. A read that loads older messages returns nothing if another
  chat was opened while it ran. After a direct send or a read the
  page goes back to the chat that was open - after reporting, asking the same
  questions again right before the click, and only away from a chat that item
  itself opened (`restored: false` otherwise; `PAGE not-restored` when the click
  back failed).
- **The hub decides what is followed.** Every answer to a poll lists the followed
  chat ids; the page drops whatever is not listed, and everything when another hub
  answers (a new `epoch`). So a follow whose caller went away mid-way, or whose
  session ended (the hub ends it after 45 s without a word from that session), or
  that `line_unfollow` stopped while the page was silent, does not go on. And no
  chat is opened except right after an answer from the hub: with the hub away,
  nothing is marked read for nobody.
- **Nothing follows again by itself, and nothing old is reported as new.** After
  a restart or a new paste, following takes a new `line_follow`, and a newly
  followed chat starts from what is in it then: none of that is forwarded as
  `IN`. The follow's answer says per chat how many incoming messages came after
  the last outgoing one (`unanswered`), for the caller to read and decide. Only a
  chat that is still followed when it is followed again goes on from where it
  stands. A follow takes effect whole or not at all: one that fails at its third
  chat leaves the chats followed before, and what was waiting in them, as they
  were. (An earlier version kept a dropped follow's position for ten minutes to
  resume from; a second review showed it replaying hours-old, already answered
  messages as new ones, so it is gone.)

The page's waits are timed by the hub in link mode (`GET /wait`, and each `/poll`
is held up to 1.5 s): an answer to a fetch arrives when it is sent, while a hidden
page's own timers run about once a minute. With no hub, it falls back to timers.

### Not verified live

As of 2026-10-01 everything in this section ("The hub and the page") has run
against the mock page only (`tests/mock-line.js`); what the earlier sections call
verified live was verified through the console bridge.

- What a bubble that failed to send looks like (offline, or LINE refusing it). If
  it is rendered like any other outgoing row, `verify()` takes it for sent.
- Whether the message list can lag the header after a scripted switch. The page
  waits until none of the messages shown before the click is still shown; if LINE
  were to show something else in between (neither the old chat nor the new), it
  would be taken for the new chat's.
- Chrome sends `Origin: chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc` on
  these fetches, accepts the hub's preflight answer for the token header, and
  shows no local-network prompt. (The hub answers that origin only.)
- An answer to a fetch is not delayed in a hidden or minimised window the way
  timers are - the reason for the hub-timed waits.
- `document.hasFocus()` is true only while the LINE window has the keyboard focus,
  and false while its DevTools window has it.
- A paste of both scripts plus the link line lands whole. It is about 40 KB
  (2026-10-02): `line_setup` leaves out comment lines, blank lines and indentation,
  which takes it down from 63 KB. About 34 KB had been pasted by hand before.
- Group chats (`C...` ids) open and load like 1:1 chats, and their header's first
  line equals the row's name.
- Text with emoji or several spaces reads back, after the clean-up above, equal to
  what was sent.

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

With the MCP tools: `line_setup` puts both scripts and the `relay.link(...)` line
on the clipboard; the user pastes once per page load (SKILL.md, "Linking the
page"), and everything after goes through the hub. What it copies is the scripts
with every line trimmed and the comment and blank lines left out - the same
program at two thirds of the size - so neither script may hold a string or a
template literal that runs over several lines (`tests/mcp.test.js` checks that,
and runs the pasted text). Without the tools:

1. The user opens the extension window, right-clicks -> Inspect, undocks DevTools
   (separate window), opens **Console**, types `allow pasting` once.
2. Load `extract-dom.js` and `send-dom.js` - pasting by hand is the reliable way;
   `devtools-bridge.md` has a snippet that puts both on the clipboard at once.
   Re-pasting either replaces the old version; re-pasting `send-dom.js` also stops
   a running relay page side (a message it is sending at that moment still goes
   out once and is reported).
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

On this path, for reading and one-off replies the user picks the chat in the
extension; only relay.py's page side switches chats by itself, and only between the
chats it was told to follow. In link mode the page switches to the chat a tool
names, under the guards listed in "The hub and the page".
