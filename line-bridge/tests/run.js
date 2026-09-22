// Validate scripts/extract-dom.js against a fixture that mirrors the real LINE DOM.
// The markup is transcribed from the real extension; names, ids and message
// text are placeholders.
//   cd tests && npm install && npm test
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'tests', 'fixture.html'), 'utf8');
const dom = new JSDOM(`<!doctype html><body>${html}</body>`);

global.window = dom.window;
global.document = dom.window.document;
global.MutationObserver = dom.window.MutationObserver;

const src = fs.readFileSync(path.join(root, 'scripts', 'extract-dom.js'), 'utf8');
eval(src);                          // the file assigns globalThis.LINEX
const X = globalThis.LINEX;

const rows = X.collect();
const summary = X.summarize(rows);

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`FAIL ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${name}`);
};

console.log('--- summary ---');
console.log(summary);
console.log('--- checks ---');

check('message count', rows.length, 9);
check('reply count', summary.replies, 2);
check('reacted count', summary.reacted, 1);
check('sorted ascending', rows.map(r => r.ts).every((t, i, a) => i === 0 || t === null || a[i-1] === null || a[i-1] <= t), true);

const reply = rows.find(r => r.id === '900000000000000001');
check('reply.sender', reply.sender, '王小明');
check('reply.senderMid', reply.senderMid, 'UexampleFriend000000000000000000000000000000');
check('reply.direction', reply.direction, 'incoming');
check('reply.kind', reply.kind, 'text');
check('reply.text', reply.text, '可以啊八點OK我開車');
check('reply.replyTo.sender', reply.replyTo.sender, '李小華');
check('reply.replyTo.senderMid', reply.replyTo.senderMid, 'UexampleSelf00000000000000000000000000000000');
check('reply.replyTo.text (multi-line preserved)', reply.replyTo.text, '週末要不要去爬山\n天氣預報說會放晴\n記得帶水\n早上八點集合如何');
check('reply.replyTo.kind', reply.replyTo.kind, 'text');
check('reply.read (no 已讀)', reply.read, false);
check('reply.e2ee', reply.e2ee, true);
check('reply.datetime', reply.datetime, 'Sat Sep 12 2026 11:02:49 GMT+0800 (台北標準時間)');

const plain = rows.find(r => r.id === '900000000000000002');
check('plain.direction', plain.direction, 'outgoing');
check('plain.sender', plain.sender, '李小華');
check('plain.read (已讀)', plain.read, true);
check('plain.replyTo absent', plain.replyTo, undefined);
check('plain multi-line text', plain.text, '週末要不要去爬山\n天氣預報說會放晴\n記得帶水\n早上八點集合如何');

// the quoted text of the reply must equal the body of the message it quotes
check('quote matches original body', reply.replyTo.text, plain.text);

const sys = rows.find(r => r.kind === 'system');
check('system message', sys.text, '以下為尚未閱讀的訊息');

const link = rows.find(r => r.id === '900000000000000003');
check('link.kind', link.kind, 'text');
check('link.urls', link.urls, ['https://example.com/post?id=42&ref=chat']);
check('link.preview.title', link.preview.title, 'Example Speaker');
check('link.preview emoji restored from alt', /💡/.test(link.preview.description), true);

const sticker = rows.find(r => r.id === '900000000000000004');
check('sticker.kind', sticker.kind, 'sticker');
check('sticker.productId', sticker.sticker.productId, '16692909');
check('sticker.e2ee false', sticker.e2ee, false);

const replySticker = rows.find(r => r.id === '900000000000000005');
check('reply-with-sticker-body kind', replySticker.kind, 'sticker');
check('reply-with-sticker-body quote text', replySticker.replyTo.text, '先把報告寫完再說');
check('reply-with-sticker-body quote sender', replySticker.replyTo.sender, '王小明');

const img = rows.find(r => r.id === '900000000000000006');
check('image.kind', img.kind, 'image');

const call = rows.find(r => r.id === '900000000000000007');
check('call.kind', call.kind, 'call');
check('call.duration', call.duration, '00:14');

const reacted = rows.find(r => r.id === '900000000000000008');
check('reacted.text', reacted.text, '好啊 都可以');
check('reacted.reactions (popover button not counted)', reacted.reactions, [{
  url: 'https://stickershop.line-scdn.net/sticonshop/v1/sticon/6124aa4ae72c607c18108562/android/020_animation.png',
  productId: '6124aa4ae72c607c18108562',
  sticonId: '020',
}]);
// message 1 carries an EMPTY bubble list, which must not produce the key
check('empty reaction list -> no reactions key', reply.reactions, undefined);

// date separators must attach to the messages beneath them
check('date derived from ts, not separator', rows.find(r => r.id === '900000000000000003').date, '2026-09-10');
check('date of 9/12 reply', rows.find(r => r.id === '900000000000000001').date, '2026-09-12');

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
