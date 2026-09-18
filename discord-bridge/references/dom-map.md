# Discord web DOM map

What `scripts/extract-dom.js` relies on, recorded so that when Discord ships a
build that breaks something, it is obvious what to re-check. Verified 2026-09-18.

The rule of thumb: **ids and `data-*` attributes are stable, class names are not.**
Class names are hashed CSS modules (`messageListItem__5126c`) and change between
builds, so they are only ever matched by prefix.

## Contents

- [The message list](#the-message-list)
- [One message](#one-message)
- [Replies](#replies)
- [Attachments and embeds](#attachments-and-embeds)
- [The composer](#the-composer)
- [Sidebars](#sidebars)
- [The message action menu](#the-message-action-menu)

## The message list

| What | Selector |
| --- | --- |
| The list | `ol[data-list-id="chat-messages"]` |
| Its name | that element's `aria-label`, e.g. "Messages in general" |
| One message | `li[id^="chat-messages-"]` |
| Date separator | `[class*="divider"][class*="hasContent"]` |
| The scrolling element | the nearest ancestor of the `<ol>` with `overflow-y` scrollable |

The `li` id is the whole addressing scheme:

```
chat-messages-<channelId>-<messageId>
```

Both ids are snowflakes. The message id encodes its own creation time:
`(BigInt(id) >> 22n) + 1420070400000n` milliseconds.

## One message

Inside the `li`, everything is keyed by the message id:

| What | Selector |
| --- | --- |
| Body | `#message-content-<messageId>` |
| Timestamp | `#message-timestamp-<messageId>` - read its `datetime` (exact to the ms) |
| Sender header | `#message-username-<messageId>`, name in a `[class*="username"]` child |
| Embeds, attachments | `#message-accessories-<messageId>` |

The wrapper `div` (the `li`'s first child) carries the state flags in its class:

| Class fragment | Meaning |
| --- | --- |
| `groupStart` | first message of a run - the only one with a header |
| `isSystemMessage` / `systemMessage` | a join or pin notice; no sender, no `<time>` |
| `edited` (inside the content element) | "(edited)"; strip it from the text |

A message without `groupStart` has a timestamp but **no sender element at all** -
the sender has to be carried forward from the last `groupStart`.

The username span also carries `data-text` with the plain name, which is handy when
the visible text includes a server tag chiplet.

## Replies

A reply's `li` contains the quoted message *inside it*:

```
li#chat-messages-<channel>-<replyId>
  div#message-reply-context-<replyId>
    span[class*=username]                 <- the QUOTED sender
    div#message-content-<quotedId>        <- the QUOTED text, and its id
  div.contents
    h3 > span#message-username-<replyId>  <- the real sender
    div#message-content-<replyId>         <- the real body
```

Two consequences, both of which produce wrong output rather than an error:

- `li.querySelector('[id^="message-content-"]')` returns the **quoted** body.
- `li.querySelector('[class*="username"]')` returns the **quoted** sender.

Look both up by exact id. The upside of this layout is that `<quotedId>` is the
real id of the original message, so a reply links back to its target exactly -
no matching on text, which is what the LINE equivalent was forced into.

If the original has scrolled out of the loaded window, the quote is still there and
still names the id; only `getElementById` for it comes back empty.

## Attachments and embeds

Everything hangs off `#message-accessories-<messageId>`:

- Link previews are `[class*="embed"]` elements. They nest, so filter out embeds
  that are inside another embed.
- Uploaded files are `a[href*="cdn.discordapp.com"]`. Their URLs carry signed
  `?ex=...&is=...&hm=...` parameters - strip the query string. It is noise, it
  expires, and it reads enough like a credential to get output redacted.
- Images are `<img>` elements in the same container.

## The composer

```
div[role="textbox"][data-slate-editor="true"]
```

Its `aria-label` names the destination - "Message #general", "傳訊息到 #一般" -
which is the cheapest available check that the page is showing the conversation you
think it is. Use it before every send.

A channel the user cannot post in has no composer at all.

Slate owns the content: writing to the DOM does not reach its model. See
`gotchas.md`.

## Sidebars

| What | Selector | Useful attribute |
| --- | --- | --- |
| Direct messages | `a[href^="/channels/@me/"]` | `aria-label` = `Name (Direct Message), presence` |
| Channels in the current server | `[data-list-item-id^="channels___<channelId>"]` | `aria-label` = `name (channel type)` |
| Servers | `[data-list-item-id^="guildsnav___<guildId>"]` | - |

Only one of DMs and channels is on screen at a time: DMs on `/channels/@me`,
channels inside a server.

Two things to filter:

- Channel entries whose id is not all digits (`channels___upcoming-events-<guildId>`)
  are sidebar furniture, not channels.
- The server rail contains drop-target pseudo-entries whose `data-dnd-name` reads
  "above X" / "combine with X".

The page `<title>` carries the global unread count as `(3) Discord | ...`.

## The message action menu

Opened from **更多 / More** on the hover toolbar. `[role="menu"]` with
`[role="menuitem"]` children whose **ids are stable across languages**:

| Id | Item |
| --- | --- |
| `message-actions-reply` | Reply |
| `message-actions-edit` | Edit |
| `message-actions-forward` | Forward |
| `message-actions-copy-text` | Copy text |
| `message-actions-pin` | Pin |
| `message-actions-mark-unread` | Mark unread - undoes the read side effect of opening a chat |
| `message-actions-copy-link` | Copy link |
| `message-actions-delete` | Delete - leave this to the user |
| `message-actions-devmode-copy-id-<messageId>` | Copy id |

The hover toolbar itself differs by author: your own messages offer Edit and have
no Reply button, so the menu is the reliable route either way.
