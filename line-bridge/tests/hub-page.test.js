// The real page scripts (extract-dom.js + send-dom.js, in the mock page) against
// the real hub (mcp/hub.mjs) over real HTTP: what neither side's own test can
// show - a message on its way while the hub goes down, comes back, runs late.
// The chat names carry TEST- so that nothing here could ever match a real chat.
//   cd tests && npm install && npm test
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { request, pageFetch, freePort } = require('./http');

const root = path.join(__dirname, '..');
const mock = require('./mock-line')();
const { addChat, addMessage, openChat, sentIn, box } = mock;

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`FAIL ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${name}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o == null ? undefined : o[k]]));
const uid = () => crypto.randomUUID();
// Wait until fn() is (or resolves to something) truthy; false when it never is.
const until = async (fn, ms = 4000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (await fn()) return true;
  return false;
};

(async () => {
  const { startHub, readSecrets, EXT_ORIGIN, TOKEN_HEADER } = await import(pathToFileURL(path.join(root, 'mcp', 'hub.mjs')).href);
  const WANG = 'UtestWang', LEE = 'UtestLee', A = 'TEST-王小明', B = 'TEST-李大明', BUILD = 'b1';
  addChat(WANG, A);
  addChat(LEE, B);
  openChat(WANG);
  addMessage('incoming', 'PRIVATE-只在聊天室裡');
  addMessage('incoming', '在嗎', { chat: LEE });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-bridge-e2e-'));
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  let hub = await startHub({ dir, port, downAfterMs: 30000 });
  const { pageToken, controlSecret } = readSecrets(dir);

  // The page's fetch, as Chrome would send it from the extension's origin.
  let onPageAnswer = null;
  global.fetch = pageFetch(EXT_ORIGIN, { onAnswer: (p, body) => { if (onPageAnswer) onPageAnswer(p, body); } });
  const ctl = (p, body) => request(body === undefined ? 'GET' : 'POST', base + p,
    Object.assign({ [TOKEN_HEADER]: controlSecret }, body === undefined ? null : { 'content-type': 'application/json' }),
    body === undefined ? undefined : JSON.stringify(body)).then(r => r.body, e => ({ ok: false, lost: e.code }));
  const send = over => ctl('/send', Object.assign({ id: uid(), chat: A, chatId: WANG, build: BUILD, owner: 's1' }, over));
  const call = (op, args) => ctl('/call', { id: uid(), op, args: args || {}, build: BUILD, owner: 's1' });
  const logged = kind => fs.readFileSync(path.join(dir, 'events.log'), 'utf8').split('\n')
    .filter(l => l.startsWith(kind + ' ')).map(l => JSON.parse(l.slice(kind.length + 1)));
  // Has the hub that is up now heard from the page?
  const pageBack = () => until(async () => { const s = await ctl('/state'); return !!(s.page && s.page.live); }, 6000);

  for (const f of ['extract-dom.js', 'send-dom.js']) eval(fs.readFileSync(path.join(root, 'scripts', f), 'utf8'));
  const S = globalThis.LINESEND;
  S.relay.link({ url: base, token: pageToken, build: BUILD, pollMs: 200, hasFocus: () => false });
  await S.relay.ready();

  console.log('--- the page and the hub find each other ---');
  check('the hub serves the page that linked', pick((await ctl('/state')).page, ['build', 'live']), { build: BUILD, live: true });
  const st = await call('status');
  check('status, asked through the hub', [st.ok, st.value.header, st.value.list.map(r => [r.name, r.chat])], [true, A, [[A, WANG], [B, LEE]]]);
  const rd = await call('read');
  check('read, asked through the hub', [rd.ok, rd.value.chat, rd.value.messages.map(m => m.text)], [true, WANG, ['PRIVATE-只在聊天室裡']]);
  check('...and what was read is not in the log', fs.readFileSync(path.join(dir, 'events.log'), 'utf8').includes('PRIVATE-'), false);

  console.log('--- a message, there and back ---');
  const first = await send({ text: '你好' });
  check('send end to end: ok, one bubble', [first.ok, sentIn(WANG)], [true, ['你好']]);
  check('...SENT is logged with its id', logged('SENT').map(e => [e.id, e.text]), [[first.id, '你好']]);
  const other = await send({ chat: B, chatId: LEE, text: '切過去送' });
  check('a message for another chat: sent there', [other.ok, sentIn(LEE)], [true, ['切過去送']]);
  check('...and the window comes back', await until(() => mock.openMid === WANG), true);
  check('the same text again is refused by the hub, and never reaches the page',
    [pick(await send({ text: '你好' }), ['ok', 'duplicate']), sentIn(WANG)], [{ ok: false, duplicate: true }, ['你好']]);
  // The page settles 300 ms before it asks to send; with 100 ms allowed it asks too late.
  const tooSlow = await send({ text: '頁面太慢', commitMs: 100 });
  check('a page that is ready only after the time limit: notSent, and nothing goes out',
    [pick(tooSlow, ['ok', 'notSent']), sentIn(WANG), await until(() => S.status().empty)], [{ ok: false, notSent: true }, ['你好'], true]);

  console.log('--- the hub goes down before Enter ---');
  const beforeGo = send({ text: '還沒按就斷線' });
  await until(() => box().value.length > 0);   // the page has typed it, and is settling
  await hub.close();
  check('the caller hears a definite notSent', pick(await beforeGo, ['ok', 'notSent']), { ok: false, notSent: true });
  check('...the page takes its text back', await until(() => S.status().empty), true);
  check('...and nothing was sent', sentIn(WANG), ['你好']);
  hub = await startHub({ dir, port, downAfterMs: 30000 });
  check('a new hub on the same port: the page comes back without a new paste', await pageBack(), true);
  check('...and tells it what became of that message',
    await until(() => logged('SENDFAIL').some(e => e.text === '還沒按就斷線' && e.late)), true);

  console.log('--- the hub goes down after Enter ---');
  await call('status');   // the new hub has not seen these chats yet
  let closing = null;
  onPageAnswer = (p, body) => {
    if (p === '/commit' && body && body.go) { onPageAnswer = null; closing = hub.close(); }
  };
  const afterGo = await send({ text: '按了之後斷線' });
  await closing;
  check('the caller hears unconfirmed, not notSent', pick(afterGo, ['ok', 'unconfirmed', 'notSent']), { ok: false, unconfirmed: true, notSent: undefined });
  check('...the message did go out, once', [await until(() => sentIn(WANG).includes('按了之後斷線')), sentIn(WANG).filter(t => t === '按了之後斷線').length], [true, 1]);
  hub = await startHub({ dir, port, downAfterMs: 30000 });
  check('...and the next hub learns it was sent, under the same id',
    await until(() => logged('SENT').some(e => e.id === afterGo.id && e.late), 6000), true);
  check('still one bubble after the page reconnected', sentIn(WANG).filter(t => t === '按了之後斷線').length, 1);

  console.log('--- following, and replies inside what was approved ---');
  await pageBack();
  const followed = await call('follow', { names: [A, B] });
  check('follow, asked through the hub', [followed.ok, (await ctl('/state')).follow.map(c => c.chatId)], [true, [WANG, LEE]]);
  const cursor = (await ctl('/events')).cursor;
  const heard = ctl('/events?after=' + cursor + '&wait=5000');
  addMessage('incoming', '有人傳訊息來', { chat: LEE });
  check('an incoming message reaches a waiting reader, with its chat id',
    (await heard).events.filter(e => e.kind === 'IN').map(e => [e.data.chat, e.data.chatId, e.data.text]), [[B, LEE, '有人傳訊息來']]);
  const reply = over => ctl('/reply', Object.assign({ id: uid(), chat: B, chatId: LEE, build: BUILD, owner: 's1' }, over));
  check('a reply before any approval is refused', (await reply({ text: '還沒核准' })).noGrant, true);
  await ctl('/grant', { owner: 's1', chats: [{ name: B, chatId: LEE }], maxReplies: 1, minutes: 5 });
  check('one approved reply goes out', [(await reply({ text: '自動回覆' })).ok, sentIn(LEE).slice(-1)[0]], [true, '自動回覆']);
  check('the next one is refused, and not sent', [(await reply({ text: '超過額度' })).noGrant, sentIn(LEE).includes('超過額度')], [true, false]);

  S.relay.stop();
  await hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
