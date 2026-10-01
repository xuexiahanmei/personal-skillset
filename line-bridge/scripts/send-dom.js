// LINE Chrome extension — sending, and the page side of the auto-reply relay
//
// Paste AFTER extract-dom.js: it uses LINEX.collect() to confirm a send landed.
// Everything here acts on the chat currently open in the extension, and refuses
// to type unless the chat header shows the name it was given.
//
//   LINESEND.status()                 -> { header, chat, empty, value }
//   LINESEND.stage(text, name)        -> types text into the box; does NOT send
//   LINESEND.commit(text, name)       -> presses Enter if the box holds exactly text
//   LINESEND.verify()                 -> did a new outgoing bubble with that text appear?
//   LINESEND.clear()                  -> empties the box, only if it holds the staged text
//   LINESEND.send(text, name)         -> stage + commit + verify, async (the relay uses it)
//   LINESEND.chatItem(name)           -> that chat's row in the chat list (id, time, preview, unread)
//   LINESEND.relay.start({ token, name })      -> auto-reply relay on the open chat
//   LINESEND.relay.start({ token, names: [] }) -> ...on several chats (it switches chats)
//   LINESEND.relay.stop() / .status() / .ready()
//
// Results that are not ok say which kind of "not ok" they are:
//   notSent: true      nothing was sent (refused before Enter, or Enter not taken)
//   unconfirmed: true  Enter went out but no bubble was seen - it MAY have been
//                      sent. Read the chat before sending the text again.
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
  let pending = null;   // { text, name, before, committed } from the last stage()

  const refuse = why => ({ ok: false, notSent: true, why });
  const unsure = why => ({ ok: false, unconfirmed: true, why });
  const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  // LINEX trims what it reads, so compare against the trimmed text.
  const countOutgoing = text =>
    LINEX.collect().filter(r => r.direction === 'outgoing' && r.text === text.trim()).length;

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
    pending = { text, name, before: countOutgoing(text), committed: false };
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
    return { ok: true, dispatched: true, handled: ev.defaultPrevented };
  }

  // ok is the bubble alone: the user may start typing the moment it lands.
  function verify() {
    if (!pending || !pending.committed) return { ok: false, why: 'nothing committed' };
    const sent = countOutgoing(pending.text) > pending.before;
    return { ok: sent, sent, boxEmpty: isEmpty(box()), text: pending.text };
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

  async function send(text, name, { chat, settleMs = 300, timeoutMs = 5000 } = {}) {
    let entered = false;   // has the Enter gone out? decides notSent vs unconfirmed
    try {
      const s = stage(text, name, chat);
      if (!s.ok) return s;
      await sleep(settleMs);
      const c = commit(text, name, chat);
      if (!c.ok) {
        // Clear only our own text: the user may have typed during the settle.
        if (holds(box(), text)) setValue('');
        pending = null;
        return c;
      }
      entered = true;
      for (let waited = 0; waited < timeoutMs; waited += 250) {
        await sleep(250);
        if (verify().sent) { pending = null; return { ok: true }; }
      }
      pending = null;
      if (holds(box(), text)) {
        setValue('');
        return refuse('Enter was not taken; the staged text was cleared');
      }
      return unsure('the box emptied but no bubble with this text appeared within ' + timeoutMs +
                    ' ms - read the chat before sending it again');
    } catch (e) {
      pending = null;
      const why = 'exception ' + (entered ? 'after' : 'before') + ' Enter: ' + (e && e.message || e);
      return entered ? unsure(why) : refuse(why);
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
    async function open(t) {
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
      // Let the message list settle: the same row count on two looks.
      for (let n = -1, i = 0; i < 12; i++) {
        const m = rowsNow().length;
        if (m === n) break;
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
    function collectNew(t) {
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
          st.outbox.push({
            chat: t.name, selectId: r.selectId, time: r.displayTime, sender: r.sender, kind: r.kind,
            text: r.text, replyTo: r.replyTo || null,
            sticker: r.sticker ? r.sticker.url : null,
          });
        }
      }
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
        if (new Set(wanted).size !== wanted.length) return { ok: false, why: 'names must be distinct' };
        const items = listItems();
        for (const n of wanted) {
          const hits = items.filter(i => i.name === n);
          if (hits.length > 1) return { ok: false, why: 'more than one chat in the list is named ' + JSON.stringify(n) };
          if (!hits.length) return { ok: false, why: JSON.stringify(n) + ' is not in the visible chat list - pin it to the top' };
          targets.push({ name: n, chat: hits[0].chat });
        }
      }
      stop();
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

    // Also stops a tick that is mid-batch: it sends nothing after the current reply.
    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (cfg) cfg.stopped = true;
      return { stopped: true, ticks: st.ticks };
    }

    function status() {
      return {
        running: !!timer, ready: !!(cfg && cfg.ready), follow: !!(cfg && cfg.follow),
        chats: cfg ? cfg.targets.map(t => ({ name: t.name, chat: t.chat, open: isOpen(t), missing: !!t.missing })) : [],
        header: header(), openChat: chatId(), ticks: st.ticks, waitingToForward: st.outbox.length,
        lastError: st.lastError,
      };
    }

    // Resolves once a start() has finished starting (follow mode visits each chat first).
    const ready = () => Promise.resolve(cfg && cfg.starting).then(status);

    return { start, stop, status, ready, tick };
  })();

  return { status, stage, commit, verify, clear, send, relay, header, chatId, chatItem, SEL };
})();

console.log('LINESEND ready:  stage / commit / verify / send / relay.start');
LINESEND;
