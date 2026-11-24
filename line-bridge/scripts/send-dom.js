// LINE Chrome extension — sending, and the page side of the auto-reply relay
//
// Paste AFTER extract-dom.js: it uses LINEX.collect() to confirm a send landed.
// Everything here acts on the chat currently open in the extension, and refuses
// to type unless the chat header shows the name it was given.
//
//   LINESEND.status()                 -> { header, chat, empty, value }
//   LINESEND.stage(text, name, chat)  -> types text into the box; does NOT send
//   LINESEND.commit(text, name, chat) -> presses Enter if the box holds exactly text
//   LINESEND.verify()                 -> did a new outgoing bubble with that text appear?
//   LINESEND.clear()                  -> empties the box, only if it holds the staged text
//   LINESEND.send(text, name, { chat, beforeCommit })
//                                     -> stage + commit + verify, async (the relay uses it)
// `chat` is the chat id (status().chat); optional, and worth passing: two
// contacts can share a display name.
//   LINESEND.chatItem(name)           -> that chat's row in the chat list (id, time, preview, unread)
//   LINESEND.relay.link({ url, token, build }) -> the page side of the MCP hub (mcp/hub.mjs):
//                                                 read, send, follow on request. line_setup
//                                                 puts this line on the clipboard, filled in.
//   LINESEND.relay.start({ token, name })      -> the older relay (relay.py) on the open chat
//   LINESEND.relay.start({ token, names: [] }) -> ...on several chats (it switches chats)
//   LINESEND.relay.stop() / .status() / .ready()
//
// Results that are not ok say which kind of "not ok" they are:
//   notSent: true      nothing was sent and nothing of it is left in the box
//                      (refused before typing, taken back, or Enter not taken)
//   unconfirmed: true  it MAY have been sent, or may still sit in the box: Enter
//                      went out and no bubble was seen, or someone else touched
//                      the box while the text was in it. Read the chat before
//                      sending the text again.
//
// How sending works (verified live 2026-09-30): the message box is <textarea-ex>,
// a Lit web component with an OPEN shadow root around a real <textarea>. Setting
// that textarea's value through the native setter and dispatching an 'input' event
// updates the component (.value becomes [text], data-is-empty flips to "false").
// A synthetic keydown Enter on the textarea sends: the app calls preventDefault
// and posts the message, and the box empties. There is no send button.

if (globalThis.LINESEND && globalThis.LINESEND.relay) globalThis.LINESEND.relay.stop();

globalThis.LINESEND = (() => {
  const SEL = {
    // The rendered chat; data-mid is the chat's id (the contact's mid in a 1:1
    // chat) and matches the #/chats/<id> route. Header, list and box sit inside.
    room:   '[class*="chatroom-module__chatroom__"]',
    header: '[class*="chatroomHeader-module__header__"]',
    editor: '[class*="chatroomEditor-module__editor_area__"] textarea-ex',
    // One row of the chat list; its data-mid is that chat's id.
    listItem:   '[class*="chatlistItem-module__chatlist_item__"]',
    itemName:   '[class*="chatlistItem-module__text__"] pre',
    itemDesc:   '[class*="chatlistItem-module__description__"]',
    itemUnread: '[class*="chatlistItem-module__message_count__"]',
    itemOpen:   '[class*="chatlistItem-module__button_chatlist_item__"]',
  };
  let pending = null;   // { text, name, chat, before, committed, handled } from the last stage()

  const refuse = why => ({ ok: false, notSent: true, why });
  const unsure = why => ({ ok: false, unconfirmed: true, why });
  const timerSleep = ms => new Promise(r => setTimeout(r, ms));
  // relay.link() swaps this for a wait timed by its server: a hidden page's own
  // timers run about once a minute, an answer to a fetch arrives when it is sent.
  let sleep = timerSleep;

  const room = () => document.querySelector(SEL.room);
  const chatId = () => { const r = room(); return r ? r.getAttribute('data-mid') : null; };

  // The chat name is the first line of the header (innerText; jsdom lacks it).
  function header() {
    const h = (room() || document).querySelector(SEL.header);
    if (!h) return null;
    return (h.innerText || h.textContent || '').split('\n')[0].trim() || null;
  }

  function box() {
    const el = document.querySelector(SEL.editor);
    const ta = el && el.shadowRoot && el.shadowRoot.querySelector('textarea');
    if (!ta) throw new Error('No message box (textarea-ex) - is a chat open?');
    return { el, ta };
  }

  // Both signals: the attribute can lag behind the textarea.
  const isEmpty = ({ el, ta }) => el.getAttribute('data-is-empty') === 'true' && ta.value === '';
  const holds = ({ el }, text) => JSON.stringify(el.value) === JSON.stringify([text]);

  function setValue(text) {
    const { ta } = box();
    ta.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, text);
    ta.dispatchEvent(new window.InputEvent('input', {
      bubbles: true, composed: true,
      inputType: text ? 'insertText' : 'deleteContentBackward', data: text || null,
    }));
  }

  // LINEX trims what it reads, drops zero-width characters (an emoji sequence
  // holds a joiner) and swaps emoji images for their alt text, so a bubble's text
  // is compared after the same clean-up, never byte for byte.
  const norm = s => String(s == null ? '' : s).normalize('NFC')
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  const outgoing = rows => rows.filter(r => r.direction === 'outgoing' && r.selectId);
  // In a 1:1 chat (a U... id) every incoming row carries the contact's mid, which
  // is the chat id (seen live 2026-09-30). An incoming row from anyone else means
  // the list on screen is another chat's, whatever the header says.
  const foreignIn = (rows, chat) => /^U/i.test(chat || '') && rows.some(r => r.direction === 'incoming' && r.senderMid && r.senderMid !== chat);
  // A bubble that turns up after typing only counts as the one just sent when it
  // is not older than what was newest then: an old message with the same text can
  // scroll into view while we wait. The slack is for two clocks (LINE's and this
  // machine's) that need not agree to the second.
  const CLOCK_SLACK_MS = 120000;
  // A go from the relay is for now. Handled this much later - a debugger pause, a
  // frozen tab, the machine asleep - whoever gave it has stopped waiting.
  const GO_FRESH_MS = 5000;

  // Refuses unless the header shows `name` and, when `chat` is given, the open
  // chat is that exact chat id (two contacts can share a display name).
  function checkChat(name, chat) {
    const h = header();
    if (h !== name) return refuse('header is ' + JSON.stringify(h) + ', not ' + JSON.stringify(name));
    if (chat && chatId() !== chat) return refuse('chat id is ' + chatId() + ', not ' + chat);
    return null;
  }

  function status() {
    const b = box();
    return { header: header(), chat: chatId(), empty: isEmpty(b), value: b.el.value };
  }

  function stage(text, name, chat) {
    if (typeof text !== 'string' || !text.trim()) return refuse('empty text');
    if (/[\r\n]/.test(text)) return refuse('multi-line text is untested; send one line per message');
    const bad = checkChat(name, chat);
    if (bad) return bad;
    // Never overwrite something the user is typing.
    if (!isEmpty(box())) return refuse('message box is not empty (the user may be typing)');
    // The outgoing bubbles already there, by id, which chat they are in, and how
    // new the newest message is: verify() looks for a later one in that same chat.
    const rows = LINEX.collect();
    pending = {
      text, name, chat: chatId(), before: new Set(outgoing(rows).map(r => r.selectId)),
      newest: Math.max(0, ...rows.map(r => r.ts || 0)), committed: false, handled: false,
    };
    setValue(text);
    return { ok: true, staged: text, header: header() };
  }

  function commit(text, name, chat) {
    if (!pending || pending.text !== text || pending.name !== name) return refuse('stage() this text for this chat first');
    const bad = checkChat(name, chat);
    if (bad) return bad;
    const b = box();
    if (!holds(b, text)) return refuse('box holds ' + JSON.stringify(b.el.value) + ', not the staged text');
    const ev = new window.KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, composed: true, cancelable: true,
    });
    b.ta.dispatchEvent(ev);
    pending.committed = true;
    // handled === true means the app took the Enter (it calls preventDefault).
    pending.handled = ev.defaultPrevented;
    return { ok: true, dispatched: true, handled: ev.defaultPrevented };
  }

  // ok is the bubble alone: the user may start typing the moment it lands.
  function verify() {
    if (!pending || !pending.committed) return { ok: false, why: 'nothing committed' };
    // Another chat is open now: its bubbles say nothing about the one typed in.
    if (chatId() !== pending.chat) {
      return { ok: false, sent: false, moved: true, text: pending.text, why: 'another chat is open now' };
    }
    const rows = LINEX.collect();
    if (foreignIn(rows, pending.chat)) {
      return { ok: false, sent: false, moved: true, text: pending.text, why: 'the message list shown is another chat\'s' };
    }
    const fresh = outgoing(rows).filter(r =>
      !pending.before.has(r.selectId) && (r.ts || 0) >= pending.newest - CLOCK_SLACK_MS);
    const sent = fresh.some(r => norm(r.text) === norm(pending.text));
    const out = { ok: sent, sent, boxEmpty: isEmpty(box()), text: pending.text };
    // A new bubble that is not this text (typed on the phone, say): the caller judges.
    if (!sent && fresh.length) out.others = fresh.map(r => r.text);
    return out;
  }

  function clear() {
    const b = box();
    if (!pending || !holds(b, pending.text)) {
      return { ok: false, why: 'the box does not hold the staged text; left alone', value: b.el.value };
    }
    setValue('');
    pending = null;
    return Object.assign({ ok: true }, status());
  }

  // beforeCommit: an async function asked right before Enter. Unless it resolves
  // to true or { go: true }, nothing is sent ({ why } becomes the reason). The
  // relay uses it to ask its server whether the reply is still wanted.
  // mayType: asked before typing and again before Enter; a string is the reason
  // not to (link mode: the user is in the LINE window).
  async function send(text, name, { chat, settleMs = 300, timeoutMs = 5000, beforeCommit, goFreshMs = GO_FRESH_MS, mayType } = {}) {
    const prior = document.activeElement;   // typing moves the page's focus into the box: it goes back here
    try {
      return await sendOnce(text, name, { chat, settleMs, timeoutMs, beforeCommit, goFreshMs, mayType });
    } finally {
      focusBack(prior);
    }
  }

  // Put the page's own focus back where it was before typing: a key the user types
  // when they come back to the window must not land in the message box when it
  // was somewhere else (the search field, say).
  function focusBack(prior) {
    try {
      const now = document.activeElement;
      if (prior === now) return;
      if (prior && prior !== document.body && prior.isConnected && typeof prior.focus === 'function') prior.focus({ preventScroll: true });
      else if (now && now !== document.body && typeof now.blur === 'function') now.blur();
    } catch (e) { /* leave it as it is */ }
  }

  async function sendOnce(text, name, { chat, settleMs, timeoutMs, beforeCommit, goFreshMs, mayType }) {
    let typed = false;   // once the text is in the box, an exception no longer means "nothing went out"
    // Look for the bubble until the time is up. On the clock: a hidden page's
    // timers run about once a minute, and a count of sleeps would keep this
    // waiting for twenty.
    const watch = async () => {
      for (const until = Date.now() + timeoutMs; ;) {
        await sleep(250);
        const v = verify();
        if (v.sent || v.moved || Date.now() >= until) return v;
      }
    };
    try {
      const busy = mayType && mayType();
      if (busy) return refuse(busy);
      const s = stage(text, name, chat);
      if (!s.ok) return s;
      typed = true;
      await sleep(settleMs);
      // The text has sat in a box the user can reach. It is ours to send, or to
      // take back, only while a box still holds exactly that text.
      const intact = () => !checkChat(name, chat) && holds(box(), text);
      let stop = (mayType && mayType()) || null;   // why Enter is not to be pressed: the user came into the window
      // Nobody is asked for a go when the box is no longer ours: the answer
      // would be about a text that may already have gone out.
      if (!stop && beforeCommit && intact()) {
        let go = false, why = 'called off before Enter';
        const asked = Date.now();
        try {
          const g = await beforeCommit();
          go = g === true || !!(g && g.go);
          if (g && g.why) why = g.why;
        } catch (e) {
          why = 'no answer before Enter: ' + (e && e.message || e);
        }
        if (go && Date.now() - asked > goFreshMs) {
          go = false;
          why = 'the go came back after ' + Math.round((Date.now() - asked) / 1000) + ' s, too late to act on; not sent';
        }
        if (!go) stop = why;
        else stop = (mayType && mayType()) || null;   // ...or came in while the relay was asked
      }
      const elsewhere = checkChat(name, chat);
      if (!holds(box(), text)) {
        if (elsewhere) {
          pending = null;
          return unsure('another chat was opened while the text was in the message box of ' + JSON.stringify(name) +
                        '; this script did not send it, but it may be left there as a draft - open that chat and look');
        }
        // An Enter that was not ours may have sent it: look for its bubble.
        pending.committed = true;
        const seen = await watch();
        pending = null;
        if (seen.sent) return { ok: true, why: 'sent by an Enter that was not this script\'s, while the text was in the box' };
        return unsure('the message box was changed by someone else while the text was in it, and no bubble with this text was seen' +
                      ' - it may still be in the box, or have gone out; read ' + JSON.stringify(name) + ' before sending it again');
      }
      if (elsewhere || stop) {
        setValue('');   // exactly our text, wherever the window is now: take it back
        pending = null;
        return refuse(elsewhere ? 'another chat was opened while the text was in the box; the text was taken back' : stop);
      }
      const c = commit(text, name, chat);
      if (!c.ok) {
        // Not expected after the checks above; the box decides once more.
        const ours = holds(box(), text);
        if (ours) setValue('');
        pending = null;
        return ours ? c : unsure(c.why);
      }
      const v = await watch();
      pending = null;
      if (v.sent) return { ok: true };
      if (v.moved) {
        return unsure('right after Enter, ' + v.why + ' - read ' + JSON.stringify(name) + ' before sending it again');
      }
      if (holds(box(), text)) {
        // The app called preventDefault, so it may still be sending: leave the
        // text where it is and say so, instead of claiming nothing went out.
        if (c.handled) {
          return unsure('the app took the Enter but the text is still in the box - read the chat before sending it again');
        }
        setValue('');
        return refuse('Enter was not taken; the staged text was cleared');
      }
      return unsure('the box emptied but no bubble with this text appeared within ' + timeoutMs +
                    ' ms - read the chat before sending it again');
    } catch (e) {
      pending = null;
      const why = 'exception ' + (typed ? 'after' : 'before') + ' typing: ' + (e && e.message || e);
      return typed ? unsure(why) : refuse(why);
    }
  }

  // ---- the chat list (the relay uses it to follow several chats) ----
  //
  // Each row of the list is one chat. Only rows scrolled into view exist (the
  // list is virtualised), so chats to follow must be pinned to the top.
  const itemTime = el => {
    const t = el && el.querySelector('time');
    const ms = t ? Date.parse((t.getAttribute('datetime') || '').replace(/\s*\(.*\)\s*$/, '')) : NaN;
    return isNaN(ms) ? 0 : ms;
  };
  const itemText = (el, sel) => { const n = el && el.querySelector(sel); return n ? (n.textContent || '').trim() : ''; };
  // Time, preview and unread badge together: any change means "look inside".
  const itemSnap = el => [itemTime(el), itemText(el, SEL.itemDesc), itemText(el, SEL.itemUnread)].join('|');
  const listItems = () => Array.from(document.querySelectorAll(SEL.listItem)).map(el => ({
    el, chat: el.getAttribute('data-mid'), name: itemText(el, SEL.itemName),
  }));
  const itemOf = chat => (listItems().find(i => i.chat === chat) || {}).el || null;

  function chatItem(name) {
    return listItems().filter(i => i.name === name).map(i => ({
      name: i.name, chat: i.chat, current: i.el.getAttribute('aria-current') === 'true',
      time: itemTime(i.el), preview: itemText(i.el, SEL.itemDesc),
      unread: itemText(i.el, SEL.itemUnread) || null,
    }));
  }

  // ---- auto-reply relay, page side (server: scripts/relay.py) ----
  //
  // start({ token, name })      one chat, the one that is open. The relay never
  //                             switches chats: while another chat is open it waits.
  // start({ token, names: [] }) several chats, found in the chat list by name. The
  //                             relay opens whichever has something new, and the
  //                             chat a reply is for - it drives the window.
  //
  // Every intervalMs: forward each new incoming message of a followed chat to
  // POST /in (tagged with its chat); then fetch GET /out and send each reply in
  // the chat it was queued for, reporting the result to POST /sent.
  const relay = (() => {
    let cfg = null, timer = null;
    const st = { ticks: 0, results: new Map(), inflight: new Set(), outbox: [], busy: false, lastError: null };

    const call = (c, method, path, body) =>
      fetch(c.url + path + '?t=' + encodeURIComponent(c.token), body === undefined
        ? { method }
        : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(r => { if (!r.ok) throw new Error(path + ' HTTP ' + r.status); return r.json(); });

    const isOpen = t => chatId() === t.chat && header() === t.name;
    const rowsNow = () => { try { return LINEX.collect(); } catch (e) { return []; } };

    // Open a followed chat by clicking its row, and wait until it is really there.
    // onHeader: called the moment the header shows the chat, before the list settles.
    async function open(t, onHeader) {
      if (isOpen(t)) return { ok: true };
      // Never pull the window away from something the user is typing.
      let b = null;
      try { b = box(); } catch (e) { /* no chat open: nothing to protect */ }
      if (b && !isEmpty(b)) {
        return refuse('the message box is not empty (the user may be typing); not switching to ' + JSON.stringify(t.name));
      }
      const el = itemOf(t.chat);
      if (!el) return refuse(JSON.stringify(t.name) + ' is not in the visible chat list (scrolled out of view?)');
      const btn = el.querySelector(SEL.itemOpen);
      if (!btn) return refuse('the chat list row has no open button - has the markup changed?');
      btn.click();
      for (const t0 = Date.now(); !isOpen(t);) {
        if (Date.now() - t0 > 4000) return refuse('clicked ' + JSON.stringify(t.name) + ' but the chat did not open');
        await sleep(100);
      }
      if (onHeader) onHeader();
      // Let the message list settle: the same row count on two looks (on the
      // clock, like send(): a hidden page's sleeps can take a minute each).
      for (let n = -1, until = Date.now() + 2000; ;) {
        const m = rowsNow().length;
        if (m === n || Date.now() >= until) break;
        n = m;
        await sleep(150);
      }
      return { ok: true, switched: true };
    }

    // Record what the open chat already holds, so only later messages are forwarded.
    function baseline(t) {
      const rows = rowsNow();
      t.startTs = Math.max(0, ...rows.map(r => r.ts || 0));
      t.seen = new Set(rows.map(r => r.selectId).filter(Boolean));
      t.snap = itemSnap(itemOf(t.chat));
      return rows;
    }

    // Queue the open chat's new incoming messages for the relay.
    function collectNew(t, outbox = st.outbox) {
      // In a 1:1 chat (a U... id) every incoming message is the contact's own, so
      // a row from anyone else means the list is not this chat's yet.
      const oneToOne = /^U/i.test(t.chat);
      for (const r of rowsNow()) {
        if (!r.selectId || t.seen.has(r.selectId)) continue;
        if (oneToOne && r.direction === 'incoming' && r.senderMid && r.senderMid !== t.chat) continue;
        t.seen.add(r.selectId);
        // Newer than everything present at start: history loaded later by
        // scrolling is older, and is never forwarded.
        if (r.direction === 'incoming' && (r.ts || 0) > t.startTs) {
          outbox.push({
            chat: t.name, chatId: t.chat, selectId: r.selectId, ts: r.ts, time: r.displayTime,
            sender: r.sender, kind: r.kind, text: r.text, replyTo: r.replyTo || null,
            sticker: r.sticker ? r.sticker.url : null,
          });
        }
      }
    }

    // Each name must be exactly one row of the visible chat list.
    function byName(names) {
      if (new Set(names).size !== names.length) return { why: 'names must be distinct' };
      const items = listItems(), targets = [];
      for (const n of names) {
        const hits = items.filter(i => i.name === n);
        if (hits.length > 1) return { why: 'more than one chat in the list is named ' + JSON.stringify(n) };
        if (!hits.length) return { why: JSON.stringify(n) + ' is not in the visible chat list - pin it to the top' };
        targets.push({ name: n, chat: hits[0].chat });
      }
      return { targets };
    }

    async function tick() {
      if (st.busy || !cfg || cfg.stopped || !cfg.ready) return;
      const c = cfg;   // start() may swap cfg while this tick is waiting
      st.busy = true;
      st.ticks++;
      try {
        let problem = null;
        for (const t of c.targets) {
          if (c.stopped) break;
          const el = c.follow ? itemOf(t.chat) : null;
          t.missing = c.follow && !el;
          if (!isOpen(t)) {
            // One-chat mode waits for the user to come back. Follow mode goes
            // there when the chat's row in the list has changed.
            if (!c.follow || !el || itemSnap(el) === t.snap) continue;
            const o = await open(t);
            if (!o.ok) { problem = o.why; continue; }   // try again next tick
          }
          collectNew(t);
          if (c.follow) t.snap = itemSnap(itemOf(t.chat));   // after opening, the unread badge is gone
        }
        // Delivered in order; on failure the rest wait for the next tick.
        while (st.outbox.length) { await call(c, 'POST', '/in', st.outbox[0]); st.outbox.shift(); }
        for (const item of await call(c, 'GET', '/out')) {
          if (c.stopped) break;   // stop() mid-batch: send nothing more
          if (st.results.has(item.id)) {
            // Its /sent report was lost: report it again, never send it again.
            await call(c, 'POST', '/sent', st.results.get(item.id));
            continue;
          }
          if (st.inflight.has(item.id)) continue;
          st.inflight.add(item.id);
          const t = c.targets.find(x => x.name === item.chat);
          let res = null;
          if (!t) {
            res = refuse('reply is for ' + JSON.stringify(item.chat) + ', the relay follows ' +
                         JSON.stringify(c.targets.map(x => x.name)));
          } else if (!isOpen(t)) {
            if (!c.follow) {
              res = refuse('the relay is on ' + JSON.stringify(t.name) + ' (' + t.chat + '), but the open chat is ' +
                           JSON.stringify(header()) + ' (' + chatId() + ')');
            } else {
              const o = await open(t);
              if (!o.ok) res = o;
              else collectNew(t);   // what arrived there meanwhile goes out with the next tick
            }
          }
          if (!res) {
            res = await send(item.text, t.name, { chat: t.chat });   // never throws
            // Our own reply changes the chat's row too; note it so the row does
            // not look like news once another chat is open.
            if (c.follow) t.snap = itemSnap(itemOf(t.chat));
          }
          const report = Object.assign({ id: item.id, chat: item.chat, text: item.text }, res);
          st.results.set(item.id, report);
          st.inflight.delete(item.id);
          await call(c, 'POST', '/sent', report);
        }
        st.lastError = problem;
      } catch (e) {
        st.lastError = String(e && e.message || e);
      } finally {
        st.busy = false;
      }
    }

    // Follow mode: visit every chat once, to record what is already there and to
    // catch a chat whose messages never loaded. A chat not opened since the page
    // loaded shows nothing when it is opened while the window is hidden.
    async function visitAll(c) {
      const original = c.targets.find(isOpen) || null;
      for (const t of c.targets) {
        if (c.stopped) throw new Error('stopped while starting');
        const o = await open(t);
        if (!o.ok) throw new Error(o.why);
        const rows = baseline(t);
        if (!rows.some(r => r.selectId) && itemText(itemOf(t.chat), SEL.itemDesc)) {
          throw new Error(JSON.stringify(t.name) + ' shows no messages although its preview is not empty: ' +
                          'open it once by hand with the LINE window visible, then start again');
        }
      }
      if (original) await open(original);   // back to where the user was
    }

    function start({ url = 'http://127.0.0.1:38765', token, name, names, intervalMs = 1500 } = {}) {
      const follow = Array.isArray(names);
      const wanted = follow ? names : (name ? [name] : []);
      if (!token || !wanted.length) {
        return { ok: false, why: 'relay.start needs { token, name } or { token, names: [...] }' };
      }
      const targets = [];
      if (!follow) {
        const bad = checkChat(name);
        if (bad) return { ok: false, why: bad.why };
        if (!chatId()) return { ok: false, why: 'no chat id (chatroom data-mid) - has the markup changed?' };
        targets.push({ name, chat: chatId() });
      } else {
        const found = byName(wanted);
        if (found.why) return { ok: false, why: found.why };
        targets.push(...found.targets);
      }
      stop();
      sleep = timerSleep;   // relay.py has no /wait to time them
      const c = cfg = { url, token, follow, targets, ready: false, stopped: false, starting: null };
      st.results = new Map();
      st.inflight = new Set();
      st.outbox = [];
      st.ticks = 0;
      st.lastError = null;
      const installed = () => call(c, 'POST', '/log', {
        event: 'installed', chats: targets.map(t => ({ name: t.name, chat: t.chat, ignored: t.seen.size })),
      }).catch(e => { st.lastError = String(e && e.message || e); });
      timer = setInterval(tick, intervalMs);   // ticks do nothing until ready
      if (!follow) {
        baseline(targets[0]);
        c.ready = true;
        c.starting = installed();
        return { ok: true, header: name, chat: targets[0].chat, ignored: targets[0].seen.size };
      }
      c.starting = visitAll(c).then(() => { c.ready = true; return installed(); }, e => {
        const why = String(e && e.message || e);
        stop();
        st.lastError = why;
        return call(c, 'POST', '/log', { event: 'start-failed', why }).catch(() => {});
      });
      return { ok: true, starting: wanted };
    }

    // ---- link mode: the page side of the MCP hub (mcp/hub.mjs) ----
    //
    // link({ url, token, build })   ask the hub for work; follow no chat yet.
    //
    // The hub hands over one item at a time: a message to send, or one of four
    // ops (status, read, follow, unfollow). Nothing else can be asked of the
    // page, and nothing that arrives is run as code. Before Enter the page asks
    // the hub once more (POST /commit), so a message whose caller has given up
    // is never sent late.
    //
    // Kept for as long as this paste of the script lives: which ids were handled,
    // and the reports the hub has not taken yet. (A new paste starts empty; the
    // hub never offers an id twice, so that is not what keeps a message single.)
    // The followed chats are the hub's to decide: each answer says which they
    // are, and the page drops whatever the hub does not list - all of them when
    // another hub answers (a new epoch), which never asked for any.
    let link = null;
    const ln = {
      results: new Map(), inflight: new Set(), reports: [], inbox: [],
      follow: { targets: [] }, rounds: 0, lastError: null, followError: null,
    };
    const newId = () => (globalThis.crypto && globalThis.crypto.randomUUID
      ? globalThis.crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

    // The token goes in a header: a URL shows up in the page's resource timings.
    // limitMs: give up after this long. For the question before Enter, where a
    // hub that neither answers nor closes would leave our text in the user's box
    // (on a timer: in a hidden page it can fire up to a minute late).
    const hub = (L, method, path, body, query, limitMs) => {
      const asked = fetch(L.url + path + '?i=' + L.instance + '&l=' + L.linkedAt + '&b=' + encodeURIComponent(L.build) + (query || ''), {
        method,
        headers: Object.assign({ 'x-line-bridge-token': L.token }, body === undefined ? null : { 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(r => {
        if (!r.ok) throw Object.assign(new Error(path + ' HTTP ' + r.status), { status: r.status });
        return r.json();
      });
      if (!limitMs) return asked;
      asked.catch(() => {});   // an answer that comes after the limit is nobody's to handle
      return Promise.race([asked, timerSleep(limitMs).then(() => { throw new Error('no answer from the relay within ' + limitMs + ' ms'); })]);
    };

    const focused = L => { try { return !!L.hasFocus(); } catch (e) { return false; } };
    const here = () => (chatId() ? { name: header(), chat: chatId() } : null);
    // A chat never opened since the page loaded shows no messages when a script
    // opens it in a hidden window: a bubble sent there could not be seen.
    const loaded = t => rowsNow().some(r => r.selectId) || !itemText(itemOf(t.chat), SEL.itemDesc);
    // The messages in the list right now, by id. After a switch the list must
    // stop showing any of the ones that were there before: until then it is
    // still the other chat's, whatever the header says. (Whether LINE's list can
    // lag its header has not been seen; this is so that it could not matter.)
    const idsNow = () => new Set(rowsNow().map(r => r.selectId).filter(Boolean));
    async function caughtUp(before) {
      for (const until = Date.now() + 2000; rowsNow().some(r => r.selectId && before.has(r.selectId));) {
        if (Date.now() >= until) return false;
        await sleep(100);
      }
      return true;
    }
    const LAGGING = name => 'after switching to ' + JSON.stringify(name) + ' the message list still shows the chat that was open before; nothing was read or typed';
    // After a switch whose list did not catch up, nothing in the window is to be
    // trusted: no reading, no typing and no further switch (a second one would
    // only hide the first) until the list has moved on from the rows that were
    // shown before it. Returns the reason while that lasts.
    function lagging(L) {
      if (!L.stale) return null;
      const s = L.stale;
      if (chatId() === s.chat && rowsNow().some(r => r.selectId && s.ids.has(r.selectId)) && !theirOwn(s.chat)) return LAGGING(s.name);
      L.stale = null;   // caught up, positively that chat's list, or the user has moved the window since
      return null;
    }
    // A 1:1 chat whose list is positively its own: it holds incoming rows, and all
    // of them are the contact's. (A group's rows say nothing of the kind.)
    const theirOwn = chat => /^U/i.test(chat) && rowsNow().some(r => r.direction === 'incoming' && r.senderMid === chat) && !foreignIn(rowsNow(), chat);

    // Open a chat for the hub - the one way to a chat's list, also when the chat
    // is the open one. On top of open()'s own checks: not while the user is in
    // the LINE window (their next keystroke would land in the chat we switch
    // to), only a row whose name still goes with the id, and only a chat whose
    // own messages are really there.
    async function openFor(L, t) {
      const lag = lagging(L);
      if (lag) return refuse(lag);
      if (!isOpen(t)) {
        if (focused(L)) {
          return refuse('the LINE window has the keyboard focus (the user is in it); not switching to ' + JSON.stringify(t.name));
        }
        const row = listItems().find(i => i.chat === t.chat);
        if (row && row.name !== t.name) {
          return refuse('the chat ' + t.chat + ' is named ' + JSON.stringify(row.name) + ', not ' + JSON.stringify(t.name));
        }
        const was = chatId(), before = idsNow(), t0 = Date.now();
        // How the switch went, for the caller to report: whether LINE's list can
        // lag its header, or fill in late, is known only from measuring it.
        const sw = { headerMs: null, listMs: null, laggedAtHeader: null, rowsAtHeader: null, rowsSettled: null };
        const o = await open(t, () => {
          sw.headerMs = Date.now() - t0;
          sw.rowsAtHeader = rowsNow().length;
          sw.laggedAtHeader = before.size ? rowsNow().some(r => r.selectId && before.has(r.selectId)) : null;
          if (sw.laggedAtHeader === false) sw.listMs = sw.headerMs;
        });
        // Whichever chat the click left the window on is ours to leave again.
        if (chatId() !== was) L.opened.push(chatId());
        if (!o.ok) return o;
        const caught = await caughtUp(before);
        if (caught && sw.laggedAtHeader) sw.listMs = Date.now() - t0;   // when it was seen gone: an upper bound
        sw.rowsSettled = rowsNow().length;
        L.lastSwitch = sw;
        if (!caught && !theirOwn(t.chat)) {
          L.stale = { chat: t.chat, name: t.name, ids: before };
          return refuse(LAGGING(t.name));
        }
      }
      if (foreignIn(rowsNow(), t.chat)) {
        // The list is another chat's - after a switch the user made by hand while
        // it was behind, say. Treated like a switch that did not catch up.
        L.stale = { chat: t.chat, name: t.name, ids: idsNow() };
        return refuse('the message list under ' + JSON.stringify(t.name) + ' holds messages from someone else: it is another chat\'s, whatever the header says; nothing was read or typed');
      }
      if (!loaded(t)) {
        return Object.assign(refuse(JSON.stringify(t.name) + ' shows no messages although its preview is not empty: ' +
          'open it once by hand with the LINE window visible, then try again'), { notLoaded: true });
      }
      return { ok: true };
    }

    // After a visit to a followed chat: what arrived there is forwarded, and its
    // row is noted, so the visit itself does not look like news.
    function noteVisit(t) {
      const f = ln.follow.targets.find(x => x.chat === t.chat);
      if (!f || !isOpen(f)) return;
      collectNew(f, ln.inbox);
      f.snap = itemSnap(itemOf(f.chat));
    }

    // Should the window go back to the chat the user had open? null: it is
    // there. Only away from a chat this item opened itself - not when the user
    // has moved on, is typing, or is in the window.
    function wayBack(L, from) {
      const now = chatId();
      if (!from || now === from.chat) return null;
      if (!L.opened.includes(now)) return { go: false, why: 'another chat was opened meanwhile' };
      if (lagging(L)) return { go: false, why: 'the message list has not caught up with the last switch' };
      let b = null;
      try { b = box(); } catch (e) { /* no box: nothing typed */ }
      if (b && !isEmpty(b)) return { go: false, why: 'the message box is not empty' };
      if (focused(L)) return { go: false, why: 'the LINE window has the keyboard focus' };
      if (!itemOf(from.chat)) return { go: false, why: JSON.stringify(from.name) + ' is no longer in the visible chat list' };
      return { go: true };
    }

    // Which chat an op means: by id when given, else by name among the rows in
    // view - and never a guess between two chats of the same name.
    function findChat(a) {
      const name = typeof a.chat === 'string' && a.chat ? a.chat : null;
      const id = typeof a.chatId === 'string' && a.chatId ? a.chatId : null;
      const cur = here();
      if (!name && !id) return cur ? { t: cur } : { why: 'no chat is open in the LINE window - name one' };
      const named = (real, where) => 'the chat ' + id + where + ' is named ' + JSON.stringify(real) + ', not ' + JSON.stringify(name);
      if (id) {
        if (cur && cur.chat === id) return !name || cur.name === name ? { t: cur } : { why: named(cur.name, ' (the open one)') };
        const row = listItems().find(i => i.chat === id);
        if (!row) return { why: 'the chat ' + id + ' is not in the visible chat list - pin it to the top, or open it by hand' };
        return !name || row.name === name ? { t: { name: row.name, chat: id } } : { why: named(row.name, '') };
      }
      const hits = listItems().filter(i => i.name === name).map(i => ({ name, chat: i.chat }));
      if (cur && cur.name === name && !hits.some(h => h.chat === cur.chat)) hits.push(cur);
      if (hits.length > 1) {
        return { why: hits.length + ' chats are named ' + JSON.stringify(name) + ' - say which by its chat id', candidates: hits.map(h => h.chat) };
      }
      if (hits.length) return { t: hits[0] };
      return { why: JSON.stringify(name) + ' is not in the visible chat list - pin it to the top, or open it by hand' };
    }

    function opStatus(L) {
      let b = null;
      try { b = box(); } catch (e) { /* no chat open */ }
      // No draft text and no previews: only what is needed to pick a chat.
      return {
        ok: true,
        value: {
          build: L.build, instance: L.instance, header: header(), chat: chatId() || null, boxEmpty: b ? isEmpty(b) : null,
          hidden: document.visibilityState === 'hidden', focused: focused(L),
          follow: ln.follow.targets.map(t => ({ name: t.name, chat: t.chat, open: isOpen(t), missing: !!t.missing })),
          followError: ln.followError, lastError: ln.lastError, unreported: ln.reports.length,
          list: listItems().map(i => ({
            name: i.name, chat: i.chat, current: i.el.getAttribute('aria-current') === 'true',
            time: itemTime(i.el), unread: itemText(i.el, SEL.itemUnread) || null,
          })),
        },
      };
    }

    async function opRead(L, a) {
      const found = findChat(a);
      if (!found.t) return { ok: false, why: found.why, value: found.candidates ? { candidates: found.candidates } : {} };
      const t = found.t;
      const o = await openFor(L, t);
      const sw = L.lastSwitch ? { switch: L.lastSwitch } : null;   // only when this read switched chats
      // Never an empty list for a chat that did not load: it would read as "nothing was said".
      if (!o.ok) return { ok: false, why: o.why, value: Object.assign(o.notLoaded ? { notLoaded: true } : {}, sw) };
      const value = Object.assign({ header: t.name, chat: t.chat }, sw);
      if (a.history === true) {
        // Loading older messages scrolls the chat; a hidden page would take a minute per step.
        if (document.visibilityState === 'hidden') {
          return { ok: false, why: 'older messages can only be loaded while the LINE window is visible (it is hidden or minimised)', value: Object.assign({ hidden: true }, sw) };
        }
        const all = await LINEX.loadAll({ copy: false, deadlineMs: Math.min(Math.max(Number(a.deadlineMs) || 20000, 1000), 40000), sleep });
        // The load takes seconds, in a window the user can see: what it read is
        // this chat's only if this chat is still the one open.
        if (!isOpen(t)) return { ok: false, why: 'another chat was opened while older messages were loading; nothing is returned', value: Object.assign({}, sw) };
        value.messages = all.messages;
        if (all.truncated) value.truncated = true;
      } else {
        value.messages = LINEX.collect();
      }
      noteVisit(t);
      return { ok: true, value };
    }

    async function opFollow(L, a) {
      const names = a.names;
      if (!Array.isArray(names) || !names.length || names.some(n => typeof n !== 'string' || !n)) {
        return { ok: false, why: 'follow needs names: the chats to follow, as they appear in the chat list' };
      }
      const found = byName(names);
      if (found.why) return { ok: false, why: found.why };
      // Visit each once: a chat whose messages never loaded is caught now instead
      // of going quiet later. Nothing takes effect until every chat has passed -
      // a follow that fails half-way leaves what was followed as it was.
      const arrived = [];
      for (const t of found.targets) {
        if (L.stopped) return { ok: false, why: 'stopped while starting' };
        const o = await openFor(L, t);
        if (!o.ok) return { ok: false, why: o.why };
        const rows = rowsNow();
        const prev = ln.follow.targets.find(x => x.chat === t.chat);
        if (prev) {
          // Followed right up to now: go on from where it stands, so a message
          // that came in since the last look is forwarded, not taken as old.
          t.startTs = prev.startTs;
          t.seen = new Set(prev.seen);
          collectNew(t, arrived);
          t.snap = itemSnap(itemOf(t.chat));
        } else {
          // Newly followed (also after a restart or a new paste): what is there
          // now is not forwarded. How much of it still waits for an answer is
          // said instead, for the caller to read and decide.
          baseline(t);
        }
        t.unanswered = unanswered(rows);
      }
      ln.follow = { targets: found.targets };   // the ids handled so far stay as they are
      ln.inbox.push(...arrived);
      ln.followError = null;
      L.toldEmpty = false;
      return {
        ok: true,
        value: { chats: found.targets.map(x => ({ name: x.name, chat: x.chat, ignored: x.seen.size, unanswered: x.unanswered })) },
      };
    }

    // The incoming messages after the last outgoing one.
    function unanswered(rows) {
      let n = 0;
      for (const r of rows) {
        if (r.direction === 'outgoing') n = 0;
        else if (r.direction === 'incoming' && r.selectId) n++;
      }
      return n;
    }

    function dropFollow() {
      ln.follow = { targets: [] };
      ln.inbox = [];
      ln.followError = null;
    }

    function opUnfollow() {
      dropFollow();
      return { ok: true, value: { chats: [] } };
    }

    // A Map, not an object: "constructor" and the like are not ops.
    const OPS = new Map([['status', opStatus], ['read', opRead], ['follow', opFollow], ['unfollow', opUnfollow]]);

    async function runOp(L, item) {
      const answer = r => ({
        report: { path: '/result', body: Object.assign({ id: item.id, ok: !!r.ok, value: r.value || {} }, r.ok ? null : { why: r.why }) },
      });
      const fn = OPS.get(item.op);
      if (!fn) return answer({ ok: false, why: 'unknown op ' + JSON.stringify(item.op) });
      if (item.runBy && Date.now() > item.runBy) return answer({ ok: false, why: 'picked up too late; not run', value: { expired: true } });
      return answer(await fn(L, item.args && typeof item.args === 'object' ? item.args : {}));
    }

    async function runSend(L, item) {
      // stay: a reply leaves the window on the followed chat; only a direct send goes back.
      const answer = res => ({
        report: { path: '/sent', body: Object.assign({ id: item.id, chat: item.chat, chatId: item.chatId, text: item.text }, res) },
        stay: !item.direct,
      });
      if (typeof item.chatId !== 'string' || !item.chatId || typeof item.chat !== 'string' || !item.chat) {
        return answer(refuse('a message needs the chat name and the chat id'));
      }
      const followed = ln.follow.targets.find(x => x.chat === item.chatId && x.name === item.chat);
      // A reply (not direct) only goes to a chat that is followed; a direct send
      // names its chat by id.
      if (!item.direct && !followed) {
        return answer(refuse('reply is for ' + JSON.stringify(item.chat) + ', the relay follows ' +
                             JSON.stringify(ln.follow.targets.map(x => x.name))));
      }
      const t = followed || { name: item.chat, chat: item.chatId };
      let res;
      try {
        res = await openFor(L, t);
        if (res.ok && followed) collectNew(followed, ln.inbox);   // what arrived there meanwhile
      } catch (e) {
        res = refuse('exception before typing: ' + (e && e.message || e));
      }
      if (res.ok) {
        // send() never throws. Nothing is typed while the user is in the LINE
        // window - their next keystroke or Enter would land in our text - and
        // the hub is asked right before Enter.
        res = await send(item.text, t.name, {
          chat: t.chat,
          mayType: () => (focused(L) ? 'the LINE window has the keyboard focus (the user is in it); nothing is typed while they are there' : null),
          beforeCommit: () => hub(L, 'POST', '/commit', { id: item.id }, undefined, L.commitAskMs),
        });
        try { noteVisit(t); } catch (e) { /* the result stands */ }
      }
      return answer(res);
    }

    // Reports wait here until the hub has them; a hub that was away gets them later.
    async function flush(L) {
      while (ln.reports.length) {
        const r = ln.reports[0];
        try {
          await hub(L, 'POST', r.path, r.body);
        } catch (e) {
          // Refused for good (a newer paste owns the log, a body the hub will not
          // take): drop it. A hub that is away, or a refused token: keep it.
          if (!(e.status >= 400 && e.status < 500 && e.status !== 403)) throw e;
        }
        ln.reports.shift();
      }
    }

    async function runItem(L, item) {
      if (!item || typeof item.id !== 'string') return;
      if (ln.results.has(item.id)) {
        // Offered again: say again what happened, never do it again.
        ln.reports.push(ln.results.get(item.id));
        return flush(L);
      }
      if (ln.inflight.has(item.id)) return;
      ln.inflight.add(item.id);
      const op = item.kind === 'op';
      const from = here();   // where the user was
      L.opened = [];         // the chats this item switches to
      L.lastSwitch = null;   // ...and how its last switch went
      let out;
      try {
        out = op ? await runOp(L, item) : await runSend(L, item);
      } catch (e) {
        // Always an answer: an id left in "inflight" would never be reported.
        const why = 'exception: ' + (e && e.message || e);
        out = { report: op ? { path: '/result', body: { id: item.id, ok: false, value: {}, why } }
          : { path: '/sent', body: Object.assign({ id: item.id, chat: item.chat, chatId: item.chatId, text: item.text }, unsure(why)) } };
      } finally {
        ln.inflight.delete(item.id);
      }
      const back = out.stay ? null : wayBack(L, from);
      if (back && !back.go) Object.assign(op ? out.report.body.value : out.report.body, { restored: false, restoreWhy: back.why });
      // A send's report is kept whole, to be given again; an op's answer can be a
      // whole chat, so only the fact that it ran.
      ln.results.set(item.id, op ? { path: '/result', body: { id: item.id, ok: false, value: {}, why: 'this op already ran' } } : out.report);
      if (ln.results.size > 300) ln.results.delete(ln.results.keys().next().value);
      ln.reports.push(out.report);
      // The result first, then the way back: a slow switch must not delay it.
      try { await flush(L); } catch (e) { ln.lastError = String(e && e.message || e); }
      if (back && back.go) {
        // Asked again, right before the click: the report took a moment, and the
        // user may have come back to the window or opened another chat.
        const still = wayBack(L, from);
        let o = still && !still.go ? refuse(still.why) : null;
        if (still && still.go) {
          const before = idsNow();
          try { o = await open(from); } catch (e) { o = refuse(String(e && e.message || e)); }
          // Nothing is read or typed here now; but the next item for this chat
          // must not take a list that has not caught up for this chat's own.
          if (o.ok && !(await caughtUp(before))) L.stale = { chat: from.chat, name: from.name, ids: before };
        }
        if (o && !o.ok) {
          ln.reports.push({ path: '/log', body: { event: 'not-restored', left: (here() || {}).name || null, wanted: from.name, why: o.why } });
        }
      }
    }

    // The hub says which chats are followed; the page never follows more than
    // that. A hub that changed (a new epoch) never asked for any.
    function syncFollow(L, res) {
      const changed = L.epoch !== null && res.epoch !== L.epoch;
      L.epoch = res.epoch;
      const listed = Array.isArray(res.follow) ? res.follow : null;
      if (!ln.follow.targets.length) {
        // The hub lists chats this page does not follow (a follow that an older
        // paste finished, say): tell it once, so it stops saying they are.
        if (listed && listed.length && !L.toldEmpty) {
          L.toldEmpty = true;
          ln.reports.push({ path: '/log', body: { event: 'unfollowed', why: 'this page follows nothing' } });
        }
        return;
      }
      const ids = list => list.slice().sort().join(' ');
      if (!changed && (!listed || ids(listed) === ids(ln.follow.targets.map(t => t.chat)))) return;
      // Nothing is kept for a later follow: one asked again starts from what is
      // there then, and says how much of it is unanswered.
      dropFollow();
      ln.reports.push({
        path: '/log',
        body: { event: 'unfollowed', why: changed ? 'the relay server was restarted' : 'the relay no longer follows these chats' },
      });
    }

    // Forward what came in to the followed chats, opening one whose row changed.
    async function followPass(L) {
      const f = ln.follow;
      let problem = null;
      for (const t of f.targets) {
        if (L.stopped || ln.follow !== f) break;
        const el = itemOf(t.chat);
        t.missing = !el;
        if (!isOpen(t) && (!el || itemSnap(el) === t.snap)) continue;
        // Through openFor also when the chat is the open one: after a switch
        // that did not catch up, its list is not its own yet.
        const o = await openFor(L, t);
        if (!o.ok) { problem = o.why; continue; }   // again next round
        collectNew(t, ln.inbox);
        t.snap = itemSnap(itemOf(t.chat));
      }
      ln.followError = problem;
      while (ln.inbox.length) { await hub(L, 'POST', '/in', ln.inbox[0]); ln.inbox.shift(); }
    }

    // One round: hand over reports, ask for work, do it, then look at the
    // followed chats.
    async function pump() {
      const L = link;
      if (!L || L.stopped || L.busy) return;
      L.busy = true;
      ln.rounds++;
      try {
        await flush(L);
        const res = await hub(L, 'GET', '/poll', undefined, '&wait=' + L.pollMs);
        L.hubOk = true;
        syncFollow(L, res);
        for (const item of res.items || []) {
          if (L.stopped) break;
          await runItem(L, item);
        }
        // Only now, with an answer from the hub just in and its list of followed
        // chats applied: no chat is opened (and marked read) for nobody.
        if (!L.stopped) await followPass(L);
        ln.lastError = null;
      } catch (e) {
        L.hubOk = false;
        ln.lastError = String(e && e.message || e);
        if (e && e.status === 409) unlink(L, 'a newer paste of the script has taken over');
        if (e && e.status === 403) unlink(L, 'the hub refused the token - run line_setup and paste again');
      } finally {
        L.busy = false;
      }
    }

    async function run(L) {
      while (!L.stopped && link === L) {
        const from = Date.now();
        await pump();
        if (L.stopped) break;
        // The hub paces the loop by holding each poll. When it is away, wait on
        // a timer; when it answered at once with nothing to do, do not spin.
        if (!L.hubOk) await timerSleep(1500);
        else if (Date.now() - from < 50) await sleep(200);
      }
    }

    // Stops that link - the one that was told to, which need not be the current
    // one: relay.link() called again leaves an older link to hear its 409.
    function unlink(L, why) {
      if (!L) return;
      L.stopped = true;
      if (why && link === L) ln.lastError = why;
    }

    function linkTo({ url = 'http://127.0.0.1:38766', token, build = '', pollMs = 1500, auto = true, hasFocus, commitAskMs = 5000 } = {}) {
      if (!token) return { ok: false, why: 'relay.link needs { token } - line_setup puts the whole line on the clipboard' };
      stop();   // the older relay, and an earlier link
      const L = link = {
        url, token, build: String(build), pollMs, commitAskMs, instance: newId(), linkedAt: Date.now(), epoch: null,
        hasFocus: hasFocus || (() => document.hasFocus()), opened: [], stale: null, lastSwitch: null, toldEmpty: false,
        hubOk: false, busy: false, stopped: false, starting: null,
      };
      dropFollow();   // a new link follows nothing yet
      ln.lastError = null;
      // With a limit: a hub that neither answers nor closes would otherwise hold
      // a wait - with our text in the user's box - for as long as it hangs.
      sleep = ms => hub(L, 'GET', '/wait', undefined, '&ms=' + ms, ms + 3000).catch(() => timerSleep(ms));
      L.starting = hub(L, 'POST', '/log', { event: 'linked', header: header(), chat: chatId() || null })
        .then(r => { L.epoch = r.epoch; L.hubOk = true; }, e => { ln.lastError = String(e && e.message || e); })
        .then(() => { if (auto) run(L); });
      return { ok: true, linking: true, instance: L.instance };
    }

    // Also stops a tick that is mid-batch: it sends nothing after the current reply.
    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (cfg) cfg.stopped = true;
      unlink(link);
      return { stopped: true, ticks: st.ticks };
    }

    function status() {
      return {
        running: !!timer, ready: !!(cfg && cfg.ready), follow: !!(cfg && cfg.follow),
        chats: cfg ? cfg.targets.map(t => ({ name: t.name, chat: t.chat, open: isOpen(t), missing: !!t.missing })) : [],
        header: header(), openChat: chatId(), ticks: st.ticks, waitingToForward: st.outbox.length,
        lastError: st.lastError,
        link: link ? {
          linked: !link.stopped, instance: link.instance, url: link.url, build: link.build, epoch: link.epoch,
          hubOk: link.hubOk, rounds: ln.rounds, unreported: ln.reports.length, lastError: ln.lastError,
          follow: ln.follow.targets.map(t => ({ name: t.name, chat: t.chat, open: isOpen(t), missing: !!t.missing })),
        } : null,
      };
    }

    // Resolves once a start() or link() has finished starting (follow mode visits each chat first).
    const ready = () => Promise.resolve(cfg && cfg.starting).then(() => link && link.starting).then(status);

    return { start, stop, status, ready, tick, link: linkTo, pump };
  })();

  return { status, stage, commit, verify, clear, send, relay, header, chatId, chatItem, SEL };
})();

console.log('LINESEND ready:  stage / commit / verify / send / relay.link / relay.start');
LINESEND;
