// LINE Chrome extension — message extractor
//
// Pulls every rendered message out of the DOM as structured JSON, including the
// reply quotes that BOTH the Windows "Save chat" export and the phone export drop.
//
// How to run:
//   1. Open the LINE extension window and the chat you want
//   2. Right-click the message area -> Inspect  (or F12) -> Console tab
//   3. Paste this whole file, press Enter
//   4. LINEX.dump()          -> extract what is currently rendered, copies JSON
//      LINEX.loadAll()       -> scroll up until history stops growing, then dump
//                               ({ copy: false } when driven through the bridge)
//      LINEX.watch()         -> stream new messages live as they arrive
//      LINEX.stop()          -> stop watching
//
// Read-only: it never clicks, sends, or edits anything. loadAll() scrolls.
//
// Selector strategy: the class names carry CSS-module hashes that change when the
// extension updates, so anchor on the stable data-* attributes wherever possible
// and use class *prefix* matching (class*=) for the rest.

globalThis.LINEX = (() => {
  const SEL = {
    list:      '.message_list',
    message:   '[data-message-select-id][data-timestamp]',
    dateSep:   '[class*="messageDate-module__date_wrap__"]',
    sysMsg:    '[class*="systemMessage-module__message__"]',
    bodyText:  '[class*="textMessageContent-module__text__"]',
    replyWrap: '[class*="replyMessageContent-module__content_wrap__"]',
    replyUser: '[class*="username-module__username__"]',
    replyText: '[class*="replyMessageContent-module__text__"]',
    replyBody: '[class*="replyMessageContent-module__reply_content__"]',
    replyThumb:'[class*="profileImage-module__thumbnail_wrap__"][data-mid]',
    sticker:   '[class*="stickerMessageContent-module__content_wrap__"] img',
    image:     '[class*="imageMessageContent-module__content_wrap__"]',
    linkbox:   '[class*="linkbox-module__link_box__"]',
    linkTitle: '[class*="linkbox-module__title__"]',
    linkDesc:  '[class*="linkbox-module__description__"]',
    readMark:  '[class*="metaInfo-module__read_count__"]',
    sendTime:  '[class*="metaInfo-module__send_time__"]',
    // Not "reactionPopover-module__…": that is the add-a-reaction button every
    // message carries, and it matches a looser [class*="reaction"].
    reactList: '[class*="reactionBubblelist-module__reaction_bubble_list__"]',
    reactBubble: '[class*="reactionBubble-module__reaction_bubble__"]',
  };

  // textContent drops emoji, which LINE renders as <img class="emoji" alt="😀">.
  // Swap those back in, and strip the zero-width joiners used as layout spacers.
  function readText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('img.emoji, img[class*="emoji"]').forEach(img => {
      img.replaceWith(document.createTextNode(img.getAttribute('alt') || ''));
    });
    return clone.textContent.replace(/[​‌‍﻿]/g, '').trim();
  }

  // Derive the calendar date from the message's own timestamp rather than from the
  // date separators in the list. LINE renders newest-first with each separator
  // BELOW the group it labels, so walking the list top-down and carrying the last
  // separator forward tags every message with the next day's date.
  function localDate(ts) {
    if (!ts) return null;
    const d = new Date(ts), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // "11:02 王小明 " -> "王小明". The prefix is always HH:MM + space, and a display
  // name may itself contain spaces, so slice past the fixed-width time instead of
  // splitting on whitespace.
  function senderFromPrefix(prefix) {
    if (!prefix) return null;
    return prefix.length > 6 ? prefix.slice(6).trim() : prefix.trim();
  }

  // Reactions sit in a bubble list under the message: one <button> per reaction,
  // holding the sticon as an <img>. The markup says nothing about WHO reacted or
  // WHEN. Only single reactions in a 1:1 chat have been seen, so any text on a
  // bubble (a count, a "+N" overflow) is kept verbatim rather than interpreted.
  function readReactions(el) {
    const list = el.querySelector(SEL.reactList);
    if (!list) return [];
    return Array.from(list.querySelectorAll(SEL.reactBubble)).map(b => {
      const img = b.querySelector('img');
      const url = img ? img.getAttribute('src') : null;
      // .../sticonshop/v1/sticon/<productId>/android/<sticonId>_animation.png
      const m = url && url.match(/\/sticon\/([^/]+)\/[^/]+\/(\d+)[_.]/);
      const r = { url, productId: m ? m[1] : null, sticonId: m ? m[2] : null };
      const text = readText(b);
      if (text) r.text = text;
      return r;
    });
  }

  function classifyAndExtract(el, out) {
    const declared = el.getAttribute('data-message-content');

    // Check for a reply FIRST. A reply whose body is a sticker also carries
    // data-message-content="貼圖" on the wrapper, so keying off that attribute
    // before looking for the quote silently drops the reply link.
    const replyWrap = el.querySelector(SEL.replyWrap);
    if (replyWrap) {
      const quoteRoot = replyWrap.querySelector('button') || replyWrap;
      const quotedName = readText(quoteRoot.querySelector(SEL.replyUser));
      const quotedText = readText(quoteRoot.querySelector(SEL.replyText));
      const quotedThumb = quoteRoot.querySelector(SEL.replyThumb);
      out.replyTo = {
        sender: quotedName || null,
        senderMid: quotedThumb ? quotedThumb.getAttribute('data-mid') : null,
        text: quotedText || null,
        // A reply to a sticker quotes the sticker, not text.
        kind: quotedText ? 'text' : (quoteRoot.querySelector(SEL.sticker) ? 'sticker' : 'unknown'),
      };
      const bodyRoot = replyWrap.querySelector(SEL.replyBody);
      if (bodyRoot) {
        const t = readText(bodyRoot.querySelector(SEL.bodyText));
        if (t) {
          out.kind = /^\d{1,2}:\d{2}$/.test(t) ? 'call' : 'text';
          out.text = t;
          if (out.kind === 'call') out.duration = t;
          return;
        }
        const img = bodyRoot.querySelector(SEL.sticker);
        if (img) {
          out.kind = 'sticker';
          out.sticker = {
            url: img.getAttribute('src') || null,
            productId: img.getAttribute('data-product-id') || null,
            owned: img.getAttribute('data-is-owned') === 'true',
          };
          return;
        }
        if (bodyRoot.querySelector(SEL.image)) {
          out.kind = 'image';
          return;
        }
      }
    }

    // Non-reply payloads announce their type on the wrapper.
    if (declared === '貼圖' || declared === 'Sticker') {
      out.kind = 'sticker';
      const img = el.querySelector(SEL.sticker);
      if (img) {
        out.sticker = {
          url: img.getAttribute('src') || null,
          productId: img.getAttribute('data-product-id') || null,
          owned: img.getAttribute('data-is-owned') === 'true',
        };
      }
      return;
    }
    if (declared === '圖片' || declared === 'Photo') {
      out.kind = 'image';
      out.imageCount = el.querySelectorAll(SEL.image + ' [data-message-id]').length || 1;
      return;
    }

    // Plain text (possibly with a link preview attached).
    const textEl = el.querySelector(SEL.bodyText);
    if (textEl) {
      out.kind = 'text';
      out.text = readText(textEl);
      const links = Array.from(el.querySelectorAll('a[href]'))
        .map(a => a.getAttribute('href'))
        .filter(h => h && /^https?:/i.test(h));
      if (links.length) out.urls = Array.from(new Set(links));
      const box = el.querySelector(SEL.linkbox);
      if (box) {
        out.preview = {
          title: readText(box.querySelector(SEL.linkTitle)) || null,
          description: readText(box.querySelector(SEL.linkDesc)) || null,
        };
      }
      // A bare MM:SS body is a call-duration bubble.
      if (/^\d{1,2}:\d{2}$/.test(out.text)) { out.kind = 'call'; out.duration = out.text; }
      return;
    }

    out.kind = 'unknown';
  }

  function parseMessage(el) {
    const selectId = el.getAttribute('data-message-select-id') || '';
    const prefix = el.getAttribute('data-message-content-prefix');
    const timeEl = el.querySelector(SEL.sendTime);
    const readEl = el.querySelector(SEL.readMark);

    const out = {
      id: selectId.split('-')[1] || null,
      selectId,
      ts: Number(el.getAttribute('data-timestamp')) || null,
      datetime: timeEl ? timeEl.getAttribute('datetime') : null,
      displayTime: timeEl ? readText(timeEl) : null,
      sender: senderFromPrefix(prefix),
      senderMid: el.getAttribute('data-mid') || null,
      direction: el.getAttribute('data-direction') === 'reverse' ? 'outgoing' : 'incoming',
      e2ee: el.getAttribute('data-is-e2ee-message') === 'true',
      read: readEl ? readText(readEl).length > 0 : false,
      kind: null,
      text: null,
    };
    out.date = localDate(out.ts);
    classifyAndExtract(el, out);
    const reactions = readReactions(el);
    if (reactions.length) out.reactions = reactions;
    return out;
  }

  function collect() {
    const list = document.querySelector(SEL.list);
    if (!list) throw new Error('No .message_list found — is a chat open?');
    const rows = [];

    for (const node of Array.from(list.children)) {
      // Date separators carry no message of their own; each message derives its
      // date from its own timestamp instead.
      if (node.matches && node.matches(SEL.dateSep)) continue;
      if (node.matches && node.matches(SEL.sysMsg)) {
        const ts = Number(node.getAttribute('data-timestamp')) || null;
        rows.push({ kind: 'system', text: readText(node), ts, date: localDate(ts) });
        continue;
      }
      if (node.matches && node.matches(SEL.message)) {
        rows.push(parseMessage(node));
        continue;
      }
    }
    // The list renders newest-last in some views and newest-first in others; sort
    // by timestamp so downstream code never has to care.
    rows.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return rows;
  }

  function summarize(rows) {
    const byKind = {}, bySender = {};
    let replies = 0, reacted = 0;
    for (const r of rows) {
      byKind[r.kind] = (byKind[r.kind] || 0) + 1;
      if (r.sender) bySender[r.sender] = (bySender[r.sender] || 0) + 1;
      if (r.replyTo) replies++;
      if (r.reactions) reacted++;
    }
    const dated = rows.filter(r => r.datetime);
    return {
      messages: rows.length,
      replies,
      reacted,
      byKind,
      bySender,
      first: dated.length ? dated[0].datetime : null,
      last: dated.length ? dated[dated.length - 1].datetime : null,
    };
  }

  function dump(opts = {}) {
    const rows = collect();
    const payload = { summary: summarize(rows), messages: rows };
    const json = JSON.stringify(payload, null, opts.pretty === false ? 0 : 2);
    console.log(payload.summary);
    if (opts.log !== false) console.log(json);
    try { copy(json); console.log('--- copied to clipboard (' + json.length + ' chars) ---'); } catch (e) {}
    return payload;
  }

  // Scroll the message pane up until it stops producing older messages.
  // copy: false skips the clipboard: driven through the DevTools bridge, a late
  // copy() would land on the clipboard mid-call and read as another call's answer.
  async function loadAll({ maxRounds = 200, pause = 350, copy: toClipboard = true } = {}) {
    const list = document.querySelector(SEL.list);
    const pane = list.closest('[class*="scroll"]') || list.parentElement;
    let last = -1, stable = 0;
    for (let i = 0; i < maxRounds; i++) {
      const n = list.querySelectorAll(SEL.message).length;
      if (n === last) { if (++stable >= 3) break; } else { stable = 0; }
      last = n;
      pane.scrollTop = 0;
      await new Promise(r => setTimeout(r, pause));
      if (i % 10 === 0) console.log('loading… messages so far:', n);
    }
    console.log('finished loading, messages:', list.querySelectorAll(SEL.message).length);
    if (toClipboard) return dump({ log: false });
    const rows = collect();
    return { summary: summarize(rows), messages: rows };
  }

  let observer = null;
  function watch(onMessage) {
    const list = document.querySelector(SEL.list);
    if (!list) throw new Error('No .message_list found.');
    const seen = new Set(collect().map(r => r.selectId));
    observer = new MutationObserver(() => {
      for (const r of collect()) {
        if (r.selectId && !seen.has(r.selectId)) {
          seen.add(r.selectId);
          (onMessage || (m => console.log('[new]', m.sender + ':', m.text || m.kind, m.replyTo ? '(reply to: ' + m.replyTo.text + ')' : '')))(r);
        }
      }
    });
    observer.observe(list, { childList: true, subtree: true });
    console.log('watching for new messages… LINEX.stop() to end');
  }
  function stop() { if (observer) { observer.disconnect(); observer = null; console.log('stopped'); } }

  return { dump, loadAll, watch, stop, collect, summarize, SEL };
})();

console.log('LINEX ready:  LINEX.dump()  LINEX.loadAll()  LINEX.watch()  LINEX.stop()');
LINEX;
