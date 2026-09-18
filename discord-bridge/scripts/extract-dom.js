// Discord web message extractor.
//
// Paste once into a tab on discord.com (javascript_tool, or the DevTools console).
// It assigns globalThis.DISCORDX, so re-pasting a newer copy replaces the old one
// instead of throwing "already declared".
//
//   DISCORDX.channel()      -> what conversation is on screen
//   DISCORDX.dump()         -> the messages currently rendered, oldest first
//   DISCORDX.scrollUp(n)    -> load older messages (call repeatedly, it is async-free)
//   DISCORDX.watch(fn)      -> stream new messages as they arrive
//   DISCORDX.stop()         -> stop watching
//   DISCORDX.collect()      -> drain what watch() has buffered
//   DISCORDX.summarize(d)   -> a short text digest, cheap to read
//
// Everything returns plain data. Nothing here sends, edits or deletes.

globalThis.DISCORDX = (() => {
  const SEL = {
    list: 'ol[data-list-id="chat-messages"]',
    item: 'li[id^="chat-messages-"]',
    divider: '[class*="divider"][class*="hasContent"]',
    // Class names are hashed CSS modules and change when Discord ships a build,
    // so match on the stable prefix rather than the whole name.
    username: '[class*="username"]',
    replyCtx: '[id^="message-reply-context-"]',
    systemMsg: '[class*="isSystemMessage"]',
    groupStart: '[class*="groupStart"]',
  };

  // The id carries the ids we need: chat-messages-<channelId>-<messageId>.
  const idsOf = (li) => {
    const parts = li.id.split('-');
    return { channelId: parts[2], messageId: parts[3] };
  };

  // A message id is a snowflake: the creation time is the top 42 bits.
  const timeFromId = (id) => {
    try {
      return new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString();
    } catch (e) {
      return null;
    }
  };

  // Emoji render as <img alt=":shrug:">, mentions as spans. innerText keeps the
  // alt text, which is what we want, but it also keeps zero-width characters
  // Discord uses for layout - those break equality checks later.
  // Built from escapes on purpose. Written as literal characters this class is
  // invisible in an editor, and any tool that rewrites the file can mangle it
  // without leaving a visible trace.
  const ZERO_WIDTH = new RegExp("[\u200B-\u200D\uFEFF]", "g");

  const readText = (el) => {
    if (!el) return '';
    return (el.innerText || '')
      .replace(ZERO_WIDTH, '')
      .replace(/[ \t]+$/gm, '')
      .trim();
  };

  // A reply's <li> holds the quoted message inside it, so it contains TWO of
  // everything: two elements whose id starts with "message-content-", and two
  // username elements. In both cases the QUOTED one comes first in document
  // order, so querySelector returns the wrong one and every reply ends up
  // attributed to the person being replied to. Look both up by exact id instead.
  const ownContent = (messageId) => document.getElementById('message-content-' + messageId);

  const ownSender = (messageId) => {
    const header = document.getElementById('message-username-' + messageId);
    return header ? readText(header.querySelector(SEL.username) || header) : null;
  };

  const readReply = (li) => {
    const ctx = li.querySelector(SEL.replyCtx);
    if (!ctx) return null;
    const quoted = ctx.querySelector('[id^="message-content-"]');
    const quotedId = quoted ? quoted.id.replace('message-content-', '') : null;
    return {
      // An exact id, not a text match - the quote can always be tied back to the
      // original even when the same text was sent twice.
      messageId: quotedId,
      sender: readText(ctx.querySelector(SEL.username)) || null,
      text: readText(quoted),
      // True when the original scrolled out of the loaded range; the quote still
      // names it, we just do not have the full message on screen.
      resolved: quotedId ? !!document.getElementById('message-content-' + quotedId) : false,
    };
  };

  const readAttachments = (li, messageId) => {
    const acc = document.getElementById('message-accessories-' + messageId);
    if (!acc) return { embeds: [], files: [] };
    const embeds = [...acc.querySelectorAll('[class*="embed"]')]
      .filter((e) => !e.closest('[class*="embed"] [class*="embed"]'))
      .map((e) => readText(e).split('\n').slice(0, 3).join(' | '))
      .filter(Boolean);
    const files = [...acc.querySelectorAll('a[href*="cdn.discordapp.com"], a[download]')]
      .map((a) => a.getAttribute('href'))
      .filter(Boolean)
      // Attachment URLs carry signed query parameters. They are long, useless to
      // read, and look enough like secrets that scanners redact the whole output.
      .map((u) => u.split('?')[0]);
    const images = acc.querySelectorAll('img').length;
    return { embeds, files, images };
  };

  const readReactions = (li) => {
    return [...li.querySelectorAll('[class*="reaction"][class*="reactionMe"], [class*="reaction_"]')]
      .map((r) => readText(r))
      .filter(Boolean);
  };

  const parse = (li) => {
    const { channelId, messageId } = idsOf(li);
    const inner = li.firstElementChild;
    const cls = inner ? inner.className : '';
    const isSystem = /isSystemMessage|systemMessage/.test(cls);
    const groupStart = /groupStart/.test(cls);

    const timeEl = li.querySelector('[id^="message-timestamp-"]');
    const body = ownContent(messageId);
    const editedEl = body && body.querySelector('[class*="edited"]');
    // "(edited)" is rendered inside the content element, so it lands in the text
    // unless it is taken out first. It is UI chrome, not something anyone typed.
    const bodyText = editedEl
      ? readText(body).replace(readText(editedEl), '').trim()
      : readText(body);

    return {
      messageId,
      channelId,
      // The datetime attribute is exact to the millisecond. Fall back to the
      // snowflake, which system messages need because they carry no <time>.
      ts: (timeEl && timeEl.getAttribute('datetime')) || timeFromId(messageId),
      // Only the first message of a run carries the header. Runs are stitched
      // together in dump(), because a bare "grouped" message has no sender in
      // its own DOM at all.
      sender: groupStart ? ownSender(messageId) : null,
      groupStart,
      system: isSystem,
      text: bodyText,
      edited: !!editedEl,
      replyTo: readReply(li),
      ...readAttachments(li, messageId),
      reactions: readReactions(li),
    };
  };

  const scroller = () => {
    const ol = document.querySelector(SEL.list);
    if (!ol) return null;
    // The <ol> is not the scrolling element - its parent chain holds the one with
    // overflow. Walk up and take the first ancestor that actually scrolls.
    let el = ol.parentElement;
    while (el && el !== document.body) {
      const st = getComputedStyle(el);
      if (/auto|scroll/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 10) return el;
      el = el.parentElement;
    }
    return null;
  };

  const api = {
    SEL,

    channel() {
      const box = document.querySelector('div[role="textbox"][data-slate-editor="true"]');
      const ol = document.querySelector(SEL.list);
      return {
        url: location.href,
        // The composer's label names the destination: "Message #general" /
        // "傳訊息到 #一般". Check it before sending anything - it is the only
        // cheap proof that the conversation on screen is the intended one.
        composerLabel: box ? box.getAttribute('aria-label') : null,
        listLabel: ol ? ol.getAttribute('aria-label') : null,
        title: document.title,
        loaded: document.querySelectorAll(SEL.item).length,
        readOnly: !box,
      };
    },

    // What the sidebar is offering right now, so a name can be turned into a
    // URL without clicking anything.
    //
    // The sidebar shows ONE of two things: direct messages while you are on
    // /channels/@me, or the current server's channels while you are inside a
    // server. So this never returns everything at once - go to @me for people,
    // into a server for its channels.
    //
    // aria-label carries the kind in the user's own language ("(Direct Message)",
    // "(私人訊息)"), which is why the kind is reported as raw text rather than
    // being parsed into an enum.
    targets(query) {
      const q = (query || '').toLowerCase();
      const dms = [...document.querySelectorAll('a[href^="/channels/@me/"]')].map((a) => {
        const label = a.getAttribute('aria-label') || '';
        return {
          type: 'dm',
          name: label.split(' (')[0],
          note: label,
          url: 'https://discord.com' + a.getAttribute('href'),
        };
      });
      const channels = [...document.querySelectorAll('[data-list-item-id^="channels___"]')]
        .map((e) => {
          const id = e.getAttribute('data-list-item-id').replace('channels___', '');
          const label = e.getAttribute('aria-label') || readText(e).split('\n')[0];
          // Entries like "channels___upcoming-events-<guildId>" are sidebar
          // furniture, not channels.
          if (!/^\d+$/.test(id)) return null;
          return { type: 'channel', name: label.split(' (')[0], note: label, channelId: id };
        })
        .filter(Boolean);
      const all = [...dms, ...channels];
      if (!q) return all;
      // Exact matches first: a short name is often a substring of a longer one.
      const exact = all.filter((t) => t.name.toLowerCase() === q);
      return exact.length ? exact : all.filter((t) => t.name.toLowerCase().includes(q));
    },

    dump() {
      const out = [];
      let lastSender = null;
      for (const li of document.querySelectorAll(SEL.item)) {
        const m = parse(li);
        if (m.sender) lastSender = m.sender;
        else if (!m.system) m.sender = lastSender;
        out.push(m);
      }
      return out;
    },

    // Date separators sit ABOVE the group they introduce, matching reading order.
    // dump() ignores them because every message already carries an exact ts.
    dividers() {
      return [...document.querySelectorAll(SEL.divider)].map((d) => readText(d));
    },

    scrollUp(px) {
      const sc = scroller();
      if (!sc) return { ok: false, reason: 'no scroller' };
      const before = { top: sc.scrollTop, h: sc.scrollHeight, n: document.querySelectorAll(SEL.item).length };
      sc.scrollTop = Math.max(0, sc.scrollTop - (px || sc.clientHeight));
      // Loading is async. Call again after a wait and compare n to know whether
      // more arrived; do NOT await inside this page context.
      return { ok: true, before, top: sc.scrollTop };
    },

    toBottom() {
      const sc = scroller();
      if (!sc) return false;
      sc.scrollTop = sc.scrollHeight;
      return true;
    },

    watch(fn) {
      api.stop();
      const ol = document.querySelector(SEL.list);
      if (!ol) return { ok: false, reason: 'no message list' };
      const seen = new Set([...document.querySelectorAll(SEL.item)].map((li) => li.id));
      const buffer = [];
      const obs = new MutationObserver((records) => {
        for (const rec of records) {
          for (const node of rec.addedNodes) {
            if (node.nodeType !== 1) continue;
            const items = node.matches && node.matches(SEL.item) ? [node] : [...(node.querySelectorAll ? node.querySelectorAll(SEL.item) : [])];
            for (const li of items) {
              if (seen.has(li.id)) continue;
              seen.add(li.id);
              const m = parse(li);
              // Keep the element alongside the parsed message so collect() can
              // tell a real message from an echo - see the note on collect().
              buffer.push({ m, li });
              if (fn) { try { fn(m); } catch (e) { /* a throwing callback must not kill the observer */ } }
            }
          }
        }
      });
      obs.observe(ol, { childList: true, subtree: true });
      globalThis.__discordx_obs = obs;
      globalThis.__discordx_buf = buffer;
      return { ok: true, watching: api.channel().composerLabel, baseline: seen.size };
    },

    stop() {
      if (globalThis.__discordx_obs) {
        globalThis.__discordx_obs.disconnect();
        globalThis.__discordx_obs = null;
      }
      return true;
    },

    // When you send a message, Discord paints it immediately with a
    // client-generated id, then swaps in the server's copy under a DIFFERENT id
    // and removes the first one. watch() therefore sees your own message twice,
    // and the callback - being synchronous - cannot know which is which.
    //
    // By the time anyone calls collect(), the swap has happened: the echo has
    // been detached from the document and the real message has not. That makes
    // "is the element still in the page" an exact test, and it drops messages
    // deleted since they arrived for free.
    //
    // This is also why a message being on screen never proves it was sent. To
    // confirm a send, reload the conversation and look for it again.
    collect() {
      const buf = globalThis.__discordx_buf || [];
      const out = buf.filter((e) => document.contains(e.li)).map((e) => e.m);
      buf.length = 0;
      return out;
    },

    // A digest that stays small enough to read directly in a tool result.
    // Prefer this over dump() when you only need the gist of a conversation.
    summarize(msgs) {
      const list = msgs || api.dump();
      return list
        .map((m) => {
          const t = (m.ts || '').slice(11, 16);
          const who = m.system ? '*' : m.sender || '?';
          const q = m.replyTo ? `[re ${m.replyTo.sender || '?'}: ${(m.replyTo.text || '').slice(0, 25)}] ` : '';
          const extra = [
            m.images ? `<${m.images} img>` : '',
            m.embeds && m.embeds.length ? `<embed>` : '',
            m.reactions && m.reactions.length ? `<${m.reactions.length} reactions>` : '',
          ].filter(Boolean).join('');
          // Discord messages can span several lines. Collapse them so the digest
          // keeps one line per message and stays scannable.
          const text = (m.text || '').replace(/\s*\n\s*/g, ' / ');
          return `${t} ${who}: ${q}${text}${extra}`;
        })
        .join('\n');
    },
  };

  return api;
})();
