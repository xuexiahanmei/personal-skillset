---
name: discord-bridge
description: "Read and reply to Discord through the user's own logged-in Chrome tab, using the Claude in Chrome tools. Use this whenever Discord comes up at all - reading a DM or a server channel, catching up on what someone said, finding who messaged, drafting or sending a reply, quoting a message, or watching a conversation live. Triggers include English requests like 'reply to X on Discord', 'what did X say in #general', 'check my Discord', 'send this to the team channel', and the Traditional Chinese the user actually types: 幫我回 XXX 的 Discord 訊息, 看一下 discord 上 XXX 說了什麼, discord 有人敲我嗎, 幫我在 #頻道 發 XXX, 看一下伺服器的訊息. Also use it for anything about Discord's DOM, message ids, reply quotes, or automating Discord in the browser."
---

# Discord bridge

Discord runs as an ordinary web page, so everything here goes through the Claude in
Chrome tools on the user's own logged-in tab. There is no separate API key, no bot,
and nothing to install.

Two things do the work:

- **`javascript_tool`** runs JavaScript in the page. Reading is done entirely this
  way - it is exact and costs almost nothing compared with screenshots.
- **`computer`** does real typing and clicking, which is the only way to put text
  into the composer (see [Sending](#sending)).

## Do not use a user token

Driving the UI the user is already signed into is one thing. Taking their account
token and calling Discord's HTTP API with it is self-botting, which is against
Discord's terms and gets accounts disabled. If the user wants unattended
automation, the honest answer is a real bot application and a bot token, not this
skill. Never read the token out of local storage.

## Getting set up

```
tabs_context_mcp                     # never reuse a tab id from an earlier session
tabs_create_mcp                      # unless the user asked to work in a tab they have open
navigate -> https://discord.com/channels/@me
```

Then paste `scripts/extract-dom.js` once with `javascript_tool`. It assigns
`globalThis.DISCORDX`, so pasting a newer copy over an older one is fine.

A tab keeps it until it navigates or reloads - and Discord's own in-app navigation
does not reload, so one paste usually lasts the whole session. After any `navigate`
call, paste it again.

## Where things are

Every conversation is addressable by URL, so navigation needs no clicking:

| Target | URL |
| --- | --- |
| Home / friends | `https://discord.com/channels/@me` |
| A direct message | `https://discord.com/channels/@me/<dmId>` |
| A server channel | `https://discord.com/channels/<guildId>/<channelId>` |

To turn a name into one of those, use `DISCORDX.targets('name')`. The sidebar shows
either DMs or the current server's channels, never both - so go to `@me` to find a
person, and into the server to find a channel.

```js
DISCORDX.targets('Alex')     // -> [{type:'dm', name, url}, ...]
DISCORDX.channel()           // what is actually on screen right now
```

**Opening a conversation marks it read.** Say so before opening something whose
unread badge the user may be using as a to-do list. It can be put back afterwards:
the message action menu has `message-actions-mark-unread`.

## Reading

```js
DISCORDX.summarize()   // one line per message - read this first
DISCORDX.dump()        // full structured messages, when details matter
```

Each message comes back as:

```
messageId, channelId, ts, sender, text, groupStart, system, edited,
replyTo: { messageId, sender, text, resolved } | null,
embeds[], files[], images, reactions[]
```

`ts` is exact to the millisecond. `replyTo.messageId` is the **actual id** of the
quoted message, so a reply can be tied back to its original with certainty - no
text matching, even when the same sentence was sent twice.

Only about 50 messages are rendered at a time. For more history, call
`DISCORDX.scrollUp()`, wait, then dump again - loading is asynchronous, and
`javascript_tool` hangs if you `await` a timer inside it (see `references/gotchas.md`).

To follow a conversation live, `DISCORDX.watch()` then `DISCORDX.collect()` each
time you want what has arrived since. Do not poll in a tight loop; collect when the
user asks or when something else wakes you.

## Sending

Sending is the part that can embarrass the user, so it is deliberately slow.

**Get the exact text approved first.** Show the user what you intend to send,
verbatim, and wait for a clear yes. Approval for one message is not approval for
the next one.

Then:

1. **Check you are in the right conversation.** `DISCORDX.channel().composerLabel`
   reads "Message #general" / "傳訊息到 #一般". This is the cheap proof that
   the page is where you think it is - it has caught a wrong target before.
2. **Click the composer**, by coordinate. It is a Slate editor: assigning
   `textContent` does nothing useful because Slate keeps its own model, and a
   click by element reference has silently failed to focus it.
3. **Type** with `computer`'s `type` action.
4. **Read the composer back** before pressing anything. Typing into a composer that
   never got focus looks exactly like typing into one that did.
5. **Press Return.**
6. **Verify by reloading.** Navigate to the conversation again and look for the
   message. Nothing short of this proves a send: Discord paints your message
   immediately under a client-generated id, then swaps in the server's copy. A
   message that never reached the server looks identical until the tab is
   refreshed - and two messages have been lost that way.

Never report a message as sent without step 6.

### Replying to a specific message

Reply is not on the hover toolbar for your own messages, and the toolbar differs
by author, so go through the menu, which has stable ids in every language:

1. Hover the message - convert its rect with the scale factor in
   `references/gotchas.md`, coordinates from JavaScript are not in the same frame
   as the `computer` tool.
2. Click **更多 / More** on the hover toolbar.
3. Click the item whose id is `message-actions-reply`.
4. Confirm the reply bar appeared above the composer, then type and send as above.

Useful ids in the same menu: `message-actions-edit`, `message-actions-copy-link`,
`message-actions-mark-unread`, `message-actions-delete`.

**Deleting is the user's job.** Point at the message and let them do it.

## What it costs

Reading through the DOM is roughly two orders of magnitude cheaper than looking:

| Approach | Rough cost for one screen of chat |
| --- | --- |
| `DISCORDX.summarize()` | ~300 tokens, exact text |
| `DISCORDX.dump()` | ~2k tokens, everything structured |
| A screenshot | ~1.5k tokens each, and you still cannot read ids or timestamps |
| Pasting raw HTML | 100k+ tokens - never do this |

Pasting the extractor costs about 3k tokens once per tab. It pays for itself on the
second read.

Use screenshots for what they are good at: confirming a menu opened, or working out
where something is on screen. Use JavaScript for anything about content.

## Traps worth knowing before you start

These have all bitten for real; `references/gotchas.md` has the full set and the
evidence.

- **A message on screen is not a message that was sent.** Reload to confirm.
- **A reply's `<li>` contains the quoted message too**, so `querySelector` for the
  content or the username returns the *quoted* one. Look them up by exact id.
- **Never name a returned field `author`.** The harness's secret scanner redacts any
  JSON key containing "author" - the field silently becomes `[BLOCKED]`. Use
  `sender`.
- **Do not `await` a timer inside `javascript_tool`.** It hangs the call for 45
  seconds and leaves the tab unresponsive. Use a separate `wait` action.
- **Coordinates from JavaScript need scaling** before the `computer` tool will
  accept them.
- **If screenshots start failing on a tab, the tab is dying.** Open a fresh one
  rather than trusting what it reports.

## Files

| Path | What it is |
| --- | --- |
| `scripts/extract-dom.js` | The reader. Paste into the page; defines `DISCORDX`. |
| `references/gotchas.md` | Every verified trap, with what proved it. |
| `references/dom-map.md` | The selectors and DOM shapes this relies on. |
| `tests/` | `npm install && npm test` - 57 checks against a fixture DOM. |

The tests are the early-warning system for Discord shipping a new build: run them
after any change to the extractor, and when something that used to work stops
working, check whether the fixture still matches the real page.
