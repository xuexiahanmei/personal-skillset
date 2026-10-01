// Exercise scripts/send-dom.js against a stand-in for the LINE extension page.
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
//   cd tests && npm install && npm test
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
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

function addMessage(direction, text, { chat = openMid, ts, mid } = {}) {
  seq++;
  ts = ts || (clock += 1000);
  const c = chats.get(chat);
  c.messages.push({
    direction, text, ts, mid: mid || (direction === 'outgoing' ? 'UexampleSelf' : chat),
    selectId: `0${ts}-90000000000000${String(seq).padStart(4, '0')}`,
  });
  if (direction === 'incoming' && chat !== openMid) c.unread++;
  render();
}

// byUser: a real click with the window visible, which is what loads a chat.
function openChat(mid, { byUser = false } = {}) {
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
  for (const m of (c && c.loaded ? c.messages : [])) {
    const el = document.createElement('div');
    el.className = 'message-module__message__7odk3';
    el.setAttribute('data-direction', m.direction === 'outgoing' ? 'reverse' : '');
    el.setAttribute('data-mid', m.mid);
    el.setAttribute('data-timestamp', String(m.ts));
    el.setAttribute('data-message-select-id', m.selectId);
    el.setAttribute('data-message-content-prefix', `10:00 ${m.direction === 'outgoing' ? '李小華' : c.name} `);
    el.innerHTML = '<div class="textMessageContent-module__content_wrap__238E1"><pre class="textMessageContent-module__text__EFwEN"><span data-is-message-text="true"></span></pre></div>';
    el.querySelector('span').textContent = m.text;
    msgList.insertBefore(el, msgList.firstChild);   // the real list is newest-first
  }
}

let mode = 'sends';   // 'sends' | 'ignores' (Enter not taken) | 'drops' (box empties, no bubble)
window.customElements.define('textarea-ex', class extends window.HTMLElement {
  constructor() {
    super();
    this.ta = window.document.createElement('textarea');
    this.attachShadow({ mode: 'open' }).appendChild(this.ta);
    this.ta.addEventListener('input', () => this.setAttribute('data-is-empty', this.ta.value ? 'false' : 'true'));
    this.ta.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || mode === 'ignores' || !this.ta.value) return;
      e.preventDefault();
      const text = this.ta.value;
      this.ta.value = '';
      this.setAttribute('data-is-empty', 'true');
      if (mode === 'sends') addMessage('outgoing', text);
    });
  }
  get value() { return this.ta.value ? [this.ta.value] : []; }
});

const WANG = 'UexampleWang', LEE = 'UexampleLee', LAZY = 'UexampleLazy', TWIN = 'UsameNameOtherChat';
addChat(WANG, '王小明');
addChat(LEE, '李大明');
addChat(LAZY, '陳小美', { loaded: false });            // not opened since the page loaded
addChat(TWIN, '王小明', { inList: false });            // same display name, another chat
openChat(WANG);

for (const f of ['extract-dom.js', 'send-dom.js']) {
  eval(fs.readFileSync(path.join(root, 'scripts', f), 'utf8'));
}
let S = globalThis.LINESEND;

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`FAIL ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${name}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const box = () => document.querySelector('textarea-ex');
const typeByHand = text => { box().ta.value = text; box().ta.dispatchEvent(new window.Event('input')); };
const sentIn = mid => chats.get(mid).messages.filter(m => m.direction === 'outgoing').map(m => m.text);
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));

(async () => {
  addMessage('incoming', '在嗎');

  console.log('--- guards ---');
  check('status on an empty box', S.status(), { header: '王小明', chat: WANG, empty: true, value: [] });
  check('stage refuses another chat', pick(S.stage('hi', '李大明'), ['ok', 'notSent']), { ok: false, notSent: true });
  check('stage refuses another chat id', S.stage('hi', '王小明', TWIN).ok, false);
  check('stage refuses multi-line text', S.stage('a\nb', '王小明').ok, false);
  typeByHand('user draft');
  check('stage refuses while the user is typing', S.stage('hi', '王小明').why, 'message box is not empty (the user may be typing)');
  check('the user draft is untouched', box().value, ['user draft']);
  check('clear() leaves text that is not ours', S.clear().ok, false);
  check('...and the draft is still there', box().value, ['user draft']);
  typeByHand('');
  box().ta.value = 'stale';   // data-is-empty still says "true"
  check('stage refuses when the attribute lags the textarea', S.stage('hi', '王小明').ok, false);
  typeByHand('');
  check('commit refuses without stage', S.commit('hi', '王小明').ok, false);
  check('stage ok', S.stage('第一句', '王小明').ok, true);
  check('commit refuses text that was not staged', S.commit('第二句', '王小明').ok, false);
  check('clear() removes our staged text', S.clear().ok, true);
  check('nothing was sent by the guards', sentIn(WANG), []);

  console.log('--- manual send ---');
  check('stage', S.stage('好啊', '王小明', WANG).ok, true);
  check('commit, handled by the app', pick(S.commit('好啊', '王小明', WANG), ['ok', 'handled']), { ok: true, handled: true });
  typeByHand('user types right away');
  check('verify: sent, even though the box is not empty', pick(S.verify(), ['ok', 'sent', 'boxEmpty']), { ok: true, sent: true, boxEmpty: false });
  typeByHand('');

  console.log('--- send() ---');
  check('send ok', await S.send('好啊 都可以', '王小明'), { ok: true });
  check('bubble appeared', sentIn(WANG).slice(-1), ['好啊 都可以']);
  check('box empty after send', S.status().empty, true);
  const racing = S.send('這句會撞到', '王小明');
  await sleep(100);
  typeByHand('the user started typing');
  const raced = await racing;
  check('the user typing during the settle refuses the send', pick(raced, ['ok', 'notSent']), { ok: false, notSent: true });
  check('...and keeps the user text', box().value, ['the user started typing']);
  typeByHand('');
  mode = 'ignores';
  const ignored = await S.send('Enter 沒反應', '王小明', { timeoutMs: 500 });
  check('Enter not taken -> notSent', pick(ignored, ['ok', 'notSent']), { ok: false, notSent: true });
  check('...and our text is cleared', S.status().value, []);
  mode = 'drops';
  const dropped = await S.send('不知道有沒有送出', '王小明', { timeoutMs: 500 });
  check('box emptied without a bubble -> unconfirmed, not notSent', pick(dropped, ['ok', 'unconfirmed', 'notSent']), { ok: false, unconfirmed: true, notSent: undefined });
  mode = 'sends';
  const area = document.querySelector('[class*="chatroomEditor-module__editor_area__"]');
  const detached = area.removeChild(box());
  const boom = await S.send('沒有輸入框', '王小明');
  check('an exception before Enter -> notSent', [boom.notSent, /^exception before Enter/.test(boom.why)], [true, true]);
  area.appendChild(detached);

  console.log('--- loadAll ---');
  let copies = 0;
  global.copy = () => { copies++; };
  const quiet = await LINEX.loadAll({ pause: 1, copy: false });
  check('loadAll({ copy: false }) leaves the clipboard alone', [copies, quiet.messages.length > 0], [0, true]);
  await LINEX.loadAll({ pause: 1 });
  check('loadAll() still copies by default', copies, 1);
  delete global.copy;

  // ---- the relay's page side, against a fake relay server ----
  const calls = [];
  let outItems = [];
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, token: u.searchParams.get('t'), body: opts.body ? JSON.parse(opts.body) : undefined });
    const json = u.pathname === '/out' ? outItems : { ok: true };
    return { ok: true, status: 200, json: async () => json };
  };
  const posted = p => calls.filter(c => c.path === p);
  const lastSent = () => posted('/sent').slice(-1)[0].body;
  // A 60 s interval never fires during the test; the ticks are driven by hand.
  const HAND = { token: 'tok', intervalMs: 60000 };

  console.log('--- relay: one chat ---');
  check('relay refuses another chat', S.relay.start({ ...HAND, name: '李大明' }).ok, false);
  const already = LINEX.collect().filter(r => r.selectId).length;
  const started = S.relay.start({ ...HAND, name: '王小明' });
  check('relay pins the chat id and ignores messages already there', pick(started, ['ok', 'chat', 'ignored']), { ok: true, chat: WANG, ignored: already });
  await S.relay.tick();
  check('old messages are not forwarded', posted('/in').length, 0);
  addMessage('incoming', '你好', { ts: 1799999999000 });
  addMessage('incoming', '同一毫秒', { ts: 1799999999000 });
  await S.relay.tick();
  // Both, not their order: LINEX sorts by ts, and equal ts keep the DOM's order.
  check('new incoming messages are forwarded, same-ms ones too', posted('/in').map(c => c.body.text).sort(), ['你好', '同一毫秒'].sort());
  check('...tagged with their chat, carrying the token', [posted('/in')[0].body.chat, posted('/in')[0].token], ['王小明', 'tok']);
  outItems = [{ id: 1, chat: '王小明', text: '你好呀' }];
  await S.relay.tick();
  check('a queued reply is sent and reported', posted('/sent').map(c => [c.body.id, c.body.ok]), [[1, true]]);
  check('reply bubble', sentIn(WANG).slice(-1), ['你好呀']);
  await S.relay.tick();   // /out re-offers id 1, as if its /sent report was lost
  check('a re-offered reply is reported again, not sent again', [sentIn(WANG).filter(t => t === '你好呀').length, posted('/sent').length], [1, 2]);
  outItems = [{ id: 2, chat: '李大明', text: '給別人的' }];
  await S.relay.tick();
  check('a reply for a chat the relay does not follow is refused', [lastSent().ok, lastSent().notSent, sentIn(LEE)], [false, true, []]);
  outItems = [];
  addMessage('incoming', '清單還沒換過來', { mid: 'UsomeoneElse' });   // the list lags a chat switch
  await S.relay.tick();
  check('in a 1:1 chat, a row from anyone but the contact is not forwarded', posted('/in').length, 2);
  openChat(TWIN);   // same header name, different chat
  addMessage('incoming', '另一個聊天室的訊息');
  await S.relay.tick();
  check('another chat with the same name is not forwarded from', posted('/in').length, 2);
  outItems = [{ id: 3, chat: '王小明', text: '不該送到這裡' }];
  await S.relay.tick();
  check('...nor sent to', [lastSent().notSent, sentIn(TWIN)], [true, []]);
  check('one-chat mode never switches chats', openMid, TWIN);
  openChat(WANG);

  outItems = [{ id: 4, chat: '王小明', text: '第一則' }, { id: 5, chat: '王小明', text: '第二則' }];
  const batch = S.relay.tick();
  await sleep(100);
  S.relay.stop();
  await batch;
  check('stop() mid-batch sends nothing after the current reply', [sentIn(WANG).includes('第一則'), sentIn(WANG).includes('第二則')], [true, false]);
  const outCalls = posted('/out').length;
  await S.relay.tick();
  check('a stopped relay does not poll', posted('/out').length, outCalls);
  outItems = [];

  console.log('--- relay: several chats ---');
  addMessage('incoming', '舊訊息', { chat: LEE });
  addMessage('incoming', '看不到的舊訊息', { chat: LAZY });
  openChat(WANG);
  check('a name that is not in the chat list is refused', S.relay.start({ ...HAND, names: ['王小明', '不存在'] }).ok, false);
  check('duplicate names are refused', S.relay.start({ ...HAND, names: ['王小明', '王小明'] }).ok, false);
  check('start with a chat that never loaded: accepted, then fails', S.relay.start({ ...HAND, names: ['王小明', '陳小美'] }), { ok: true, starting: ['王小明', '陳小美'] });
  const failed = await S.relay.ready();
  check('...the relay is not running and says which chat', [failed.running, /陳小美/.test(failed.lastError)], [false, true]);
  check('...and the relay server is told', posted('/log').slice(-1)[0].body.event, 'start-failed');

  openChat(WANG);
  const inBefore = posted('/in').length;
  S.relay.start({ ...HAND, names: ['王小明', '李大明'] });
  const up = await S.relay.ready();
  check('start with loaded chats: running, both followed', [up.running, up.ready, up.chats.map(c => c.name)], [true, true, ['王小明', '李大明']]);
  check('...each chat was visited and the view is back where it was', [posted('/log').slice(-1)[0].body.chats.map(c => c.ignored > 0), openMid], [[true, true], WANG]);
  await S.relay.tick();
  check('nothing old is forwarded from either chat', posted('/in').length, inBefore);

  addMessage('incoming', '在嗎', { chat: LEE });   // arrives in the chat that is NOT open
  await S.relay.tick();
  check('a new message in another chat: the relay opens it and forwards it', [openMid, pick(posted('/in').slice(-1)[0].body, ['chat', 'text'])], [LEE, { chat: '李大明', text: '在嗎' }]);
  outItems = [{ id: 10, chat: '王小明', text: '晚點回你' }];
  await S.relay.tick();
  check('a reply for the other chat: the relay switches there and sends', [openMid, sentIn(WANG).slice(-1)[0], lastSent().ok], [WANG, '晚點回你', true]);
  outItems = [];
  await S.relay.tick();
  await S.relay.tick();
  check('its own reply does not keep it switching back and forth', posted('/in').length, inBefore + 1);

  typeByHand('我正在打字');
  addMessage('incoming', '還在嗎', { chat: LEE });
  await S.relay.tick();
  check('while the user is typing, the relay does not switch away', [openMid, /typing/.test(S.relay.status().lastError), posted('/in').length], [WANG, true, inBefore + 1]);
  check('...and leaves the draft alone', box().value, ['我正在打字']);
  typeByHand('');
  await S.relay.tick();
  check('...then picks the message up once the box is empty', [openMid, posted('/in').slice(-1)[0].body.text], [LEE, '還在嗎']);

  chats.get(WANG).inList = false;   // scrolled out of the virtualised list
  render();
  await S.relay.tick();
  check('a followed chat that left the visible list is reported as missing', S.relay.status().chats.map(c => [c.name, c.missing]), [['王小明', true], ['李大明', false]]);
  outItems = [{ id: 11, chat: '王小明', text: '找不到聊天室' }];
  await S.relay.tick();
  check('...and a reply for it is refused, not sent elsewhere', [lastSent().notSent, sentIn(LEE), sentIn(WANG).includes('找不到聊天室')], [true, [], false]);
  outItems = [];
  chats.get(WANG).inList = true;
  render();

  const oldRelay = S.relay;
  eval(fs.readFileSync(path.join(root, 'scripts', 'send-dom.js'), 'utf8'));
  S = globalThis.LINESEND;
  check('re-pasting send-dom.js stops the running relay', oldRelay.status().running, false);

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
