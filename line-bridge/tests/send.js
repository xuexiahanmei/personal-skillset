// Exercise scripts/send-dom.js against a stand-in for LINE's message box.
//
// The real <textarea-ex> is a Lit component. This mock reproduces only what
// send-dom.js relies on, as observed live on 2026-09-30: a chatroom element whose
// data-mid is the chat id, holding the header, the message list and the editor
// area; an open shadow root around a <textarea>; .value as [text] or []; a
// data-is-empty attribute; and a keydown Enter on the textarea that sends the
// text and empties the box. It proves the guards and the flow - not that LINE
// still behaves this way, which takes a live send.
//   cd tests && npm install && npm test
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const dom = new JSDOM(`<!doctype html><body>
  <div class="chatroom-module__chatroom__eVUaK" data-mid="UexampleWang">
    <div class="chatroomHeader-module__header__ihDT2"><span>王小明</span></div>
    <div class="message_list" role="log"></div>
    <div class="chatroomEditor-module__editor_area__1UsgR"><textarea-ex data-is-empty="true"></textarea-ex></div>
  </div>
</body>`);
const { window } = dom;
global.window = window;
global.document = window.document;
global.MutationObserver = window.MutationObserver;

const list = document.querySelector('.message_list');
const roomEl = document.querySelector('[data-mid]');
let seq = 0, clock = 1790000000000;
function addMessage(direction, text, ts, mid) {
  seq++;
  ts = ts || (clock += 1000);
  const el = document.createElement('div');
  el.className = 'message-module__message__7odk3';
  el.setAttribute('data-direction', direction === 'outgoing' ? 'reverse' : '');
  el.setAttribute('data-mid', mid || (direction === 'outgoing' ? 'UexampleSelf' : 'UexampleWang'));
  el.setAttribute('data-timestamp', String(ts));
  el.setAttribute('data-message-select-id', `0${ts}-90000000000000${String(seq).padStart(4, '0')}`);
  el.setAttribute('data-message-content-prefix', `10:00 ${direction === 'outgoing' ? '李小華' : '王小明'} `);
  el.innerHTML = '<div class="textMessageContent-module__content_wrap__238E1"><pre class="textMessageContent-module__text__EFwEN"><span data-is-message-text="true"></span></pre></div>';
  el.querySelector('span').textContent = text;
  list.insertBefore(el, list.firstChild);   // the real list is newest-first
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
      if (mode === 'sends') addMessage('outgoing', this.ta.value);
      this.ta.value = '';
      this.setAttribute('data-is-empty', 'true');
    });
  }
  get value() { return this.ta.value ? [this.ta.value] : []; }
});

for (const f of ['extract-dom.js', 'send-dom.js']) {
  eval(fs.readFileSync(path.join(root, 'scripts', f), 'utf8'));
}
const S = globalThis.LINESEND;

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`FAIL ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${name}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const box = () => document.querySelector('textarea-ex');
const typeByHand = text => { box().ta.value = text; box().ta.dispatchEvent(new window.Event('input')); };
const outgoing = () => LINEX.collect().filter(r => r.direction === 'outgoing').map(r => r.text);
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));

(async () => {
  addMessage('incoming', '在嗎');

  console.log('--- guards ---');
  check('status on an empty box', S.status(), { header: '王小明', chat: 'UexampleWang', empty: true, value: [] });
  check('stage refuses another chat', pick(S.stage('hi', '李大明'), ['ok', 'notSent']), { ok: false, notSent: true });
  check('stage refuses another chat id', S.stage('hi', '王小明', 'UsomeoneElse').ok, false);
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
  check('nothing was sent by the guards', outgoing(), []);

  console.log('--- manual send ---');
  check('stage', S.stage('好啊', '王小明').ok, true);
  check('commit, handled by the app', pick(S.commit('好啊', '王小明'), ['ok', 'handled']), { ok: true, handled: true });
  typeByHand('user types right away');
  check('verify: sent, even though the box is not empty', pick(S.verify(), ['ok', 'sent', 'boxEmpty']), { ok: true, sent: true, boxEmpty: false });
  typeByHand('');

  console.log('--- send() ---');
  check('send ok', await S.send('好啊 都可以', '王小明'), { ok: true });
  check('bubble appeared', outgoing().slice(-1), ['好啊 都可以']);
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

  console.log('--- relay (page side, fake server) ---');
  const calls = [];
  let outItems = [];
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, token: u.searchParams.get('t'), body: opts.body ? JSON.parse(opts.body) : undefined });
    const json = u.pathname === '/out' ? outItems : { ok: true };
    return { ok: true, status: 200, json: async () => json };
  };
  const posted = p => calls.filter(c => c.path === p);

  check('relay refuses another chat', S.relay.start({ token: 'tok', name: '李大明' }).ok, false);
  const already = LINEX.collect().filter(r => r.selectId).length;
  // A 60 s interval never fires during the test; the ticks are driven by hand.
  const started = S.relay.start({ token: 'tok', name: '王小明', intervalMs: 60000 });
  check('relay pins the chat id and ignores messages already there', pick(started, ['ok', 'chat', 'ignored']), { ok: true, chat: 'UexampleWang', ignored: already });
  await S.relay.tick();
  check('old messages are not forwarded', posted('/in').length, 0);
  addMessage('incoming', '你好', 1799999999000);
  addMessage('incoming', '同一毫秒', 1799999999000);
  await S.relay.tick();
  // Both, not their order: LINEX sorts by ts, and equal ts keep the DOM's order.
  check('new incoming messages are forwarded, same-ms ones too', posted('/in').map(c => c.body.text).sort(), ['你好', '同一毫秒'].sort());
  check('requests carry the token', posted('/in')[0].token, 'tok');
  outItems = [{ id: 1, chat: '王小明', text: '你好呀' }];
  await S.relay.tick();
  check('a queued reply is sent and reported', posted('/sent').map(c => [c.body.id, c.body.ok]), [[1, true]]);
  check('reply bubble', outgoing().slice(-1), ['你好呀']);
  await S.relay.tick();   // /out re-offers id 1, as if its /sent report was lost
  check('a re-offered reply is reported again, not sent again', [outgoing().filter(t => t === '你好呀').length, posted('/sent').length], [1, 2]);
  outItems = [{ id: 2, chat: '李大明', text: '給別人的' }];
  await S.relay.tick();
  const wrong = posted('/sent').slice(-1)[0].body;
  check('a reply queued for another chat is refused', [wrong.ok, wrong.notSent, outgoing().includes('給別人的')], [false, true, false]);
  outItems = [];
  addMessage('incoming', '清單還沒換過來', undefined, 'UsomeoneElse');   // the list lags a chat switch
  await S.relay.tick();
  check('in a 1:1 chat, a row from anyone but the contact is not forwarded', posted('/in').length, 2);
  roomEl.setAttribute('data-mid', 'UsameNameOtherChat');   // same header name, different chat
  addMessage('incoming', '另一個聊天室的訊息', undefined, 'UsameNameOtherChat');
  await S.relay.tick();
  check('another chat with the same name is not forwarded from', posted('/in').length, 2);
  outItems = [{ id: 3, chat: '王小明', text: '不該送到這裡' }];
  await S.relay.tick();
  check('...nor sent to', [posted('/sent').slice(-1)[0].body.notSent, outgoing().includes('不該送到這裡')], [true, false]);
  roomEl.setAttribute('data-mid', 'UexampleWang');

  outItems = [{ id: 4, chat: '王小明', text: '第一則' }, { id: 5, chat: '王小明', text: '第二則' }];
  const batch = S.relay.tick();
  await sleep(100);
  S.relay.stop();
  await batch;
  check('stop() mid-batch sends nothing after the current reply', [outgoing().includes('第一則'), outgoing().includes('第二則')], [true, false]);
  const outCalls = posted('/out').length;
  await S.relay.tick();
  check('a stopped relay does not poll', posted('/out').length, outCalls);

  const oldRelay = S.relay;
  S.relay.start({ token: 'tok', name: '王小明', intervalMs: 60000 });
  eval(fs.readFileSync(path.join(root, 'scripts', 'send-dom.js'), 'utf8'));
  check('re-pasting send-dom.js stops the running relay', oldRelay.status().running, false);
  globalThis.LINESEND.relay.stop();

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
