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
//   LINESEND.relay.start({ token, name, url? }) / .stop() / .status()
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

  // ---- auto-reply relay, page side (server: scripts/relay.py) ----
  //
  // Every intervalMs, while the open chat is the one pinned at start (header AND
  // chat id): forward each new incoming message to POST /in; then fetch GET /out
  // and send each reply meant for this chat, reporting the result to POST /sent.
  const relay = (() => {
    let cfg = null, timer = null;
    const st = {
      ticks: 0, startTs: 0, seen: new Set(), results: new Map(), inflight: new Set(),
      outbox: [], busy: false, lastError: null,
    };

    const call = (c, method, path, body) =>
      fetch(c.url + path + '?t=' + encodeURIComponent(c.token), body === undefined
        ? { method }
        : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(r => { if (!r.ok) throw new Error(path + ' HTTP ' + r.status); return r.json(); });

    async function tick() {
      if (st.busy || !cfg || cfg.stopped) return;
      const c = cfg;   // start() may swap cfg while this tick is waiting
      st.busy = true;
      st.ticks++;
      try {
        if (header() === c.name && chatId() === c.chat) {
          // In a 1:1 chat (a U... id) every incoming message is the contact's
          // own, so a row from anyone else means the list is not this chat's yet.
          const oneToOne = /^U/i.test(c.chat);
          for (const r of LINEX.collect()) {
            if (!r.selectId || st.seen.has(r.selectId)) continue;
            if (oneToOne && r.direction === 'incoming' && r.senderMid && r.senderMid !== c.chat) continue;
            st.seen.add(r.selectId);
            // Newer than everything present at start: history loaded later by
            // scrolling is older, and is never forwarded.
            if (r.direction === 'incoming' && (r.ts || 0) > st.startTs) {
              st.outbox.push({
                selectId: r.selectId, time: r.displayTime, sender: r.sender, kind: r.kind,
                text: r.text, replyTo: r.replyTo || null,
                sticker: r.sticker ? r.sticker.url : null,
              });
            }
          }
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
          let res;
          if (item.chat !== c.name) {
            res = refuse('reply is for ' + JSON.stringify(item.chat) + ', the relay is on ' + JSON.stringify(c.name));
          } else {
            res = await send(item.text, c.name, { chat: c.chat });   // never throws
          }
          const report = Object.assign({ id: item.id, chat: item.chat, text: item.text }, res);
          st.results.set(item.id, report);
          st.inflight.delete(item.id);
          await call(c, 'POST', '/sent', report);
        }
        st.lastError = null;
      } catch (e) {
        st.lastError = String(e && e.message || e);
      } finally {
        st.busy = false;
      }
    }

    function start({ url = 'http://127.0.0.1:38765', token, name, intervalMs = 1500 } = {}) {
      if (!token || !name) return { ok: false, why: 'relay.start needs { token, name }' };
      const bad = checkChat(name);
      if (bad) return { ok: false, why: bad.why };
      const chat = chatId();
      if (!chat) return { ok: false, why: 'no chat id (chatroom data-mid) - has the markup changed?' };
      stop();
      cfg = { url, token, name, chat };
      const rows = LINEX.collect();
      st.startTs = Math.max(0, ...rows.map(r => r.ts || 0));
      st.seen = new Set(rows.map(r => r.selectId).filter(Boolean));
      st.results = new Map();
      st.inflight = new Set();
      st.outbox = [];
      st.ticks = 0;
      st.lastError = null;
      timer = setInterval(tick, intervalMs);
      call(cfg, 'POST', '/log', { event: 'installed', header: name, chat, ignored: st.seen.size })
        .catch(e => { st.lastError = String(e && e.message || e); });
      return { ok: true, header: name, chat, ignored: st.seen.size };
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
        running: !!timer, name: cfg && cfg.name, chat: cfg && cfg.chat, header: header(),
        openChat: chatId(), ticks: st.ticks, waitingToForward: st.outbox.length,
        lastError: st.lastError,
      };
    }

    return { start, stop, status, tick };
  })();

  return { status, stage, commit, verify, clear, send, relay, header, chatId, SEL };
})();

console.log('LINESEND ready:  stage / commit / verify / send / relay.start');
LINESEND;
