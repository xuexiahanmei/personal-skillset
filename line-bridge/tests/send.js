// Exercise scripts/send-dom.js against a stand-in for the LINE extension page
// (mock-line.js says what the stand-in reproduces, and what it cannot prove).
//   cd tests && npm install && npm test
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const mock = require('./mock-line')();
const { window, chats, addChat, addMessage, openChat, render } = mock;

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
// A check that waits on something that never comes leaves Node with nothing to
// do, and Node then exits with code 0 - mid-file, without a word. Not a pass.
let finished = false;
process.on('exit', code => {
  if (finished || code !== 0) return;
  console.log('FAIL the test file ended before its last check: something it waited for never came');
  process.exitCode = 1;
});
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`FAIL ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${name}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const box = () => document.querySelector('textarea-ex');
const typeByHand = text => { box().ta.value = text; box().ta.dispatchEvent(new window.Event('input')); };   // replaces what is there
const { keystrokes, pressEnter } = mock;   // the user typing on (added to what is there), and their own Enter
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
  // Between typing and Enter the text sits in a box the user can reach. Once the
  // box holds anything but exactly that text, "nothing went out" is no longer known.
  const racing = S.send('這句會撞到', '王小明', { timeoutMs: 600 });
  await sleep(100);
  keystrokes('ok');   // the user types on, into our text
  const raced = await racing;
  check('the user typing into the text during the settle: no Enter, and unconfirmed - never "not sent"',
    [pick(raced, ['ok', 'unconfirmed', 'notSent']), sentIn(WANG).includes('這句會撞到')], [{ ok: false, unconfirmed: true, notSent: undefined }, false]);
  check('...the box is left to the user as it is, and the reason does not quote what is in it', [box().value, raced.why.includes('這句會撞到')], [['這句會撞到ok'], false]);
  typeByHand('');
  const beaten = S.send('使用者先按了 Enter', '王小明', { timeoutMs: 600 });
  await sleep(100);
  pressEnter();       // the user's own Enter lands while our text is in the box
  const beat = await beaten;
  check('the user\'s Enter sends the text during the settle: reported as sent, with one bubble - not as "not sent"',
    [beat.ok, /not this script/.test(beat.why || ''), sentIn(WANG).filter(t => t === '使用者先按了 Enter').length], [true, true, 1]);
  const replaced = S.send('整句被換掉', '王小明', { timeoutMs: 600 });
  await sleep(100);
  typeByHand('the user started over');
  check('the box replaced by other text during the settle: unconfirmed, the user\'s text kept',
    [pick(await replaced, ['ok', 'unconfirmed']), box().value, sentIn(WANG).includes('整句被換掉')], [{ ok: false, unconfirmed: true }, ['the user started over'], false]);
  typeByHand('');
  // The mock keeps one box for all chats, so the text travels with a switch; whether LINE's does is not known.
  const carried = S.send('換聊天室時還在框裡', '王小明', { timeoutMs: 600 });
  await sleep(100);
  openChat(LEE);      // the user opens another chat while the text is in the box
  check('another chat opened with the text still in the box: taken back there, not sent',
    [pick(await carried, ['ok', 'notSent']), box().value, sentIn(LEE), sentIn(WANG).includes('換聊天室時還在框裡')], [{ ok: false, notSent: true }, [], [], false]);
  openChat(WANG);
  const left = S.send('換聊天室後框是空的', '王小明', { timeoutMs: 600 });
  await sleep(100);
  openChat(LEE);
  typeByHand('');     // ...and this time the new chat's box does not hold it
  const leftBehind = await left;
  check('another chat opened and the text no longer in view: unconfirmed - it may sit in the first chat as a draft',
    [pick(leftBehind, ['ok', 'unconfirmed']), /draft/.test(leftBehind.why), sentIn(LEE)], [{ ok: false, unconfirmed: true }, true, []]);
  openChat(WANG);
  mock.mode = 'ignores';
  const ignored = await S.send('Enter 沒反應', '王小明', { timeoutMs: 500 });
  check('Enter not taken -> notSent', pick(ignored, ['ok', 'notSent']), { ok: false, notSent: true });
  check('...and our text is cleared', S.status().value, []);
  mock.mode = 'drops';
  const dropped = await S.send('不知道有沒有送出', '王小明', { timeoutMs: 500 });
  check('box emptied without a bubble -> unconfirmed, not notSent', pick(dropped, ['ok', 'unconfirmed', 'notSent']), { ok: false, unconfirmed: true, notSent: undefined });
  mock.mode = 'sends';
  const area = document.querySelector('[class*="chatroomEditor-module__editor_area__"]');
  const detached = area.removeChild(box());
  const boom = await S.send('沒有輸入框', '王小明');
  check('an exception before anything is typed -> notSent', [boom.notSent, /^exception before typing/.test(boom.why)], [true, true]);
  area.appendChild(detached);
  const vanishing = S.send('打完字輸入框不見了', '王小明', { timeoutMs: 600 });
  await sleep(100);
  area.removeChild(box());   // the text is in a box that is no longer there to look at
  const vanished = await vanishing;
  check('an exception once the text is typed -> unconfirmed', [pick(vanished, ['ok', 'unconfirmed', 'notSent']), /^exception after typing/.test(vanished.why)],
    [{ ok: false, unconfirmed: true, notSent: undefined }, true]);
  area.appendChild(detached);
  typeByHand('');

  console.log('--- send(): what counts as sent ---');
  // LINEX strips zero-width characters from what it reads, so the bubble's text
  // is not byte-equal to what was typed.
  check('a text with a zero-width joiner still reads back as sent', await S.send('好 👨\u200D👩', '王小明', { timeoutMs: 500 }), { ok: true });
  const calledOff = await S.send('先問過再送', '王小明', { beforeCommit: async () => ({ go: false, why: 'called off' }) });
  check('beforeCommit says no -> notSent, with its reason', pick(calledOff, ['ok', 'notSent', 'why']), { ok: false, notSent: true, why: 'called off' });
  check('...nothing went out and the box is empty', [sentIn(WANG).includes('先問過再送'), S.status().empty], [false, true]);
  const noAnswer = await S.send('問不到就不送', '王小明', { beforeCommit: async () => { throw new Error('relay gone'); } });
  check('beforeCommit that throws -> notSent', [noAnswer.notSent, sentIn(WANG).includes('問不到就不送'), S.status().empty], [true, false, true]);
  check('beforeCommit says go -> sent', [await S.send('問過了', '王小明', { beforeCommit: async () => ({ go: true }) }), sentIn(WANG).slice(-1)[0]], [{ ok: true }, '問過了']);
  // A page that was held up after asking (a debugger pause, a frozen tab) must not act on an old go.
  const lateGo = await S.send('太晚的許可', '王小明', { goFreshMs: 100, beforeCommit: async () => { await sleep(300); return { go: true }; } });
  check('a go that comes back too late is not acted on', [pick(lateGo, ['ok', 'notSent']), sentIn(WANG).includes('太晚的許可'), S.status().empty], [{ ok: false, notSent: true }, false, true]);
  // LINE's clock and this machine's need not agree: the newest message can be stamped a little ahead of the bubble just sent.
  addMessage('incoming', '對方的時鐘比較快', { ts: mock.clock + 60000, old: true });
  check('a bubble a minute older than the newest message still counts as the one just sent', await S.send('時鐘差一分鐘', '王小明', { timeoutMs: 500 }), { ok: true });
  chats.get(WANG).messages = chats.get(WANG).messages.filter(m => m.text !== '對方的時鐘比較快');
  render();

  mock.mode = 'drops';   // Enter is taken, and no bubble of ours appears
  const otherText = S.send('只有這句算數', '王小明', { timeoutMs: 900 });
  await sleep(450);
  addMessage('outgoing', '手機上打的別句');   // a new outgoing bubble - with another text
  addMessage('incoming', '只有這句算數');    // the same text - from the other side
  check('only an outgoing bubble with the same text counts: another text, or the same text from the other side, is not "sent"',
    pick(await otherText, ['ok', 'unconfirmed']), { ok: false, unconfirmed: true });
  const shifting = S.send('列表換成別人的', '王小明', { timeoutMs: 900 });
  await sleep(450);
  addMessage('incoming', '別人的訊息', { mid: 'UsomeoneElse' });   // the list now holds someone else's message...
  addMessage('outgoing', '列表換成別人的');                       // ...and a bubble with the text
  check('a bubble with the text, in a 1:1 list that holds someone else\'s message, is not "sent": the list is not this chat\'s',
    pick(await shifting, ['ok', 'unconfirmed']), { ok: false, unconfirmed: true });
  chats.get(WANG).messages = chats.get(WANG).messages.filter(m => !['手機上打的別句', '只有這句算數', '別人的訊息', '列表換成別人的'].includes(m.text));
  render();
  mock.mode = 'sends';
  const search = document.createElement('input');   // the page's search field, say
  document.body.appendChild(search);
  search.focus();
  await S.send('游標要回到原處', '王小明');
  check('after a send the page\'s focus is back where it was, not in the message box', document.activeElement === search, true);
  search.remove();

  const ELSE = 'UexampleElse';
  addChat(ELSE, '趙小強');
  addMessage('outgoing', '收到', { chat: ELSE });   // the same text, already in another chat
  mock.mode = 'drops';
  const moving = S.send('收到', '王小明', { timeoutMs: 1500 });
  await sleep(400);     // Enter went out at 300 ms
  openChat(ELSE);       // the user clicks another chat
  check('the chat changed right after Enter -> unconfirmed, not ok', pick(await moving, ['ok', 'unconfirmed']), { ok: false, unconfirmed: true });
  openChat(WANG);
  chats.delete(ELSE);
  render();

  const scrolled = S.send('好', '王小明', { timeoutMs: 900 });   // still 'drops': nothing goes out
  await sleep(450);
  addMessage('outgoing', '好', { ts: 1700000000000, old: true });   // an old bubble with the same text scrolls into view
  check('an older bubble with the same text that turns up is not taken for the one just sent', pick(await scrolled, ['ok', 'unconfirmed']), { ok: false, unconfirmed: true });
  chats.get(WANG).messages = chats.get(WANG).messages.filter(m => m.ts !== 1700000000000);
  render();

  mock.mode = 'stuck';
  const stuck = await S.send('按了但還在', '王小明', { timeoutMs: 500 });
  check('the app took the Enter but kept the text -> unconfirmed, the text left alone',
    [pick(stuck, ['ok', 'unconfirmed', 'notSent']), box().value], [{ ok: false, unconfirmed: true, notSent: undefined }, ['按了但還在']]);
  typeByHand('');

  mock.mode = 'drops';
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms === 250 ? 600 : ms, ...rest);   // a throttled page
  const slowFrom = Date.now();
  const slow = await S.send('計時器被拖慢', '王小明', { timeoutMs: 1000 });
  global.setTimeout = realSetTimeout;
  check('a throttled page: the wait ends on the clock, not after N sleeps', [slow.unconfirmed, Date.now() - slowFrom < 2100], [true, true]);
  mock.mode = 'sends';

  console.log('--- loadAll ---');
  let copies = 0;
  global.copy = () => { copies++; };
  const quiet = await LINEX.loadAll({ pause: 1, copy: false });
  check('loadAll({ copy: false }) leaves the clipboard alone', [copies, quiet.messages.length > 0], [0, true]);
  await LINEX.loadAll({ pause: 1 });
  check('loadAll() still copies by default', copies, 1);
  delete global.copy;
  const LONG = 'UexampleLong';
  addChat(LONG, '很長的聊天');
  openChat(LONG);
  const older = setInterval(() => addMessage('incoming', '更舊的訊息', { chat: LONG }), 20);   // history that keeps coming
  const cutFrom = Date.now();
  const cut = await LINEX.loadAll({ pause: 50, copy: false, maxRounds: 40, deadlineMs: 120 });
  clearInterval(older);
  check('loadAll stops at its deadline and says the history is not complete', [cut.truncated, Date.now() - cutFrom < 500], [true, true]);
  check('...a load that ran to the end is not marked', quiet.truncated, undefined);
  openChat(WANG);
  chats.delete(LONG);
  render();

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
  chats.get(WANG).messages = chats.get(WANG).messages.filter(m => m.mid !== 'UsomeoneElse');   // the list has caught up
  render();
  openChat(TWIN);   // same header name, different chat
  addMessage('incoming', '另一個聊天室的訊息');
  await S.relay.tick();
  check('another chat with the same name is not forwarded from', posted('/in').length, 2);
  outItems = [{ id: 3, chat: '王小明', text: '不該送到這裡' }];
  await S.relay.tick();
  check('...nor sent to', [lastSent().notSent, sentIn(TWIN)], [true, []]);
  check('one-chat mode never switches chats', mock.openMid, TWIN);
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
  check('...each chat was visited and the view is back where it was', [posted('/log').slice(-1)[0].body.chats.map(c => c.ignored > 0), mock.openMid], [[true, true], WANG]);
  await S.relay.tick();
  check('nothing old is forwarded from either chat', posted('/in').length, inBefore);

  addMessage('incoming', '在嗎', { chat: LEE });   // arrives in the chat that is NOT open
  await S.relay.tick();
  check('a new message in another chat: the relay opens it and forwards it', [mock.openMid, pick(posted('/in').slice(-1)[0].body, ['chat', 'text'])], [LEE, { chat: '李大明', text: '在嗎' }]);
  outItems = [{ id: 10, chat: '王小明', text: '晚點回你' }];
  await S.relay.tick();
  check('a reply for the other chat: the relay switches there and sends', [mock.openMid, sentIn(WANG).slice(-1)[0], lastSent().ok], [WANG, '晚點回你', true]);
  outItems = [];
  await S.relay.tick();
  await S.relay.tick();
  check('its own reply does not keep it switching back and forth', posted('/in').length, inBefore + 1);

  typeByHand('我正在打字');
  addMessage('incoming', '還在嗎', { chat: LEE });
  await S.relay.tick();
  check('while the user is typing, the relay does not switch away', [mock.openMid, /typing/.test(S.relay.status().lastError), posted('/in').length], [WANG, true, inBefore + 1]);
  check('...and leaves the draft alone', box().value, ['我正在打字']);
  typeByHand('');
  await S.relay.tick();
  check('...then picks the message up once the box is empty', [mock.openMid, posted('/in').slice(-1)[0].body.text], [LEE, '還在嗎']);

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

  // ---- link mode: the page side of the MCP hub, against a fake hub ----
  console.log('--- link: asked by the hub ---');
  openChat(WANG);
  const hubCalls = [];
  let work = [], go = { go: true }, hubUp = true, epoch = 'epoch-1', pollStatus = 200, failSent = 0, openAtSent = null, onWait = null;
  let hubFollow = null, onSent = null;   // the chats the hub says are followed; a hook for the moment a result arrives
  let pollGate = null, onResult = null;  // a promise the next poll is held on; a hook for the moment an op's answer arrives
  let waitHangs = false;                 // the hub takes the page's waits and never answers them
  const answerOf = (status, json) => ({ ok: status < 400, status, json: async () => json });
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    if (!hubUp) throw new TypeError('Failed to fetch');
    if (u.pathname === '/wait') {   // the hub times the page's waits
      if (waitHangs) return new Promise(() => {});
      if (onWait) onWait();
      await sleep(Number(u.searchParams.get('ms')));
      return answerOf(200, { ok: true });
    }
    if (u.pathname === '/sent') {
      if (failSent > 0) { failSent--; throw new TypeError('Failed to fetch'); }
      openAtSent = mock.openMid;
      if (onSent) onSent();
    }
    if (u.pathname === '/result' && onResult) onResult();
    hubCalls.push({ path: u.pathname, token: (opts.headers || {})['x-line-bridge-token'], q: Object.fromEntries(u.searchParams), body });
    if (u.pathname === '/poll') {
      const gate = pollGate;
      if (gate) await gate;
      const status = typeof pollStatus === 'function' ? pollStatus(u.searchParams.get('i')) : pollStatus;   // by page instance
      return answerOf(status, status !== 200 ? { error: 'superseded' }
        : Object.assign({ epoch, items: work.splice(0, 1) }, hubFollow ? { follow: hubFollow } : null));
    }
    if (u.pathname === '/commit') return answerOf(200, typeof go === 'function' ? go(body) : go);
    if (u.pathname === '/log') return answerOf(200, { ok: true, epoch });
    return answerOf(200, { ok: true });
  };
  const got = p => hubCalls.filter(c => c.path === p);
  const last = p => got(p).slice(-1)[0].body;
  let focus = false;   // does the LINE window have the keyboard?
  const LINK = { token: 'page-tok', build: 'b1', auto: false, pollMs: 0, hasFocus: () => focus, commitAskMs: 400 };
  // One item for the page, and the round that runs it.
  const give = async item => { work.push(item); await S.relay.pump(); };
  const op = (id, name, args = {}) => ({ id, kind: 'op', op: name, args });
  const msg = (id, chat, chatId, text, direct = true) => ({ id, kind: 'send', chat, chatId, text, direct });

  check('link() needs a token', S.relay.link({ auto: false }).ok, false);
  check('link() answers at once', pick(S.relay.link(LINK), ['ok', 'linking']), { ok: true, linking: true });
  await S.relay.ready();
  const hello = got('/log')[0];
  check('...and announces the page: the token in a header, never in the URL',
    [hello.token, hello.body.event, hello.body.chat, 't' in hello.q, ['i', 'l', 'b'].every(k => k in hello.q)], ['page-tok', 'linked', WANG, false, true]);

  typeByHand('這是我的草稿');
  await give(op('op-status', 'status'));
  const st1 = last('/result');
  check('status: the open chat, whether the box is empty, the chats in the list',
    [st1.ok, st1.value.header, st1.value.chat, st1.value.boxEmpty, st1.value.list.map(r => r.name)], [true, '王小明', WANG, false, ['王小明', '李大明', '陳小美']]);
  check('...without the draft or anyone\'s preview', [JSON.stringify(st1).includes('這是我的草稿'), JSON.stringify(st1).includes('還在嗎')], [false, false]);
  typeByHand('');
  await give(op('op-ctor', 'constructor'));
  check('an op that is not one of the four is refused', [last('/result').ok, /unknown op/.test(last('/result').why)], [false, true]);
  await give(Object.assign(op('op-late', 'status'), { runBy: Date.now() - 1 }));
  check('an op picked up after its time is not run', [last('/result').ok, last('/result').value.expired], [false, true]);

  console.log('--- link: reading ---');
  await give(op('op-read', 'read'));
  check('read: the open chat', [last('/result').value.header, last('/result').value.chat, last('/result').value.messages.length > 5], ['王小明', WANG, true]);
  check('...no switch was needed, and none is reported', 'switch' in last('/result').value, false);
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  await give(op('op-history-hidden', 'read', { history: true }));
  check('older messages are not loaded while the window is hidden', [last('/result').ok, last('/result').value.hidden], [false, true]);
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  await give(op('op-history', 'read', { history: true, deadlineMs: 1000 }));
  check('...and are, through LINEX.loadAll, while it is visible', [last('/result').ok, last('/result').value.messages.length > 5], [true, true]);
  await give(op('op-read-lee', 'read', { chat: '李大明' }));
  check('read by name: switches, reads, and goes back to where the user was',
    [pick(last('/result').value, ['header', 'chat', 'restored']), last('/result').value.messages.map(m => m.text).slice(-1)[0], mock.openMid],
    [{ header: '李大明', chat: LEE, restored: undefined }, '還在嗎', WANG]);
  const went = last('/result').value.switch;
  check('...and says how the switch went: when the header showed the chat, and that the list was not behind it',
    [typeof went.headerMs, went.laggedAtHeader, went.listMs === went.headerMs, went.rowsSettled > 0], ['number', false, true, true]);
  mock.lag = 400;   // for 0.4 s after a switch the list goes on showing the chat before
  await give(op('op-read-lag', 'read', { chat: '李大明' }));
  check('a list that lags the switch: the page waits for it, then reads the right chat',
    [last('/result').ok, last('/result').value.chat, last('/result').value.messages.map(m => m.text).slice(-1)[0]], [true, LEE, '還在嗎']);
  check('...and the answer says the list was behind the header, and for about how long',
    [last('/result').value.switch.laggedAtHeader, last('/result').value.switch.listMs >= 400], [true, true]);
  mock.lag = 0;
  openChat(WANG);
  mock.lag = 60000;   // ...and one that does not catch up
  await give(op('op-read-stuck', 'read', { chat: '李大明' }));
  check('a list that does not catch up: refused, nothing read',
    [last('/result').ok, /still shows the chat that was open before/.test(last('/result').why), last('/result').value.messages], [false, true, undefined]);
  check('...and no second switch on top of that one: the window stays, and the answer says so and how the switch went',
    [mock.openMid, last('/result').value.restored, /not caught up/.test(last('/result').value.restoreWhy), last('/result').value.switch.laggedAtHeader, last('/result').value.switch.listMs],
    [LEE, false, true, true, null]);
  await give(op('op-read-stuck-2', 'read', { chat: '李大明' }));   // the open chat now - under a list that is still the other chat's
  check('...asked again while the list still lags: refused again, nothing read',
    [last('/result').ok, /still shows the chat that was open before/.test(last('/result').why), last('/result').value.messages], [false, true, undefined]);
  await give(msg('s-stale', '李大明', LEE, '列表還沒跟上就不打字'));
  check('...and nothing is typed there either',
    [pick(last('/sent'), ['ok', 'notSent']), sentIn(LEE).includes('列表還沒跟上就不打字'), S.status().empty], [{ ok: false, notSent: true }, false, true]);
  mock.lag = 0;       // the list catches up
  await give(op('op-read-caught-up', 'read', { chat: '李大明' }));
  check('...once the list has caught up, the chat is read',
    [last('/result').ok, last('/result').value.chat, last('/result').value.messages.map(m => m.text).slice(-1)[0]], [true, LEE, '還在嗎']);
  openChat(WANG);
  // The list lags on the way back instead. Nothing is read then - but the next
  // read of the chat gone back to must not take the list for that chat's own.
  onResult = () => { mock.lag = 60000; };
  await give(op('op-read-back-lag', 'read', { chat: '李大明' }));
  onResult = null;
  check('read by name with the list lagging on the way back: the read itself is right', [last('/result').ok, last('/result').value.chat, mock.openMid], [true, LEE, WANG]);
  await give(op('op-read-after-back', 'read'));   // the open chat is 王小明 again, under a list that still shows 李大明
  check('...and a read of the chat gone back to is refused while its list is still the other chat\'s',
    [last('/result').ok, /still shows the chat that was open before/.test(last('/result').why), last('/result').value.messages], [false, true, undefined]);
  mock.lag = 0;
  await give(op('op-read-after-back-2', 'read'));
  check('...and is read once the list has caught up', [last('/result').ok, last('/result').value.chat], [true, WANG]);
  // The user switches by hand while the list is behind: the list is then a chat
  // behind, and the old rows going away proves nothing.
  mock.lag = 60000;
  openChat(LEE);   // by hand: the list goes on showing 王小明's rows
  await give(op('op-read-after-hand', 'read', { chat: '王小明' }));   // switching back shows 李大明's rows under 王小明
  check('a read right after the user switched by hand, under a list that is behind: refused - the rows are someone else\'s',
    [last('/result').ok, /holds messages from someone else/.test(last('/result').why), last('/result').value.messages], [false, true, undefined]);
  mock.lag = 0;
  await give(op('op-read-after-hand-2', 'read', { chat: '王小明' }));
  check('...and read once the list has caught up', [last('/result').ok, last('/result').value.chat], [true, WANG]);
  // A list that stops moving, showing 李大明 while the user is on 王小明.
  openChat(LEE);
  mock.freeze = true;
  openChat(WANG);
  await give(op('op-read-frozen', 'read', { chat: '李大明' }));   // the click changes nothing in the list: its rows were there already
  check('rows that do not change at the switch, but are positively the contact\'s own: read - not refused for ever',
    [last('/result').ok, last('/result').value.chat, last('/result').value.messages.map(m => m.text).slice(-1)[0]], [true, LEE, '還在嗎']);
  await give(op('op-read-frozen-2', 'read'));   // back on 王小明, under the same rows of 李大明
  check('...while the chat gone back to, under those rows, is refused', [last('/result').ok, /still shows the chat that was open before/.test(last('/result').why)], [false, true]);
  mock.freeze = false;
  await give(op('op-read-frozen-3', 'read'));
  check('...until the list moves again', [last('/result').ok, last('/result').value.chat], [true, WANG]);
  openChat(WANG);
  // The user clicks another chat while older messages are loading - a chat an
  // earlier item of the relay had opened and left again.
  let loads = 0;
  onWait = () => { if (++loads === 1) openChat(LEE); };
  await give(op('op-history-moved', 'read', { history: true, deadlineMs: 3000 }));
  onWait = null;
  check('the user opens another chat while older messages load: nothing is returned under the wrong name, and the window stays where they went',
    [last('/result').ok, /while older messages were loading/.test(last('/result').why), last('/result').value.messages, last('/result').value.restored, mock.openMid],
    [false, true, undefined, false, LEE]);
  openChat(WANG);
  openChat(TWIN);
  await give(op('op-read-twin', 'read', { chat: '王小明' }));
  check('read by a name two chats share: refused, with both ids', [last('/result').ok, last('/result').value.candidates], [false, [WANG, TWIN]]);
  await give(op('op-read-id', 'read', { chat: '王小明', chatId: WANG }));
  check('...the chat id settles it; no way back to a chat that is not in the list, and the answer says so',
    [last('/result').value.chat, last('/result').value.restored, mock.openMid], [WANG, false, WANG]);
  await give(op('op-read-gone', 'read', { chatId: 'UnotInTheList' }));
  check('read of a chat that is not in the visible list is refused', last('/result').ok, false);
  await give(op('op-read-lazy', 'read', { chat: '陳小美' }));
  check('a chat that never loaded: notLoaded instead of an empty list, and the window goes back',
    [last('/result').ok, last('/result').value.notLoaded, last('/result').value.messages, mock.openMid], [false, true, undefined, WANG]);
  typeByHand('打到一半');
  await give(op('op-read-typing', 'read', { chat: '李大明' }));
  check('no switch while the box holds text', [last('/result').ok, /not empty/.test(last('/result').why), mock.openMid, box().value], [false, true, WANG, ['打到一半']]);
  typeByHand('');

  console.log('--- link: sending ---');
  await give(msg('s-lazy', '陳小美', LAZY, '看不到就不送'));
  check('a chat that never loaded: a send is refused before anything is typed', [pick(last('/sent'), ['ok', 'notSent']), sentIn(LAZY), mock.openMid], [{ ok: false, notSent: true }, [], WANG]);
  await give({ id: 's-noid', kind: 'send', chat: '王小明', text: '沒有 id', direct: true });
  check('a message without its chat id is refused', pick(last('/sent'), ['ok', 'notSent']), { ok: false, notSent: true });
  await give(msg('s-1', '王小明', WANG, '連線模式送出'));
  const order = hubCalls.map(c => c.path);
  check('a message for the open chat: the hub is asked before Enter, then told the result',
    [last('/commit'), pick(last('/sent'), ['id', 'ok', 'chatId']), sentIn(WANG).slice(-1)[0], order.lastIndexOf('/commit') < order.lastIndexOf('/sent')],
    [{ id: 's-1' }, { id: 's-1', ok: true, chatId: WANG }, '連線模式送出', true]);
  go = { go: false, why: 'too late' };
  await give(msg('s-nogo', '王小明', WANG, '不准送'));
  check('no go from the hub: nothing is sent and the box is left empty',
    [pick(last('/sent'), ['ok', 'notSent', 'why']), sentIn(WANG).includes('不准送'), S.status().empty], [{ ok: false, notSent: true, why: 'too late' }, false, true]);
  go = { go: true };
  await give(msg('s-lee', '李大明', LEE, '切過去送'));
  check('a message for another chat: switch, send, report, and only then switch back',
    [sentIn(LEE), pick(last('/sent'), ['ok', 'restored']), openAtSent, mock.openMid], [['切過去送'], { ok: true, restored: undefined }, LEE, WANG]);
  await give(msg('s-wrongname', '王小明', LEE, '名字和 id 對不上'));
  check('a name that does not go with the id: refused without switching', [last('/sent').notSent, mock.openMid, sentIn(LEE).length], [true, WANG, 1]);
  onSent = () => { focus = true; };   // the user clicks into the LINE window while the result is on its way
  await give(msg('s-lee-2', '李大明', LEE, '回報途中使用者回來了'));
  onSent = null;
  await S.relay.pump();   // hands over the note about the window
  check('the user came back to the window while the result was reported: no switch back, and the hub is told',
    [last('/sent').ok, mock.openMid, pick(got('/log').slice(-1)[0].body, ['event', 'left', 'wanted'])],
    [true, LEE, { event: 'not-restored', left: '李大明', wanted: '王小明' }]);
  focus = false;
  openChat(WANG);
  const typedValues = [];   // every value the box takes, for "nothing was ever typed"
  box().ta.addEventListener('input', () => typedValues.push(box().ta.value));
  focus = true;
  await give(msg('s-focus', '李大明', LEE, '使用者正在視窗裡'));
  check('no switch while the user is in the LINE window', [last('/sent').notSent, /keyboard focus/.test(last('/sent').why), mock.openMid], [true, true, WANG]);
  await give(msg('s-focus-same', '王小明', WANG, '同一個聊天室也不打字'));
  check('...and nothing is typed into the open chat either: a key or an Enter of theirs would land in it',
    [last('/sent').notSent, /keyboard focus/.test(last('/sent').why), sentIn(WANG).includes('同一個聊天室也不打字'), S.status().empty], [true, true, false, true]);
  check('...not even for a moment: the text never went into the box', typedValues.includes('同一個聊天室也不打字'), false);
  focus = false;
  go = () => { focus = true; return { go: true }; };   // the user clicks into the window while the hub is asked
  await give(msg('s-focus-late', '王小明', WANG, '問到一半使用者回來了'));
  check('the user comes into the window while the go is on its way: no Enter, the text is taken back',
    [pick(last('/sent'), ['ok', 'notSent']), /keyboard focus/.test(last('/sent').why), sentIn(WANG).includes('問到一半使用者回來了'), S.status().empty],
    [{ ok: false, notSent: true }, true, false, true]);
  focus = false;
  go = () => { pressEnter(); return { go: true }; };   // the user's own Enter lands while the hub is asked
  await give(msg('s-user-enter', '王小明', WANG, '使用者的 Enter 先到'));
  check('an Enter of the user\'s while the text is in the box: reported as sent, with one bubble - never as not sent',
    [pick(last('/sent'), ['ok', 'notSent']), sentIn(WANG).filter(t => t === '使用者的 Enter 先到').length], [{ ok: true, notSent: undefined }, 1]);
  go = { go: true };
  const asksBefore = got('/commit').length;
  const colliding = give(msg('s-user-key', '王小明', WANG, '使用者多打了一個字'));
  await sleep(150);   // the text is in the box, the settle is still running
  keystrokes('啊');
  await colliding;
  check('a key of the user\'s lands in the text: no go is asked for, no Enter, unconfirmed, and the box is left to them',
    [got('/commit').length - asksBefore, pick(last('/sent'), ['ok', 'unconfirmed']), sentIn(WANG).includes('使用者多打了一個字'), box().value],
    [0, { ok: false, unconfirmed: true }, false, ['使用者多打了一個字啊']]);
  typeByHand('');
  go = () => new Promise(() => {});   // a hub that neither answers the question nor hangs up
  await give(msg('s-commit-hangs', '王小明', WANG, '問了沒人回'));
  go = { go: true };
  check('no answer to the question before Enter: given up at its time limit, the text taken back, not sent',
    [pick(last('/sent'), ['ok', 'notSent']), /no answer/.test(last('/sent').why), sentIn(WANG).includes('問了沒人回'), S.status().empty],
    [{ ok: false, notSent: true }, true, false, true]);
  waitHangs = true;                     // ...and one that holds the page's waits as well
  go = () => new Promise(() => {});
  const hangFrom = Date.now();
  await give(msg('s-wait-hangs', '王小明', WANG, 'hub 卡住了'));
  waitHangs = false;
  go = { go: true };
  check('a hub that holds every wait and every question: the text is taken back within the time limits, not left in the box',
    [pick(last('/sent'), ['ok', 'notSent']), S.status().empty, sentIn(WANG).includes('hub 卡住了'), Date.now() - hangFrom < 10000], [{ ok: false, notSent: true }, true, false, true]);
  mock.mode = 'drops';
  let waits = 0;
  onWait = () => { if (++waits === 3) openChat(TWIN); };   // the user clicks another chat while the result is awaited
  await give(msg('s-moved', '李大明', LEE, '送出後使用者換了聊天室'));
  onWait = null;
  check('the user moved on meanwhile: unconfirmed, and the window is left where they went',
    [pick(last('/sent'), ['ok', 'unconfirmed', 'restored']), mock.openMid], [{ ok: false, unconfirmed: true, restored: false }, TWIN]);
  mock.mode = 'sends';
  openChat(WANG);

  console.log('--- link: following ---');
  await give(op('op-follow-fail', 'follow', { names: ['李大明', '陳小美'] }));   // the second one never loaded
  check('a follow that fails half-way: nothing is followed, and the window goes back from the chats it had opened',
    [last('/result').ok, S.relay.status().link.follow, last('/result').value.restored, mock.openMid], [false, [], undefined, WANG]);
  await give(op('op-follow', 'follow', { names: ['王小明', '李大明'] }));
  check('follow: each chat visited once, then back where the user was',
    [last('/result').ok, last('/result').value.chats.map(c => [c.name, c.chat, c.ignored > 0]), mock.openMid], [true, [['王小明', WANG, true], ['李大明', LEE, true]], WANG]);
  await give(msg('s-1', '王小明', WANG, '連線模式送出'));   // offered again, as after a lost report
  check('follow did not forget what was handled: the same id is reported again, not sent again',
    [sentIn(WANG).filter(t => t === '連線模式送出').length, pick(last('/sent'), ['id', 'ok'])], [1, { id: 's-1', ok: true }]);
  const inBeforeLink = got('/in').length;
  addMessage('incoming', '連線模式的新訊息', { chat: LEE });
  await S.relay.pump();
  check('a new message in a followed chat is forwarded with its chat id',
    [got('/in').length - inBeforeLink, pick(last('/in'), ['chat', 'chatId', 'text']), mock.openMid], [1, { chat: '李大明', chatId: LEE, text: '連線模式的新訊息' }, LEE]);
  await give(msg('r-1', '王小明', WANG, '自動回覆', false));
  check('a reply goes to a followed chat, and the window stays there', [last('/sent').ok, sentIn(WANG).slice(-1)[0], mock.openMid], [true, '自動回覆', WANG]);
  const FREE = 'UexampleFree';
  addChat(FREE, '林小安');   // in the list, loaded, and not followed
  addMessage('incoming', '沒人追蹤我', { chat: FREE });
  await give(msg('r-2', '林小安', FREE, '沒有追蹤的聊天室', false));
  check('a reply for a chat that is not followed is refused, without going there', [last('/sent').notSent, sentIn(FREE), mock.openMid], [true, [], WANG]);
  chats.delete(FREE);
  render();
  hubFollow = [LEE, WANG];
  await S.relay.pump();
  check('the hub lists the same chats: still following', S.relay.status().link.follow.length, 2);
  hubFollow = null;
  hubUp = false;
  await S.relay.pump();
  addMessage('incoming', 'hub 不在時進來的', { chat: LEE });
  await S.relay.pump();
  check('while the hub is away no chat is opened (it would be marked read for nobody)', [mock.openMid, S.relay.status().link.hubOk], [WANG, false]);
  hubUp = true;
  await S.relay.pump();   // the hub answers again
  await S.relay.pump();
  check('...and once it is back the message is forwarded', [mock.openMid, last('/in').text], [LEE, 'hub 不在時進來的']);
  const inBeforeRestart = got('/in').length;
  addMessage('incoming', '換 hub 的那一刻進來的', { chat: WANG });   // news in a followed chat that is not the open one
  epoch = 'epoch-2';
  await S.relay.pump();
  await S.relay.pump();
  check('another hub answers: the followed chats are dropped, and it is told',
    [S.relay.status().link.follow, got('/log').slice(-1)[0].body.event], [[], 'unfollowed']);
  check('...before any chat is opened or any message forwarded for it', [mock.openMid, got('/in').length - inBeforeRestart], [LEE, 0]);
  // The incoming messages after the last outgoing one, as the mock holds them.
  const unansweredIn = mid => chats.get(mid).messages.reduce((n, m) => (m.direction === 'outgoing' ? 0 : n + 1), 0);
  await give(op('op-refollow', 'follow', { names: ['王小明', '李大明'] }));
  const refollowed = last('/result');
  check('followed again after the restart: it starts from what is there - nothing old is forwarded, and it says how much waits for an answer',
    [refollowed.ok, got('/in').length - inBeforeRestart, refollowed.value.chats.map(c => [c.name, c.unanswered]), unansweredIn(WANG) >= 1],
    [true, 0, [['王小明', unansweredIn(WANG)], ['李大明', unansweredIn(LEE)]], true]);
  openChat(WANG);
  addMessage('incoming', '還沒被收走的', { chat: LEE });   // arrives after the last look, before the next one
  await give(op('op-follow-again', 'follow', { names: ['王小明', '李大明'] }));
  check('following the same chats again goes on where it stands: what had just come in is forwarded, not taken as old',
    [last('/result').ok, got('/in').slice(-1)[0].body.text], [true, '還沒被收走的']);
  openChat(WANG);
  const inBeforeFail = got('/in').length;
  addMessage('incoming', '失敗的追蹤不能吃掉我', { chat: LEE });
  await give(op('op-follow-half', 'follow', { names: ['李大明', '陳小美'] }));   // the second one never loads
  await S.relay.pump();
  check('a follow that fails half-way changes nothing: the chats followed before still are, and the message is forwarded once',
    [last('/result').ok, S.relay.status().link.follow.map(c => c.name), got('/in').slice(inBeforeFail).map(c => c.body.text)],
    [false, ['王小明', '李大明'], ['失敗的追蹤不能吃掉我']]);
  // A followed group, and a list that does not catch up when the page switches to
  // it. In a group nothing tells the rows of one chat from another's, so the wait
  // for the list is all there is - also once the group is the open chat.
  const GROUP = 'CexampleGroup';
  addChat(GROUP, '測試群組');
  addMessage('incoming', '群組裡的舊訊息', { chat: GROUP, mid: LEE });
  openChat(WANG);
  await give(op('op-follow-group', 'follow', { names: ['王小明', '測試群組'] }));
  const inBeforeLag = got('/in').length;
  addMessage('incoming', '只給我看的', { chat: WANG });
  await S.relay.pump();   // the open chat's own message: passed on
  mock.lag = 60000;
  addMessage('incoming', '群組的新訊息', { chat: GROUP, mid: LEE });
  await S.relay.pump();   // the page switches to the group; the list goes on showing 王小明's rows
  await give(op('op-status-lagging', 'status'));   // the group is the open chat now, under a list that is not its own
  check('a followed chat whose list has not caught up is not collected - also once it is the open chat: nothing of the other chat is passed on under its name',
    [mock.openMid, got('/in').slice(inBeforeLag).map(c => [c.body.chat, c.body.text]), /still shows the chat that was open before/.test(last('/result').value.followError)],
    [GROUP, [['王小明', '只給我看的']], true]);
  mock.lag = 0;
  await S.relay.pump();
  check('...and once the list has caught up, the group\'s own message is passed on', pick(got('/in').slice(-1)[0].body, ['chat', 'chatId', 'text']), { chat: '測試群組', chatId: GROUP, text: '群組的新訊息' });
  hubFollow = [WANG];   // the hub lists fewer chats than the page follows
  await S.relay.pump();
  await S.relay.pump();
  check('the hub no longer lists what the page follows: the page stops, and says so',
    [S.relay.status().link.follow, pick(got('/log').slice(-1)[0].body, ['event', 'why'])], [[], { event: 'unfollowed', why: 'the relay no longer follows these chats' }]);
  await S.relay.pump();
  await S.relay.pump();
  await S.relay.pump();
  check('the hub lists chats this page does not follow: it is told, once',
    got('/log').filter(c => c.body.why === 'this page follows nothing').length, 1);
  hubFollow = null;

  console.log('--- link: results that must not get lost, pages that must stop ---');
  failSent = 1;
  await give(msg('s-retry', '王小明', WANG, '回報第一次沒送到'));
  check('a result the hub did not get is kept', [S.relay.status().link.unreported, sentIn(WANG).filter(t => t === '回報第一次沒送到').length], [1, 1]);
  await S.relay.pump();
  check('...and handed over on the next round, the message still sent once',
    [S.relay.status().link.unreported, pick(last('/sent'), ['id', 'ok']), sentIn(WANG).filter(t => t === '回報第一次沒送到').length], [0, { id: 's-retry', ok: true }, 1]);
  pollStatus = 409;
  await S.relay.pump();
  const pollsNow = got('/poll').length;
  await S.relay.pump();
  check('told that a newer paste has taken over, the page stops asking', [S.relay.status().link.linked, got('/poll').length - pollsNow], [false, 0]);
  pollStatus = 200;
  openChat(WANG);
  S.relay.link(LINK);
  await S.relay.ready();
  // relay.link() again on the same paste, while the first link waits for the hub's answer.
  const firstLink = S.relay.status().link.instance;
  let letGo;
  pollGate = new Promise(r => { letGo = r; });
  const firstPoll = S.relay.pump();   // the first link's poll, held by the hub
  await sleep(50);
  pollGate = null;
  S.relay.link(LINK);
  await S.relay.ready();
  pollStatus = i => (i === firstLink ? 409 : 200);
  letGo();                             // the hub tells the older link to stop
  await firstPoll;
  await S.relay.pump();
  check('relay.link() again on one paste: the older link hears its 409 and stops - the new one goes on',
    [S.relay.status().link.instance !== firstLink, S.relay.status().link.linked, S.relay.status().link.lastError], [true, true, null]);
  pollStatus = 200;
  // The real default: given no hasFocus of its own, the link asks document.hasFocus().
  S.relay.link(Object.assign({}, LINK, { hasFocus: undefined }));
  await S.relay.ready();
  document.hasFocus = () => true;
  await give(msg('s-doc-focus', '王小明', WANG, '預設問 document.hasFocus'));
  delete document.hasFocus;
  check('by default the link asks document.hasFocus(), and true means nothing is typed',
    [last('/sent').notSent, /keyboard focus/.test(last('/sent').why), sentIn(WANG).includes('預設問 document.hasFocus')], [true, true, false]);
  S.relay.link(LINK);
  await S.relay.ready();
  const firstPaste = S.relay;
  go = () => {   // the user pastes the scripts again while a message is on its way
    eval(fs.readFileSync(path.join(root, 'scripts', 'send-dom.js'), 'utf8'));
    return { go: true };
  };
  await give(msg('s-repaste', '王小明', WANG, '送到一半重貼'));
  S = globalThis.LINESEND;
  go = { go: true };
  check('the scripts pasted again mid-send: one bubble, its result still reported, the old page stopped',
    [sentIn(WANG).filter(t => t === '送到一半重貼').length, pick(last('/sent'), ['id', 'ok']), firstPaste.status().link.linked], [1, { id: 's-repaste', ok: true }, false]);

  finished = true;
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
