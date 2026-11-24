// A stand-in for the LINE extension page, shared by send.js and hub-page.test.js.
//
// The mock reproduces only what send-dom.js relies on, as observed live on
// 2026-09-30 / 10-01:
//   - a chat list whose rows carry data-mid, the name, a <time datetime> of the
//     last message (to the second), a preview, an unread badge, and a button that
//     opens the chat;
//   - one chatroom element whose data-mid is the open chat's id, holding the
//     header, the message list and the editor area;
//   - <textarea-ex> (a Lit component in LINE): an open shadow root around a
//     <textarea>, .value as [text] or [], a data-is-empty attribute, and a keydown
//     Enter on the textarea that sends the text and empties the box;
//   - a chat that was never opened since the page loaded shows no messages when a
//     script opens it (the page is hidden), until the user opens it once.
// It proves the guards and the flow - not that LINE still behaves this way, which
// takes a live send.
//
// One page per process: it installs window / document / MutationObserver as
// globals, the way the pasted scripts expect to find them.
const { JSDOM } = require('jsdom');

module.exports = function mockLine() {
  const dom = new JSDOM(`<!doctype html><body>
  <div id="chatlist"></div>
  <div class="chatroom-module__chatroom__eVUaK" data-mid="">
    <div class="chatroomHeader-module__header__ihDT2"><span></span></div>
    <div class="message_list" role="log"></div>
    <div class="chatroomEditor-module__editor_area__1UsgR"><textarea-ex data-is-empty="true"></textarea-ex></div>
  </div>
</body>`);
  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.MutationObserver = window.MutationObserver;

  // ---- the mock app ----
  const listEl = document.querySelector('#chatlist');
  const roomEl = document.querySelector('[class*="chatroom-module__chatroom__"]');
  const msgList = document.querySelector('.message_list');
  const chats = new Map();   // chat id -> { name, messages, loaded, unread, inList }
  let openMid = null, seq = 0, clock = 1790000000000;

  function addChat(mid, name, opts) {
    chats.set(mid, Object.assign({ name, messages: [], loaded: true, unread: 0, inList: true }, opts));
  }

  function addMessage(direction, text, { chat = openMid, ts, mid, old = false } = {}) {
    seq++;
    // Time moves forward: a message stamped ahead of the clock takes the clock
    // with it. `old: true` is the exception - a bubble from the past, such as
    // one that scrolls into view.
    if (!ts) ts = (clock += 1000);
    else if (!old) clock = Math.max(clock, ts);
    const c = chats.get(chat);
    c.messages.push({
      direction, text, ts, mid: mid || (direction === 'outgoing' ? 'UexampleSelf' : chat),
      selectId: `0${ts}-90000000000000${String(seq).padStart(4, '0')}`,
    });
    if (direction === 'incoming' && chat !== openMid) c.unread++;
    render();
  }

  // lag: for this long after a switch the message list goes on showing the chat
  // that was open before, under the new chat's header. Not seen in LINE; here so
  // that the page script's wait for the list to catch up can be tested.
  let lag = 0, lagFrom = null, lagUntil = 0;
  // freeze: the message list goes on showing the chat it shows now (and what
  // arrives there), whatever is opened, until unfrozen. Not seen in LINE either.
  let frozen = null;
  const listedNow = () => (lagFrom && Date.now() < lagUntil ? chats.get(lagFrom) : chats.get(openMid));

  // byUser: a real click with the window visible, which is what loads a chat.
  function openChat(mid, { byUser = false } = {}) {
    if (lag > 0 && mid !== openMid) {
      lagFrom = openMid;
      lagUntil = Date.now() + lag;
      setTimeout(render, lag + 5);
    }
    openMid = mid;
    const c = chats.get(mid);
    if (byUser) c.loaded = true;
    c.unread = 0;
    render();
  }

  function render() {
    listEl.innerHTML = '';
    for (const [mid, c] of chats) {
      if (!c.inList) continue;
      const last = c.messages[c.messages.length - 1];
      const item = document.createElement('div');
      item.className = 'chatlistItem-module__chatlist_item__MOwxh';
      item.setAttribute('data-mid', mid);
      item.setAttribute('aria-current', String(mid === openMid));
      item.innerHTML =
        '<div class="chatlistItem-module__info__nHGhi">' +
        '<strong class="chatlistItem-module__title_box__aDNJD"><span class="chatlistItem-module__text__daDD3"><pre><span></span></pre></span></strong>' +
        '<time class="chatlistItem-module__date__tG-MV"></time>' +
        '<div class="chatlistItem-module__description__JH3NE"></div></div>' +
        '<button role="link" type="button" aria-label="Go chatroom" class="chatlistItem-module__button_chatlist_item__pcmtA"></button>';
      item.querySelector('pre span').textContent = c.name;
      if (last) {
        item.querySelector('time').setAttribute('datetime', new Date(last.ts).toString());   // seconds, like LINE
        item.querySelector('[class*="description"]').textContent = last.text;
      }
      if (c.unread) {
        const badge = document.createElement('span');
        badge.className = 'chatlistItem-module__message_count__FRt4s';
        badge.textContent = String(c.unread);
        item.firstChild.appendChild(badge);
      }
      item.querySelector('button').addEventListener('click', () => openChat(mid));
      listEl.appendChild(item);
    }
    const c = chats.get(openMid);
    roomEl.setAttribute('data-mid', openMid || '');
    roomEl.querySelector('[class*="chatroomHeader"] span').textContent = c ? c.name : '';
    msgList.innerHTML = '';
    const shown = frozen || listedNow();   // whose messages the list holds
    for (const m of (shown && shown.loaded ? shown.messages : [])) {
      const el = document.createElement('div');
      el.className = 'message-module__message__7odk3';
      el.setAttribute('data-direction', m.direction === 'outgoing' ? 'reverse' : '');
      el.setAttribute('data-mid', m.mid);
      el.setAttribute('data-timestamp', String(m.ts));
      el.setAttribute('data-message-select-id', m.selectId);
      el.setAttribute('data-message-content-prefix', `10:00 ${m.direction === 'outgoing' ? '李小華' : shown.name} `);
      el.innerHTML = '<div class="textMessageContent-module__content_wrap__238E1"><pre class="textMessageContent-module__text__EFwEN"><span data-is-message-text="true"></span></pre></div>';
      el.querySelector('span').textContent = m.text;
      msgList.insertBefore(el, msgList.firstChild);   // the real list is newest-first
    }
  }

  // 'sends' | 'ignores' (Enter not taken) | 'drops' (box empties, no bubble) |
  // 'stuck' (the app takes the Enter, the text stays, no bubble)
  let mode = 'sends';
  window.customElements.define('textarea-ex', class extends window.HTMLElement {
    constructor() {
      super();
      this.ta = window.document.createElement('textarea');
      this.attachShadow({ mode: 'open' }).appendChild(this.ta);
      this.ta.addEventListener('input', () => this.setAttribute('data-is-empty', this.ta.value ? 'false' : 'true'));
      this.ta.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || mode === 'ignores' || !this.ta.value) return;
        e.preventDefault();
        if (mode === 'stuck') return;
        const text = this.ta.value;
        this.ta.value = '';
        this.setAttribute('data-is-empty', 'true');
        if (mode === 'sends') addMessage('outgoing', text);
      });
    }
    get value() { return this.ta.value ? [this.ta.value] : []; }
  });

  const box = () => document.querySelector('textarea-ex');
  return {
    window, chats, addChat, addMessage, openChat, render, box,
    // typeByHand: the box as the user leaves it - it REPLACES what is there ('' empties it).
    // keystrokes: the user typing on - added to whatever the box holds, as a real key is.
    // pressEnter: the user's own Enter.
    typeByHand(text) { box().ta.value = text; box().ta.dispatchEvent(new window.Event('input')); },
    keystrokes(text) { box().ta.value += text; box().ta.dispatchEvent(new window.Event('input')); },
    pressEnter() { box().ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); },
    sentIn: mid => chats.get(mid).messages.filter(m => m.direction === 'outgoing').map(m => m.text),
    get openMid() { return openMid; },
    get mode() { return mode; },
    set mode(m) { mode = m; },
    get clock() { return clock; },   // the timestamp of the newest message made so far
    get lag() { return lag; },
    set lag(ms) { lag = ms; if (!ms) { lagFrom = null; lagUntil = 0; render(); } },
    set freeze(on) { frozen = on ? listedNow() : null; render(); },
  };
};
