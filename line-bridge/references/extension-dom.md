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
four ops - `status`, `read`, `follow`, `unfollow` (the last two are only ever asked
for when the follow tools are switched on: "Following: the second phase" below).
The ops live in a `Map`; nothing that arrives is run as code, and the URL and
token cannot be changed from the hub.

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

What keeps a message from going out twice, late or to the wrong chat - and from
being reported as something it was not. The checks are in `tests/hub.test.js`,
`tests/hub-page.test.js`, `tests/send.js` and `tests/mcp.test.js`. On 2026-10-02,
73 rules of the hub, the page script and the server were taken out one at a time
in a copy of the code, and the test file for each was run: 72 failed as they
should. The 73rd (no time limit on the question before Enter) did not - the test
waited for an answer that never came, and Node, left with nothing to do, ended
the file with exit code 0. Every test file now fails when it ends before its last
check, and that rule is noticed too. On 2026-10-15, after a fourth review, 88
rules (those 73 and 15 more, among them eight the reviewer had removed unnoticed):
85 failed at once; the other three were guarded only by a rule that now covers
them too (the duplicate guard after a hub restart, and the log after a caller
left), got checks of their own, and are noticed since. This says the rules that
were tried are guarded; it does not say every rule was tried - the list in
"Following: the second phase" names removals that still go unnoticed.

- **Ids come from the caller** (a UUID per tool call), and the hub never runs one
  twice. The page also remembers the ids it handled - for as long as that paste
  lives; a new paste starts empty.
- **One hand-over.** The hub gives an item to the page once. relay.py leases a
  reply for 60 s and then offers it again - to a freshly pasted page, which would
  send it a second time.
- **The go before Enter.** The page types, waits 300 ms, and asks `POST /commit`
  (giving up after 5 s without an answer). The hub says go only while the caller
  still waits, the time limit (75 s from the request) has not passed and, for an
  auto-reply, its approval still stands; without a go the page takes its text
  back and reports `notSent`. A go that the page gets to act on more than 5 s
  after asking (a debugger pause, a frozen tab) is not acted on either. So "timed
  out before the go" means the page did not press Enter, and the caller hears
  `notSent`; "go, then no report" is `unconfirmed`. (The user's own Enter can
  still send a text the page holds: see the duplicate guard.)
- **The box decides.** Until Enter the typed text sits in a box the user can
  reach. Nothing is typed while the LINE window has the keyboard focus - also not
  into the chat that is open - and that is asked again before the hub is asked
  and after it answered. From there, only a box that still holds exactly the
  typed text is the page's to send from or to take back (`notSent`). A box that
  was emptied or typed into is never `notSent`: the page asks for no go, looks
  for the bubble - an Enter of the user's may have sent the text - and reports
  `ok` with a `why`, or `unconfirmed`. Another chat opened meanwhile: the text is
  taken back if the box now shown holds it, and is `unconfirmed` (it may be left
  as a draft in the first chat) if not.
- **Reports are kept.** A `/sent` the hub did not get stays in the page and is
  offered again each round, also to another hub on the same port, which logs it
  with `late: true`; the duplicate guard goes by it (below). The exception is a
  page that was told to stop (a newer paste, a refused token): what it had not
  reported stays unreported, and the caller is told `unconfirmed` if the go had
  been given, `notSent` if not - with the text still under the guard. (An item
  handed to a link at the moment `relay.link()` replaces it on the same paste is
  not run at all; its caller hears `notSent` after the time limit, about 80 s.)
- **The chat is bound by id.** A send names `chatId`; the row's name must still go
  with it, and the hub only accepts an (id, name) pair this page reported.
- **The duplicate guard.** The same text to the same chat within 2 minutes is
  refused, unless a direct send says `allowDuplicate`. Only a `notSent` that cannot
  be wrong frees the text: one the page reported (it looked at the box), or one
  for a message the page never had. When the hub itself gives up on a message the
  page holds (its time limit, the caller gone), the page may already have typed it
  and the user's own Enter can still send it: the claim stays until the page's
  report says what became of it - taken back frees it, sent or unconfirmed keeps
  it - or for its two minutes. A late report that the text went out puts a claim
  back if none is left (a hub that restarted). Each message only ever drops its own
  claim: a repeat that was allowed and then did not go out leaves the first send's
  claim standing.
- **Switching chats** (only in link mode): not while the message box holds text,
  not while the LINE window has the keyboard focus (`document.hasFocus()`: the
  user's next keystroke would land in the chat switched to). After a switch,
  nothing is read or typed until the list has stopped showing every message it
  held before the click (by `selectId`; 2 s, then a refusal) - in case the list
  can lag the header - unless the list is positively the chat's own (below). In a
  1:1 chat every incoming row carries the contact's id (seen live 2026-09-30), so
  a list holding an incoming row from anyone else is another chat's: nothing is
  read or typed there, also when no switch was made (the user may have switched
  by hand while the list was behind), and a bubble seen in such a list is not
  taken for sent. A 1:1 list whose incoming rows are all the contact's is that
  chat's own. After a refusal of either kind nothing else is done in the window -
  no read, no typing, no further switch, no way back - until the old rows are gone
  from the list, the list is positively the open chat's own, or the user has
  opened another chat by hand: a second switch would only hide the first. A
  group's rows say nothing of whose they are; there, only the wait for the old
  rows guards. A chat whose messages did not load is refused before anything is
  typed. A read that loads older messages
  returns nothing if another chat was opened while it ran. After a direct send or
  a read the page goes back to the chat that was open - after reporting, asking
  the same questions again right before the click, and only away from a chat that
  item itself opened (`restored: false` otherwise; when the click back fails after
  the report, only a `PAGE not-restored` line in the log says so).

The page's waits are timed by the hub in link mode (`GET /wait`, and each `/poll`
is held up to 1.5 s): an answer to a fetch arrives when it is sent, while a hidden
page's own timers run about once a minute. With no hub, it falls back to timers.

An answer to `read` whose switch got as far as the header carries `switch`, so
that the real page's behaviour can be learned from use: `headerMs` (click until
the header was seen showing the chat - looked at every 100 ms, each look a wait
timed by the hub, so it can be a round trip late), `laggedAtHeader` (were rows of
the chat before still shown at that moment), `listMs` (when they were seen gone:
first looked at after the list has settled - 150 ms to 2 s - so an upper bound,
and equal to `headerMs` when they were gone at the header already),
`rowsAtHeader` and `rowsSettled` (did the list fill in after the header).
`laggedAtHeader` and `listMs` are null when the chat before showed no rows, and
`listMs` is null when the old rows never went. No `switch` when the header never
showed the chat, or when nothing was switched. The `line_read` tool passes it on
as `switch: { header_ms, list_lagged, list_ms, rows_at_header, rows_settled }`.

Typing moves the page's own focus into the message box; when a send is over, the
page puts it back where it was (the search field, say), so that a key the user
types on coming back does not land in the box.

### Not verified live

As of 2026-10-15 everything in this section ("The hub and the page") has run
against the mock page only (`tests/mock-line.js`); what the earlier sections call
verified live was verified through the console bridge. When a point is settled by
a live run, write the date and what was seen next to it.

- That `setValue('')` - the native setter and an `input` event - really empties
  LINE's box. Every "nothing is left in the box" (a `notSent` after typing) rests
  on it; the live check of 2026-09-30 covered typing and Enter, not taking text
  back.
- That moving the page's focus back after a send (to where it was, or nowhere)
  does nothing else to LINE's box - no draft saved, no text lost.

- What a bubble that failed to send looks like (offline, or LINE refusing it). If
  it is rendered like any other outgoing row, `verify()` takes it for sent.
- Whether the message list can lag the header after a scripted switch, and whether
  it fills in after the header has changed. `switch` in a `line_read` answer
  measures both: **write the numbers of the first live switches here** - they
  decide how following is rebuilt. Until then: the page waits until none of the
  messages shown before the click is still shown; if LINE were to show something
  else in between (neither the old chat nor the new), it would be taken for the
  new chat's. A list still filling in when it is read gives a short read, and a
  send's check for its own bubble a starting point that is too old. After a
  switch the *user* made by hand while the list was behind, a 1:1 chat is guarded
  by its contact's id on every incoming row; a group, or a 1:1 list with no
  incoming row in view, is not.
- What becomes of text in the message box when another chat is opened: kept as
  that chat's draft, carried into the next chat's box, or dropped. The page
  handles each; which one the real page does is not known.
- Chrome sends `Origin: chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc` on
  these fetches, accepts the hub's preflight answer for the token header, and
  shows no local-network prompt. (The hub answers that origin only.)
- An answer to a fetch is not delayed in a hidden or minimised window the way
  timers are - the reason for the hub-timed waits.
- `document.hasFocus()` is true only while the LINE window has the keyboard focus,
  and false while its DevTools window has it.
- A paste of both scripts plus the link line lands whole. It is about 44,000
  characters (2026-10-15): `line_setup` leaves out comment lines, blank lines and
  indentation, which takes it down from about 70,600. About 34 KB had been pasted
  by hand before. (The test fails above 50,000, to catch growth by accident.)
- Group chats (`C...` ids) open and load like 1:1 chats, and their header's first
  line equals the row's name.
- Text with emoji or several spaces reads back, after the clean-up above, equal to
  what was sent.
- Claude Code asks the user on every `line_send` (`requiresUserInteraction` and
  the `ask` rule), showing the chat and the whole text, with no "don't ask again".

### Following: the second phase

`line_follow`, `line_reply`, `line_unfollow` and `line_events` exist and are tested
against the mock page, but the server registers them only when started with
`LINE_BRIDGE_EXPERIMENTAL_FOLLOW=1`. That switch is for working on them. It is not
for a real account: an auto-reply goes out without a prompt, on the strength of an
`IN` event, and the faults below are about exactly those events.

How it works today:

- **The hub decides what is followed.** Every answer to a poll lists the followed
  chat ids. If that list is not exactly the page's own, the page stops following
  every chat and logs `PAGE unfollowed`; the same when another hub answers (a new
  `epoch`). So a follow whose session ended (the hub ends it after 45 s without a
  word from that session), or that `line_unfollow` stopped while the page was
  silent, does not go on. And no chat is opened except right after an answer from
  the hub: with the hub away, nothing is marked read for nobody.
- **Nothing follows again by itself, and nothing that was already there is
  reported as new.** After a restart or a new paste, following takes a new
  `line_follow`, and a newly followed chat starts from what is in it then. The
  answer says per chat how many incoming messages came after the last outgoing
  one (`unanswered`). A chat that is still followed when it is followed again
  goes on from where it stands. A follow that the page refuses at its k-th chat
  changes nothing. (An earlier version kept a dropped follow's position for ten
  minutes to resume from; the second review showed it replaying hours-old,
  already answered messages as new ones, so it is gone.)
- **An auto-reply** (`/reply`) is taken only inside what the user approved in the
  `line_follow` prompt - the chats, a number of replies, a time - and for the
  session that asked; the approval is counted when the reply is accepted and
  checked again at the go.

Open, from the third independent review (2026-10-02; each was reproduced in the
mock page unless marked):

1. A message that could not be collected in time - the user was in the LINE
   window, the box held a draft, the chat's row was out of view - is passed on
   later as a plain `IN`, with nothing saying it is late or that an outgoing
   message already follows it; nothing is logged while it waits.
2. A `line_follow` that is cancelled, or that the hub stops waiting for, while
   the page is still visiting the chats ends the follow that was there before -
   and the tool says "as it was".
3. An incoming message stamped at or before the newest row at follow time (two
   clocks) is marked seen and never passed on (`ts > startTs`).
4. `line_follow` reports the state of the event log as read before its own
   writes: the call whose `FOLLOW` line cannot be written says nothing.
5. The baseline of a newly followed chat is whatever the list holds 150-300 ms
   after the header changed; rows that render later would become `IN`. (By
   reading only; needs the live measurement above.)
6. A follow answer that arrives a moment after `line_unfollow` was answered
   undoes it.
7. The `unanswered` note says "not reported as IN" also for a chat that was
   already followed, where some of the counted messages were.
8. A new follow ends only the caller's own approval, and `line_follow` takes
   display names where everything else takes chat ids.
9. Tests that go on passing with the rule removed: the cancellation checks of
   `line_follow`, "an earlier approval does not outlive a new follow",
   `log_problem` in `line_follow`, `ts > startTs`, the hub taking the page's
   `unfollowed`, `onlyOwn` ending a session's own follow, the revoke when a
   session ends, the inbox emptied when a follow is dropped.

Fixed although it belongs to this part: a followed chat that is already the open
one is now collected through the same gate as every other reader (it was read
without the check for a list that had not caught up), and in a 1:1 chat that gate
also checks the contact's id on every incoming row. An auto-reply's unit of the
approval comes back only when the text is known not to have gone out - the same
rule as the duplicate guard.

What the rebuild is to rest on (decided 2026-10-02, to be checked against the
measurements):

- Make a wrong `IN` harmless instead of trying to make every `IN` exact. An
  auto-reply names the message it answers; right before typing, the page checks
  that this row is in the open chat, is its newest row, has no outgoing row after
  it, and is not older than a few minutes.
- An `IN` says how old the message is and whether an outgoing one follows it.
- One gate for every reader of the message list.
- Measure first: the `switch` numbers, whether rows fill in late, what
  `document.hasFocus()` does while DevTools has the focus, how long an answer to
  a fetch takes in a hidden window, and whether group chats behave like 1:1.

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
