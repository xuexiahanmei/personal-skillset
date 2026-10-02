// The hub alone (mcp/hub.mjs): a real HTTP server on a free port and a temporary
// directory, with the LINE page played by plain requests. It proves the rules
// that keep a message from going out twice, late, or to the wrong chat - not
// that the page script follows them (send.js, hub-page.test.js).
//   cd tests && npm install && npm test
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { request: send1, freePort } = require('./http');

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`FAIL ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${name}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o == null ? undefined : o[k]]));
const uid = () => crypto.randomUUID();
const throws = fn => { try { fn(); return ''; } catch (e) { return e.message; } };
// Has the promise settled within ms?
const settled = (p, ms = 150) => Promise.race([p.then(() => true), sleep(ms).then(() => false)]);

(async () => {
  const { startHub, readSecrets, resolveConfig, EXT_ORIGIN, TOKEN_HEADER } =
    await import(pathToFileURL(path.join(__dirname, '..', 'mcp', 'hub.mjs')).href);
  const WANG = 'UexampleWang', LEE = 'UexampleLee', BUILD = 'build-1';

  console.log('--- where the private files may live ---');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'line-bridge-hub-'));
  const port = await freePort();
  check('a data directory inside a git work tree is refused',
    /inside a git work tree/.test(throws(() => resolveConfig({ LINE_BRIDGE_DIR: path.join(__dirname, 'private') }))), true);
  check('a relative data directory is refused', /absolute path/.test(throws(() => resolveConfig({ LINE_BRIDGE_DIR: 'private' }))), true);
  check('with neither LOCALAPPDATA nor an override there is no default', /no data directory/.test(throws(() => resolveConfig({}))), true);
  check('LINE_BRIDGE_TEST=1 refuses the real port', /refuses the real port/.test(throws(() => resolveConfig({ LINE_BRIDGE_DIR: tmp, LINE_BRIDGE_TEST: '1' }))), true);
  check('an absolute directory and a port are taken as given',
    resolveConfig({ LINE_BRIDGE_DIR: tmp, LINE_BRIDGE_PORT: String(port), LINE_BRIDGE_TEST: '1' }), { dir: tmp, port });
  const first = readSecrets(tmp), again = readSecrets(tmp);
  check('the two secrets are made once, then reused',
    [first.pageToken === again.pageToken, first.controlSecret === again.controlSecret, /^[0-9a-f]{32}$/.test(first.pageToken), first.pageToken !== first.controlSecret],
    [true, true, true, true]);

  let skew = 0;   // moves the hub's clock, not its timers
  const now = () => Date.now() + skew;
  let hub = await startHub({ dir: tmp, port, now, downAfterMs: 30000 });
  const base = 'http://127.0.0.1:' + port;
  let { pageToken, controlSecret } = first;

  const request = (at, method, pathname, headers, body, signal) => send1(method, at + pathname, headers, body, { signal });
  const json = body => (body === undefined ? null : { 'content-type': 'application/json' });
  const ctl = (p, body, token = controlSecret, signal) => request(base, body === undefined ? 'GET' : 'POST', p,
    Object.assign({ [TOKEN_HEADER]: token }, json(body)), body === undefined ? undefined : JSON.stringify(body), signal);
  const pageOf = (instance, linkedAt, at = base, token = () => pageToken) => {
    const q = `i=${instance}&l=${linkedAt}&b=${BUILD}`;
    return {
      get: (p, extra = '') => request(at, 'GET', `${p}?${q}${extra}`, { [TOKEN_HEADER]: token() }),
      post: (p, body) => request(at, 'POST', `${p}?${q}`, Object.assign({ [TOKEN_HEADER]: token() }, json(body)), JSON.stringify(body)),
    };
  };
  // With headers of the caller's choosing (Host, Origin).
  const raw = (method, pathname, headers, body) => request(base, method, pathname, headers, body);
  const logLines = (dir = tmp) => fs.readFileSync(path.join(dir, 'events.log'), 'utf8').split('\n').filter(Boolean);
  const logged = (kind, dir = tmp) => logLines(dir).filter(l => l.startsWith(kind + ' ')).map(l => JSON.parse(l.slice(kind.length + 1)));
  const send = over => ctl('/send', Object.assign({ id: uid(), chat: '王小明', chatId: WANG, build: BUILD, owner: 's1' }, over)).then(r => r.body);
  const take = async pg => (await pg.get('/poll', '&wait=3000')).body.items[0];
  // The page's part of one send: take it, ask, press Enter, report.
  const pageSends = async (pg, outcome = { ok: true }) => {
    const got = await take(pg);
    const go = (await pg.post('/commit', { id: got.id })).body;
    await pg.post('/sent', Object.assign({ id: got.id, chat: got.chat, chatId: got.chatId, text: got.text }, outcome));
    return { got, go };
  };

  console.log('--- what is on the port ---');
  check('ping needs no secret and says what is listening', pick((await request(base, 'GET', '/ping', {})).body, ['pong', 'hub', 'api']), { pong: true, hub: 'line-bridge', api: 1 });
  const second = await startHub({ dir: tmp, port }).then(() => 'bound', e => e.code);
  check('a second hub on the same port fails to bind', second, 'EADDRINUSE');
  check('...and the first still answers', (await ctl('/state')).status, 200);
  check('a request addressed to another host name is refused', (await raw('GET', '/ping', { host: 'evil.example:' + port })).status, 403);

  console.log('--- who may call ---');
  check('a control endpoint without the secret -> 403', (await ctl('/state', undefined, '')).status, 403);
  check('...with the page token -> 403', (await ctl('/send', { id: uid(), chat: '王小明', chatId: WANG, text: 'x' }, pageToken)).status, 403);
  check('a page endpoint with the control secret -> 403', (await pageOf('px', 1, base, () => controlSecret).get('/poll')).status, 403);
  const foreign = await raw('GET', '/poll?i=px&l=1&b=' + BUILD, { [TOKEN_HEADER]: pageToken, origin: 'https://example.com' });
  check('a page endpoint called from another web origin -> 403, token or not', foreign.status, 403);
  const ext = await raw('POST', '/result?i=px&l=1&b=' + BUILD, { [TOKEN_HEADER]: pageToken, origin: EXT_ORIGIN, 'content-type': 'application/json' }, '{"id":"nothing-open"}');
  check('the LINE extension is answered, and named instead of *', [ext.status, ext.headers['access-control-allow-origin']], [200, EXT_ORIGIN]);
  const pre = await raw('OPTIONS', '/poll', { origin: EXT_ORIGIN, 'access-control-request-headers': TOKEN_HEADER });
  check('its preflight allows the token header', [pre.status, pre.headers['access-control-allow-headers'].includes(TOKEN_HEADER)], [204, true]);
  check('a control endpoint refuses any web origin, the extension included',
    (await raw('GET', '/state', { [TOKEN_HEADER]: controlSecret, origin: EXT_ORIGIN })).status, 403);
  const big5 = await raw('POST', '/send', { [TOKEN_HEADER]: controlSecret, 'content-type': 'application/json' }, Buffer.from([0xa7, 0x41, 0xa6, 0x6e]));
  check('a body that is not UTF-8 JSON -> 400, not a crash', [big5.status, (await ctl('/state')).status], [400, 200]);

  console.log('--- no page yet ---');
  check('a send with no page linked is refused at once', pick(await send({ text: '還沒連上' }), ['ok', 'notSent']), { ok: false, notSent: true });
  check('...and so is an op', pick((await ctl('/call', { id: uid(), op: 'status', build: BUILD })).body, ['ok', 'notReady']), { ok: false, notReady: true });

  console.log('--- a page links; one op, there and back ---');
  const P1 = pageOf('p1', 1000);
  check('the page announces itself', pick((await P1.post('/log', { event: 'linked', header: '王小明', chat: WANG })).body, ['ok']), { ok: true });
  check('...and the hub serves it', pick((await ctl('/state')).body.page, ['instance', 'build', 'live']), { instance: 'p1', build: BUILD, live: true });
  const statusCall = ctl('/call', { id: uid(), op: 'status', args: {}, build: BUILD, owner: 's1' });
  const op = await take(P1);
  check('the page is handed the op', pick(op, ['kind', 'op', 'args']), { kind: 'op', op: 'status', args: {} });
  await P1.post('/result', { id: op.id, ok: true, value: { header: '王小明', chat: WANG, note: 'PRIVATE-MARKER', list: [{ name: '王小明', chat: WANG }, { name: '李大明', chat: LEE }] } });
  check('the caller gets the page\'s answer', pick((await statusCall).body, ['ok']), { ok: true });
  check('an op answer is not written to the log', logLines().some(l => l.includes('PRIVATE-MARKER')), false);
  check('an op outside the whitelist is refused', (await ctl('/call', { id: uid(), op: 'eval', args: { code: '1' }, build: BUILD })).status, 400);
  check('a page running another build gets no work but status',
    pick((await ctl('/call', { id: uid(), op: 'read', build: 'build-2' })).body, ['ok', 'notReady']), { ok: false, notReady: true });
  const oldBuildStatus = ctl('/call', { id: uid(), op: 'status', build: 'build-2' });
  const op2 = await take(P1);
  await P1.post('/result', { id: op2.id, ok: true, value: { header: '王小明', chat: WANG, list: [{ name: '王小明', chat: WANG }, { name: '李大明', chat: LEE }] } });
  check('...status still goes through', (await oldBuildStatus).body.ok, true);
  check('...and a send does not', pick(await send({ text: '舊版頁面', build: 'build-2' }), ['ok', 'notSent']), { ok: false, notSent: true });

  console.log('--- a send, there and back ---');
  check('a chat id the page never reported is refused', pick(await send({ chatId: 'UsameNameOtherChat', text: '同名的另一個人' }), ['ok', 'notSent']), { ok: false, notSent: true });
  check('...and so is a name that does not go with the id', (await send({ chat: '李大明', text: '名字不對' })).notSent, true);
  check('a multi-line text is refused', (await send({ text: 'a\nb' })).notSent, true);
  const hello = send({ text: '你好' });
  const sent = await pageSends(P1);
  check('the page is handed the message, bound to its chat', pick(sent.got, ['kind', 'chat', 'chatId', 'text', 'direct']), { kind: 'send', chat: '王小明', chatId: WANG, text: '你好', direct: true });
  check('...is told to go ahead', sent.go, { go: true });
  check('...and its report reaches the caller', pick(await hello, ['ok', 'text']), { ok: true, text: '你好' });
  check('the log says SENT', logged('SENT').slice(-1).map(e => [e.id, e.text]), [[sent.got.id, '你好']]);
  check('a second go for the same message is refused', (await P1.post('/commit', { id: sent.got.id })).body.go, false);
  check('an id is never run twice', (await ctl('/send', { id: sent.got.id, chat: '王小明', chatId: WANG, text: '同一個 id', build: BUILD })).status, 409);
  check('the same text to the same chat again is refused', pick(await send({ text: '你好' }), ['ok', 'notSent', 'duplicate']), { ok: false, notSent: true, duplicate: true });
  const twice = send({ text: '你好', allowDuplicate: true });
  await pageSends(P1);
  check('...unless the caller says so', (await twice).ok, true);
  const failedOnce = send({ text: '第一次沒送成' });
  await pageSends(P1, { ok: false, notSent: true, why: 'the user is typing' });
  check('a definite notSent comes back as such', pick(await failedOnce, ['ok', 'notSent', 'why']), { ok: false, notSent: true, why: 'the user is typing' });
  const retried = send({ text: '第一次沒送成' });
  await pageSends(P1);
  check('...and frees the text for another try', (await retried).ok, true);
  const noted = send({ text: '視窗沒切回去' });
  await pageSends(P1, { ok: true, restored: false, restoreWhy: 'the message box is not empty' });
  check('what the page says about the window travels with the result', pick(await noted, ['ok', 'restored', 'restoreWhy']), { ok: true, restored: false, restoreWhy: 'the message box is not empty' });

  console.log('--- at most once, and never late ---');
  const slow = send({ text: '只交付一次' });
  const once = await take(P1);
  skew += 61000;   // relay.py would lease it out again after 60 s
  check('a message handed to the page is not offered again', (await P1.get('/poll')).body.items, []);
  skew = 0;
  await P1.post('/commit', { id: once.id });
  await P1.post('/sent', { id: once.id, chat: once.chat, chatId: once.chatId, text: once.text, ok: true });
  check('...and still finishes normally', (await slow).ok, true);

  const unpicked = await send({ text: '沒人來拿', commitMs: 150, reportMs: 50 });
  check('never picked up -> a definite notSent', pick(unpicked, ['ok', 'notSent', 'unconfirmed']), { ok: false, notSent: true, unconfirmed: undefined });
  check('...and it is withdrawn', (await P1.get('/poll')).body.items, []);

  const stalled = send({ text: '拿了但沒送', commitMs: 150, reportMs: 50 });
  const held = await take(P1);
  check('picked up but not ready in time -> a definite notSent', pick(await stalled, ['ok', 'notSent']), { ok: false, notSent: true });
  check('...and a late request to send gets no go', (await P1.post('/commit', { id: held.id })).body.go, false);

  const late = send({ text: '超過時限才要送' });
  const lateItem = await take(P1);
  skew += 80000;
  check('asking to send after the time limit -> no go', (await P1.post('/commit', { id: lateItem.id })).body.go, false);
  check('...and the caller hears notSent at once, not after its own timeout', [await settled(late, 1000), (await late).notSent], [true, true]);
  skew = 0;

  const silent = send({ text: '按了之後沒消息', commitMs: 300, reportMs: 100 });
  const silentItem = await take(P1);
  check('a go...', (await P1.post('/commit', { id: silentItem.id })).body, { go: true });
  check('...without a report -> unconfirmed, not notSent', pick(await silent, ['ok', 'unconfirmed', 'notSent']), { ok: false, unconfirmed: true, notSent: undefined });
  await P1.post('/sent', { id: silentItem.id, chat: silentItem.chat, chatId: silentItem.chatId, text: silentItem.text, ok: true });
  check('...and the report that comes later is still logged', logged('SENT').slice(-1).map(e => [e.id, e.late]), [[silentItem.id, true]]);

  const mixed = send({ text: '對的那一則' });
  const mixedItem = await take(P1);
  await P1.post('/commit', { id: mixedItem.id });
  await P1.post('/sent', { id: mixedItem.id, chat: '王小明', chatId: WANG, text: '別的文字', ok: true });
  check('a report about another text does not close the message', await settled(mixed), false);
  await P1.post('/sent', { id: mixedItem.id, chat: '王小明', chatId: WANG, text: '對的那一則', ok: true });
  check('...the right one does', (await mixed).ok, true);

  const gone = new AbortController();
  const hungUp = ctl('/send', { id: uid(), chat: '王小明', chatId: WANG, text: '呼叫端先走了', build: BUILD }, controlSecret, gone.signal).catch(e => e.name);
  await sleep(100);
  gone.abort();
  await hungUp;
  await sleep(100);
  check('a caller that hangs up before the page took it: withdrawn', [(await P1.get('/poll')).body.items, logged('SENDFAIL').slice(-1)[0].text], [[], '呼叫端先走了']);
  const gone2 = new AbortController();
  const hungUpLater = ctl('/send', { id: uid(), chat: '王小明', chatId: WANG, text: '拿走之後呼叫端才走', build: BUILD }, controlSecret, gone2.signal).catch(e => e.name);
  const orphan = await take(P1);
  gone2.abort();
  await hungUpLater;
  await sleep(100);
  check('a caller that hangs up after the page took it, before the go: no go', (await P1.post('/commit', { id: orphan.id })).body.go, false);

  console.log('--- two pages ---');
  const handover = send({ text: '換頁之前拿走的' });
  const taken = await take(P1);
  const oldPoll = P1.get('/poll', '&wait=5000');   // the old page is waiting for work
  await sleep(50);
  const P2 = pageOf('p2', 2000);
  await P2.post('/log', { event: 'linked', header: '王小明', chat: WANG });
  check('a page linked later takes over', (await ctl('/state')).body.page.instance, 'p2');
  const answered = await settled(oldPoll, 1000);   // asked first: a poll left waiting must fail this check, not hang it
  check('...the older one\'s waiting poll is answered with stop, not left to take the next item', [answered, answered ? (await oldPoll).status : null], [true, 409]);
  check('...and the older one is told to stop', (await P1.get('/poll')).status, 409);
  check('...but may finish what it had taken', (await P1.post('/commit', { id: taken.id })).body, { go: true });
  await P1.post('/sent', { id: taken.id, chat: taken.chat, chatId: taken.chatId, text: taken.text, ok: true });
  check('...its report closing the message', (await handover).ok, true);
  check('a page linked earlier that turns up afterwards is refused', (await pageOf('p0', 500).get('/poll')).status, 409);
  check('what the old page reported about chats is forgotten', (await send({ chat: '李大明', chatId: LEE, text: '新頁面還沒回報過' })).notSent, true);

  console.log('--- auto-replies only inside what was approved ---');
  const reply = over => ctl('/reply', Object.assign({ id: uid(), chat: '王小明', chatId: WANG, build: BUILD, owner: 's1' }, over)).then(r => r.body);
  const approve = (maxReplies, minutes, chats = [{ name: '王小明', chatId: WANG }], owner = 's1') => ctl('/grant', { owner, chats, maxReplies, minutes });
  const left = async () => (await ctl('/state')).body.grants[0].remaining;
  check('a reply without an approval is refused', pick(await reply({ text: '自動回覆' }), ['ok', 'notSent', 'noGrant']), { ok: false, notSent: true, noGrant: true });
  const following = ctl('/call', { id: uid(), op: 'follow', args: { names: ['王小明', '李大明'] }, build: BUILD, owner: 's1' });
  const followOp = await take(P2);
  await P2.post('/result', { id: followOp.id, ok: true, value: { chats: [{ name: '王小明', chat: WANG, ignored: 3 }, { name: '李大明', chat: LEE, ignored: 0 }] } });
  await following;
  check('a follow that worked is remembered and logged',
    [(await ctl('/state')).body.follow, logged('FOLLOW').slice(-1)[0].chats.length], [[{ name: '王小明', chatId: WANG }, { name: '李大明', chatId: LEE }], 2]);
  check('an approval for a chat the page never reported is refused', (await approve(1, 10, [{ name: '王小明', chatId: 'UsameNameOtherChat' }])).status, 400);
  check('an approval: one reply, ten minutes', pick((await approve(1, 10)).body, ['ok', 'remaining']), { ok: true, remaining: 1 });
  check('...is not for another chat', (await reply({ chat: '李大明', chatId: LEE, text: '給別人' })).noGrant, true);
  check('...nor for another session', (await reply({ owner: 's2', text: '別的 session' })).noGrant, true);
  check('...nor for a long text', pick(await reply({ text: 'x'.repeat(501) }), ['ok', 'notSent']), { ok: false, notSent: true });
  const three = [reply({ text: '第一個' }), reply({ text: '第二個' }), reply({ text: '第三個' })];
  const theOne = await pageSends(P2);
  const outcomes = await Promise.all(three);
  check('one approved reply, three asked at once: one goes out',
    [outcomes.filter(o => o.ok).length, outcomes.filter(o => o.noGrant).length, theOne.got.direct], [1, 2, false]);
  check('...and nothing else is waiting for the page', (await P2.get('/poll')).body.items, []);
  await approve(1, 10);
  const refunded = reply({ text: '沒送成的回覆' });
  await pageSends(P2, { ok: false, notSent: true, why: 'the user is typing' });
  await refunded;
  check('a reply that definitely did not go out gives its unit back', await left(), 1);
  const maybe = reply({ text: '不知道有沒有送出', commitMs: 300, reportMs: 100 });
  await P2.post('/commit', { id: (await take(P2)).id });
  check('a reply that may have gone out keeps its unit', [pick(await maybe, ['ok', 'unconfirmed']), await left()], [{ ok: false, unconfirmed: true }, 0]);
  await approve(5, 1);
  skew += 61000;
  check('after the approved time, replies are refused', (await reply({ text: '太晚了' })).noGrant, true);
  skew = 0;
  await approve(5, 10);
  const onItsWay = reply({ text: '送到一半核准被收回' });
  const caught = await take(P2);
  await ctl('/revoke', { owner: 's1' });
  check('an approval taken back while a reply is on its way: no go', [(await P2.post('/commit', { id: caught.id })).body.go, (await onItsWay).notSent], [false, true]);
  await approve(5, 10);
  check('an approval can be taken back', [(await ctl('/revoke', { owner: 's1' })).body.revoked, (await reply({ text: '已經撤銷' })).noGrant], [true, true]);

  console.log('--- the hub says what is followed ---');
  check('every answer to a poll names the followed chats', (await P2.get('/poll')).body.follow, [WANG, LEE]);
  check('a session that merely ends does not take down a follow that is not its own',
    [(await ctl('/revoke', { owner: 's2', unfollow: true, onlyOwn: true })).body.unfollowed, (await P2.get('/poll')).body.follow], [false, [WANG, LEE]]);
  const stop = (await ctl('/revoke', { owner: 's2', unfollow: true, why: 'line_unfollow' })).body;
  check('any session can say stop: the hub no longer lists the chats, and logs why',
    [stop.unfollowed, (await P2.get('/poll')).body.follow, pick(logged('FOLLOW').slice(-1)[0], ['chats', 'why'])], [true, [], { chats: [], why: 'line_unfollow' }]);
  const following2 = async () => {
    const asked = ctl('/call', { id: uid(), op: 'follow', args: { names: ['王小明', '李大明'] }, build: BUILD, owner: 's1' });
    const it = await take(P2);
    await P2.post('/result', { id: it.id, ok: true, value: { chats: [{ name: '王小明', chat: WANG, ignored: 3 }, { name: '李大明', chat: LEE, ignored: 0 }] } });
    return asked;
  };
  // An op whose caller stops waiting while the page is still at it.
  const giveUp =ctl('/call', { id: uid(), op: 'follow', args: { names: ['王小明'] }, build: BUILD, owner: 's1', waitMs: 150 });
  const lateFollow = await take(P2);
  check('the caller of an op gives up before the page answers', pick((await giveUp).body, ['ok', 'delivered']), { ok: false, delivered: true });
  await P2.post('/result', { id: lateFollow.id, ok: true, value: { chats: [{ name: '王小明', chat: WANG, ignored: 1 }] } });
  check('...a late "following" is not taken up: the hub lists nothing, so the page will drop it', (await P2.get('/poll')).body.follow, []);
  await following2();
  const giveUp2 = ctl('/call', { id: uid(), op: 'unfollow', args: {}, build: BUILD, owner: 's1', waitMs: 150 });
  const lateUnfollow = await take(P2);
  await giveUp2;
  await P2.post('/result', { id: lateUnfollow.id, ok: true, value: { chats: [] } });
  check('...a late "unfollowed" is: the page did stop', [(await P2.get('/poll')).body.follow, logged('FOLLOW').slice(-1)[0].late], [[], true]);
  // A session that set up a follow and then vanished (a closed window, a crash).
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'line-bridge-hub-'));
  const port3 = await freePort();
  const hub3 = await startHub({ dir: tmp3, port: port3, downAfterMs: 30000, ownerGoneMs: 400 });
  const s3 = readSecrets(tmp3), base3 = 'http://127.0.0.1:' + port3;
  const R = pageOf('r1', 1000, base3, () => s3.pageToken);
  const ctl3 = (p, body) => request(base3, body === undefined ? 'GET' : 'POST', p,
    Object.assign({ [TOKEN_HEADER]: s3.controlSecret }, json(body)), body === undefined ? undefined : JSON.stringify(body));
  const followAs = async owner => {
    const asked = ctl3('/call', { id: uid(), op: 'follow', args: { names: ['王小明'] }, owner });
    const it = await take(R);
    await R.post('/result', { id: it.id, ok: true, value: { chats: [{ name: '王小明', chat: WANG, ignored: 1 }] } });
    return (await asked).body.ok;
  };
  await R.post('/log', { event: 'linked', header: '王小明', chat: WANG });
  await followAs('alive');
  for (let i = 0; i < 8; i++) { await sleep(100); await ctl3('/state?owner=alive'); }
  check('a follow whose session keeps saying it is there goes on', (await R.get('/poll')).body.follow, [WANG]);
  await ctl3('/grant', { owner: 'alive', chats: [{ name: '王小明', chatId: WANG }], maxReplies: 3, minutes: 10 });
  await sleep(900);   // ...and then the session is gone
  check('a follow whose session has gone quiet is ended, and the log says why',
    [(await R.get('/poll')).body.follow, /gone quiet/.test(logged('FOLLOW', tmp3).slice(-1)[0].why)], [[], true]);
  check('...and its approval for auto-replies goes with it', (await ctl3('/state')).body.grants, []);
  // The log file becomes unwritable (here: a directory takes its place).
  fs.rmSync(path.join(tmp3, 'events.log'));
  fs.mkdirSync(path.join(tmp3, 'events.log'));
  await R.post('/in', { chat: '王小明', chatId: WANG, selectId: 'x-1', ts: 1, kind: 'text', text: '記錄檔寫不進去' });
  check('a log that cannot be written does not take the hub down: the event still reaches a reader, and the trouble is reported',
    [typeof (await ctl3('/state')).body.events.error, (await ctl3('/events?after=0')).body.events.some(e => e.kind === 'IN' && e.data.text === '記錄檔寫不進去'),
      typeof (await ctl3('/events?after=0')).body.error],
    ['string', true, 'string']);
  await hub3.close();

  console.log('--- events ---');
  const all = (await ctl('/events?after=0')).body;
  check('events come with a seq that only grows', [all.events.length > 5, all.events.every((e, i) => i === 0 || e.seq > all.events[i - 1].seq), all.cursor], [true, true, all.events.slice(-1)[0].seq]);
  check('without a cursor, only what comes next', (await ctl('/events')).body.events, []);
  const waiting = ctl('/events?after=' + all.cursor + '&wait=5000');
  const waitFrom = Date.now();
  await sleep(50);
  await P2.post('/in', { chat: '王小明', chatId: WANG, selectId: '01-900', ts: 1790000000000, time: '10:00', sender: '王小明', kind: 'text', text: '在嗎' });
  const woke = (await waiting).body;
  check('a waiting reader is answered when a message comes in', [woke.events.map(e => [e.kind, e.data.text, e.data.chatId]), Date.now() - waitFrom < 1500], [[['IN', '在嗎', WANG]], true]);
  check('every line of the log is "KIND {json}" with its seq, and the count is known',
    [logLines().every(l => /^[A-Z]+ \{.*"seq":\d+.*\}$/.test(l)), (await ctl('/state')).body.events.lines], [true, logLines().length]);

  console.log('--- waiting on the hub instead of on timers ---');
  const longPoll = P2.get('/poll', '&wait=5000');
  const pollFrom = Date.now();
  await sleep(50);
  const whenAsked = ctl('/call', { id: uid(), op: 'status', build: BUILD });
  const pushed = (await longPoll).body.items[0];
  check('a held poll is answered the moment there is work', [pushed.op, Date.now() - pollFrom < 1500], ['status', true]);
  await P2.post('/result', { id: pushed.id, ok: true, value: {} });
  await whenAsked;
  const older = P2.get('/poll', '&wait=5000');
  await sleep(50);
  const newer = P2.get('/poll', '&wait=200');
  check('a second poll releases the first', [await settled(older, 1000), (await newer).body.items], [true, []]);
  const napFrom = Date.now();
  await P2.get('/wait', '&ms=200');
  const nap = Date.now() - napFrom;
  check('/wait answers after about the time asked', [nap >= 150, nap < 1500], [true, true]);

  console.log('--- a page that goes quiet ---');
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'line-bridge-hub-'));
  const port2 = await freePort();
  const hub2 = await startHub({ dir: tmp2, port: port2, downAfterMs: 300 });
  const secrets2 = readSecrets(tmp2);
  const base2 = 'http://127.0.0.1:' + port2;
  let token2 = secrets2.pageToken;
  const Q = pageOf('q1', 1000, base2, () => token2);
  const ctl2 = (p, body) => request(base2, body === undefined ? 'GET' : 'POST', p,
    Object.assign({ [TOKEN_HEADER]: secrets2.controlSecret }, json(body)), body === undefined ? undefined : JSON.stringify(body));
  await Q.post('/log', { event: 'linked', header: '王小明', chat: WANG });
  check('rotating the page token is refused while a page uses it', (await ctl2('/rotate', {})).body.rotated, false);
  await sleep(700);
  check('DOWN is logged once when the page stops polling', logged('DOWN', tmp2).length, 1);
  check('...and sends are refused until it is back', (await ctl2('/send', { id: uid(), chat: '王小明', chatId: WANG, text: '頁面不見了' })).body.notSent, true);
  check('the page token can be rotated now', (await ctl2('/rotate', {})).body.rotated, true);
  check('...the old one stops working', (await Q.get('/poll')).status, 403);
  token2 = readSecrets(tmp2).pageToken;
  check('...the new one is in the file', [token2 !== secrets2.pageToken, (await Q.get('/poll')).status], [true, 200]);
  check('UP is logged when a page polls again', logged('UP', tmp2).length, 1);
  await hub2.close();

  console.log('--- shutting down and coming back ---');
  const cut = ctl('/call', { id: uid(), op: 'status', build: BUILD }).then(r => r.body);
  await sleep(100);
  const seqBefore = (await ctl('/state')).body.events.seq, epochBefore = hub.epoch;
  await hub.close();
  check('closing answers whoever was still waiting', [(await cut).ok, /shutting down/.test((await cut).why)], [false, true]);
  hub = await startHub({ dir: tmp, port, now, downAfterMs: 30000 });
  const back = (await ctl('/state')).body;
  check('the port is free again, and a new hub is a new epoch', [back.hub.epoch !== epochBefore, back.page], [true, null]);
  check('...the seq goes on from the log', back.events.seq, seqBefore + 1);
  check('...the secrets are the same, so a linked page reconnects', readSecrets(tmp), { pageToken, controlSecret });
  check('...and the page that polls is adopted without a new paste', [(await P2.get('/poll')).status, (await ctl('/state')).body.page.instance, logged('PAGE').slice(-1)[0].event], [200, 'p2', 'adopted']);
  await hub.close();

  for (const d of [tmp, tmp2, tmp3]) fs.rmSync(d, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
