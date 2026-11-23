// node tests/run.mjs     offline checks, plus a full upload against a local mock of the YouTube API
// (no Google account or network needed; nothing is sent to YouTube)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------- mock YouTube API

const mock = { meta: null, received: [], failures: [], playlistItems: [], thumbnails: [], updates: [], tokens: 0, sessions: 0 };
const VIDEO_ID = 'Abc_def-123';

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const url = new URL(req.url, 'http://x');
  const json = (status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
  const authed = /^Bearer tok-\d+$/.test(req.headers.authorization ?? '');

  if (url.pathname === '/token') { mock.tokens++; return json(200, { access_token: `tok-${mock.tokens}`, expires_in: 3600 }); }
  if (!authed) return json(401, { error: { code: 401, message: 'bad token', errors: [{ reason: 'authError' }] } });

  if (req.method === 'POST' && url.pathname === '/upload/youtube/v3/videos') {
    assert.equal(url.searchParams.get('uploadType'), 'resumable');
    mock.meta = JSON.parse(body.toString());
    mock.size = Number(req.headers['x-upload-content-length']);
    mock.notify = url.searchParams.get('notifySubscribers');
    mock.received = [];
    mock.sessions++;
    res.writeHead(200, { Location: `http://127.0.0.1:${server.address().port}/session/${mock.sessions}` });
    return res.end();
  }
  if (req.method === 'PUT' && url.pathname.startsWith('/session/')) {
    const got = () => mock.received.reduce((n, b) => n + b.length, 0);
    const have = got();
    const range = req.headers['content-range'];
    const finished = () => json(200, { id: VIDEO_ID, snippet: { title: mock.meta.snippet.title }, status: { ...mock.meta.status, uploadStatus: 'uploaded' } });
    const partial = () => { const n = got(); res.writeHead(308, n ? { Range: `bytes=0-${n - 1}` } : {}); res.end(); };
    if (range === `bytes */${mock.size}`) return have === mock.size ? finished() : partial();
    const [, start] = range.match(/bytes (\d+)-(\d+)\/(\d+)/).map(Number);
    const next = mock.failures.shift();
    if (next === 'drop') return req.socket.destroy();
    if (next) return json(next, { error: { code: next, message: `injected ${next}`, errors: [{ reason: 'injected' }] } });
    if (start === have) mock.received.push(body);
    const now = mock.received.reduce((n, b) => n + b.length, 0);
    return now === mock.size ? finished() : partial();
  }
  if (req.method === 'GET' && url.pathname === '/youtube/v3/playlists') {
    return json(200, { items: [
      { id: 'PLaaa', snippet: { title: 'Vlogs' }, status: { privacyStatus: 'public' }, contentDetails: { itemCount: 3 } },
      { id: 'PLbbb', snippet: { title: 'Vlogs 2025' }, status: { privacyStatus: 'public' }, contentDetails: { itemCount: 1 } },
    ] });
  }
  if (req.method === 'POST' && url.pathname === '/youtube/v3/playlistItems') { mock.playlistItems.push(JSON.parse(body.toString())); return json(200, {}); }
  if (req.method === 'POST' && url.pathname === '/upload/youtube/v3/thumbnails/set') {
    mock.thumbnails.push({ id: url.searchParams.get('videoId'), type: req.headers['content-type'], bytes: body.length });
    return json(200, {});
  }
  if (req.method === 'GET' && url.pathname === '/youtube/v3/videos') {
    return json(200, { items: [{ id: VIDEO_ID,
      snippet: { title: 'Old title', description: 'old', tags: ['a'], categoryId: '22', channelId: 'UCx', thumbnails: {} },
      status: { privacyStatus: 'private', publishAt: '2099-01-01T00:00:00Z', embeddable: true, license: 'youtube', publicStatsViewable: true, selfDeclaredMadeForKids: false, uploadStatus: 'processed' } }] });
  }
  if (req.method === 'PUT' && url.pathname === '/youtube/v3/videos') {
    const b = JSON.parse(body.toString());
    mock.updates.push({ part: url.searchParams.get('part'), body: b });
    return json(200, b);
  }
  json(404, { error: { code: 404, message: `mock has no ${req.method} ${url.pathname}` } });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const home = await mkdtemp(join(tmpdir(), 'ytupload-test-'));
await writeFile(join(home, 'client_secret.json'), JSON.stringify({ installed: { client_id: 'cid', client_secret: 'secret', token_uri: `${base}/token` } }));
await writeFile(join(home, 'token.json'), JSON.stringify({ refresh_token: 'r', access_token: 'expired', expires_at: 0 }));
process.env.YTUPLOAD_HOME = home;
process.env.YTUPLOAD_API_BASE = base;
process.env.YTUPLOAD_CHUNK = String(256 * 1024);
process.env.YTUPLOAD_RETRY_MS = '5';

const yt = await import('../scripts/ytupload.mjs');

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`); }
}
const quiet = { json: true };   // suppresses the progress lines

// ---------------------------------------------------------------- offline helpers

await check('parseArgs keeps boolean flags from eating the file name', () => {
  const { pos, opt } = yt.parseArgs(['upload', '--dry-run', 'a.mp4', '--title', '標題 x', '--no-notify']);
  assert.deepEqual(pos, ['upload', 'a.mp4']);
  assert.deepEqual(opt, { 'dry-run': true, title: '標題 x', 'no-notify': true });
  assert.throws(() => yt.parseArgs(['--title']), /needs a value/);
});

await check('videoId accepts ids and every common link', () => {
  for (const s of ['Abc_def-123', 'https://youtu.be/Abc_def-123', 'https://www.youtube.com/watch?v=Abc_def-123&t=3',
    'https://studio.youtube.com/video/Abc_def-123/edit', 'https://youtube.com/shorts/Abc_def-123', 'https://www.youtube.com/live/Abc_def-123?si=x']) {
    assert.equal(yt.videoId(s), 'Abc_def-123', s);
  }
  assert.throws(() => yt.videoId('https://www.youtube.com/@channel'), /not a YouTube video/);
});

await check('splitTags and tagsLength follow YouTube counting', () => {
  assert.deepEqual(yt.splitTags('vlog, 台北，旅遊、Vlog,,'), ['vlog', '台北', '旅遊']);
  assert.equal(yt.tagsLength(['ab', 'c d']), 2 + (3 + 2) + 1);
  assert.equal(yt.tagsLength([]), 0);
});

await check('validateMetadata limits', () => {
  const ok = { title: 'x', description: '' }, st = { privacyStatus: 'public' };
  yt.validateMetadata(ok, st);
  assert.throws(() => yt.validateMetadata({ title: '  ' }, st), /title is empty/);
  assert.throws(() => yt.validateMetadata({ title: 'a'.repeat(101) }, st), /101 characters/);
  yt.validateMetadata({ title: '字'.repeat(100) }, st);
  assert.throws(() => yt.validateMetadata({ title: 'a <b>' }, st), /< or >/);
  assert.throws(() => yt.validateMetadata({ title: 'x', description: '字'.repeat(1667) }, st), /5001 bytes/);
  assert.throws(() => yt.validateMetadata({ title: 'x', tags: Array(100).fill('abcde') }, st), /add up to 599/);
  assert.throws(() => yt.validateMetadata(ok, { privacyStatus: 'public', publishAt: '2099-01-01T00:00:00Z' }), /stay private/);
});

await check('applyOptions: scheduling forces private and clears on publish', async () => {
  const now = Date.parse('2026-10-23T00:00:00Z');
  const sn = { title: 't' }, st = { privacyStatus: 'private' };
  await yt.applyOptions(sn, st, { 'publish-at': '2026-11-01T20:00+08:00', tags: 'a,b', kids: 'no', synthetic: 'yes' }, now);
  assert.equal(st.publishAt, '2026-11-01T12:00:00.000Z');
  assert.equal(st.privacyStatus, 'private');
  assert.equal(st.containsSyntheticMedia, true);
  assert.deepEqual(sn.tags, ['a', 'b']);
  await yt.applyOptions(sn, st, { privacy: 'public' }, now);
  assert.equal(st.publishAt, undefined);
  await assert.rejects(yt.applyOptions({ title: 't' }, { privacyStatus: 'private' }, { privacy: 'public', 'publish-at': '2026-11-01T20:00' }, now), /keeps the video private/);
  await assert.rejects(yt.applyOptions({ title: 't' }, { privacyStatus: 'private' }, { 'publish-at': '2026-01-01T00:00Z' }, now), /not in the future/);
  await assert.rejects(yt.applyOptions({ title: 't' }, { privacyStatus: 'private' }, { kids: 'maybe' }, now), /yes or no/);
});

await check('parseWhen reads "YYYY-MM-DD HH:MM" as local time', () => {
  const d = yt.parseWhen('2030-05-06 07:08', 0);
  assert.equal(d.getFullYear(), 2030);
  assert.equal(d.getHours(), 7);
  assert.equal(d.getMinutes(), 8);
});

await check('nextOffset and mimeFor', () => {
  assert.equal(yt.nextOffset('bytes=0-524287'), 524288);
  assert.equal(yt.nextOffset(null), 0);
  assert.equal(yt.mimeFor('C:\\v\\A.MP4'), 'video/mp4');
  assert.equal(yt.mimeFor('x.mov'), 'video/quicktime');
  assert.equal(yt.mimeFor('x.unknown'), 'application/octet-stream');
});

// ---------------------------------------------------------------- against the mock

const video = join(home, 'clip one.mp4');
const data = randomBytes(256 * 1024 * 5 + 1234);   // 6 chunks, the last one short
await writeFile(video, data);
const thumb = join(home, 'thumb.jpg');
await writeFile(thumb, randomBytes(5000));
const sessions = () => readdir(join(home, 'sessions')).catch(() => []);

await check('dry run validates without contacting YouTube', async () => {
  const before = mock.tokens;
  const r = await yt.upload(video, { 'dry-run': true, privacy: 'unlisted', tags: 'x' });
  assert.equal(r.dryRun, true);
  assert.equal(r.snippet.title, 'clip one');
  assert.equal(r.status.privacyStatus, 'unlisted');
  assert.equal(mock.tokens, before);
});

await check('upload survives a 503 and a dropped connection, then adds playlist and thumbnail', async () => {
  mock.failures = [undefined, 503, 'drop'];
  const r = await yt.upload(video, { ...quiet, title: '測試影片', description: 'line 1\nline 2', privacy: 'public', playlist: 'vlogs', thumbnail: thumb, 'no-notify': true, language: 'zh-TW' });
  assert.equal(r.id, VIDEO_ID);
  assert.equal(r.privacy, 'public');
  assert.deepEqual(r.warnings, []);
  assert.ok(Buffer.concat(mock.received).equals(data), 'the bytes YouTube received match the file');
  assert.equal(mock.meta.snippet.title, '測試影片');
  assert.equal(mock.meta.snippet.defaultAudioLanguage, 'zh-TW');
  assert.equal(mock.meta.status.selfDeclaredMadeForKids, false);
  assert.equal(mock.notify, 'false');
  assert.equal(mock.playlistItems[0].snippet.playlistId, 'PLaaa', '"vlogs" matches "Vlogs" exactly, not "Vlogs 2025"');
  assert.deepEqual(mock.thumbnails[0], { id: VIDEO_ID, type: 'image/jpeg', bytes: 5000 });
  assert.deepEqual(await sessions(), [], 'the session file is removed after success');
});

await check('a failed upload resumes from where it stopped on the next run', async () => {
  mock.failures = [undefined, undefined, 400];
  const before = mock.sessions;
  await assert.rejects(yt.upload(video, { ...quiet, title: 'resume me' }), /HTTP 400/);
  assert.equal((await sessions()).length, 1, 'the session is kept for the next run');
  const partial = mock.received.reduce((n, b) => n + b.length, 0);
  assert.equal(partial, 2 * 256 * 1024);
  const r = await yt.upload(video, { ...quiet, title: 'resume me' });
  assert.equal(r.resumed, true);
  assert.equal(mock.sessions, before + 1, 'no second upload session was started');
  assert.ok(Buffer.concat(mock.received).equals(data));
  assert.deepEqual(await sessions(), []);
});

await check('changing the metadata starts a fresh upload instead of resuming', async () => {
  mock.failures = [400];
  await assert.rejects(yt.upload(video, { ...quiet, title: 'first' }));
  const before = mock.sessions;
  const r = await yt.upload(video, { ...quiet, title: 'second' });
  assert.equal(r.resumed, false);
  assert.equal(mock.sessions, before + 1);
  assert.equal(mock.meta.snippet.title, 'second');
});

await check('ambiguous playlist stops before anything is uploaded', async () => {
  const before = mock.sessions;
  await assert.rejects(yt.upload(video, { ...quiet, playlist: 'vlog' }), /more than one playlist[\s\S]*PLbbb/);
  assert.equal(mock.sessions, before);
});

await check('a privacy YouTube did not honor becomes a warning', async () => {
  // The mock echoes what it was sent, so fake a lock by editing the reply.
  const orig = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    const end = res.end.bind(res);
    res.end = chunk => {
      if (req.method === 'PUT' && req.url.startsWith('/session/') && res.statusCode === 200 && chunk) {
        const v = JSON.parse(chunk); v.status.privacyStatus = 'private'; chunk = JSON.stringify(v);
      }
      return end(chunk);
    };
    orig(req, res);
  });
  try {
    const r = await yt.upload(video, { ...quiet, title: 'locked?', privacy: 'public' });
    assert.equal(r.privacy, 'private');
    assert.match(r.warnings[0], /not "public"/);
  } finally {
    server.removeAllListeners('request');
    server.on('request', orig);
  }
});

await check('update sends whole parts and clears a schedule when publishing now', async () => {
  const r = await yt.update(`https://youtu.be/${VIDEO_ID}`, { privacy: 'public' });
  const u = mock.updates.at(-1);
  assert.equal(u.part, 'status');
  assert.equal(u.body.status.privacyStatus, 'public');
  assert.equal(u.body.status.publishAt, undefined);
  assert.equal(u.body.status.license, 'youtube', 'untouched status fields are sent back');
  assert.equal(u.body.snippet, undefined);
  assert.equal(r.privacy, 'public');
  await yt.update(VIDEO_ID, { title: 'New title' });
  const u2 = mock.updates.at(-1);
  assert.equal(u2.part, 'snippet');
  assert.deepEqual(u2.body.snippet, { title: 'New title', description: 'old', tags: ['a'], categoryId: '22' });
});

server.close();
await rm(home, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
