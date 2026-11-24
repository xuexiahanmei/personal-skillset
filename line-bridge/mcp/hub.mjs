// The line-bridge hub: a local HTTP server between the LINE Chrome extension page
// (scripts/send-dom.js, LINESEND.relay.link) and the MCP server(s) in server.mjs.
// node: builtins only.
//
// Two sets of endpoints, two secrets:
//   page      /poll /wait /in /sent /result /commit /log     header = page token
//   control   /state /call /send /reply /grant /revoke /events /rotate
//                                                            header = control secret
//   /ping     no secret; says what is listening, nothing else
// The page token is pasted into the page; the control secret never leaves this
// machine's processes. A request carrying an Origin is answered only when that
// origin is the LINE extension, and never on a control endpoint.
//
// What keeps a message from going out twice (or late):
//   - ids come from the caller and are never reused;
//   - an item is handed to the page once - there is no lease that runs out;
//   - the page asks POST /commit before it presses Enter, and gets a go only
//     while the caller still waits and the time limit has not passed.
// So a send that timed out before its go is a definite notSent, and only a go
// without a report is "unconfirmed".
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const API = 1;
export const DEFAULT_PORT = 38766;   // relay.py, the older path, keeps 38765
export const EXT_ORIGIN = 'chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc';
export const TOKEN_HEADER = 'x-line-bridge-token';

const COMMIT_MS = 75_000;     // a send must reach its Enter within this
const REPORT_MS = 8_000;      // ...and its result is waited for this much longer
const RUN_MS = 60_000;        // an op must be picked up within this
const MAX_WAIT_MS = 100_000;  // Claude Code moves a tool call to the background at 2 minutes
const POLL_HOLD_MS = 25_000;
const SLEEP_MAX_MS = 5_000;
const EVENTS_HOLD_MS = 50_000;
const DUP_MS = 120_000;       // the same text to the same chat inside this is refused
const KEEP_MS = 7 * 86_400_000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const BODY_MAX_BYTES = 32 * 1024 * 1024;
const RING = 500;
const REPLY_MAX_CHARS = 500;
const TEXT_MAX_CHARS = 10_000;
const OPS = new Set(['status', 'read', 'follow', 'unfollow']);
const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ITEM_ID = /^[A-Za-z0-9-]{8,64}$/;
const PAGE_PATHS = new Set(['/poll', '/wait', '/in', '/sent', '/result', '/commit', '/log']);
const CONTROL_PATHS = new Set(['/state', '/call', '/send', '/reply', '/grant', '/revoke', '/events', '/rotate']);
const CORS = {
  'Access-Control-Allow-Origin': EXT_ORIGIN,
  'Vary': 'Origin',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, ' + TOKEN_HEADER,
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '600',
};

// The page compares a bubble's text the same way (send-dom.js, norm).
export const norm = s => String(s == null ? '' : s).normalize('NFC')
  .replace(/[\u200B\u200C\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();

const clamp = (n, lo, hi) => Math.min(Math.max(Number(n) || 0, lo), hi);
const same = (a, b) => typeof a === 'string' && a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (status, message) => Object.assign(new Error(message), { status });

// Where the private files live and which port to use. Refuses anything that
// could put a conversation inside a repository.
export function resolveConfig(env = process.env) {
  const raw = env.LINE_BRIDGE_DIR || (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'line-bridge') : '');
  if (!raw) throw new Error('no data directory: LOCALAPPDATA is not set; set LINE_BRIDGE_DIR to an absolute path');
  if (!path.isAbsolute(raw)) throw new Error('LINE_BRIDGE_DIR must be an absolute path, got ' + JSON.stringify(raw));
  const dir = path.resolve(raw);
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) {
      throw new Error('the data directory ' + dir + ' is inside a git work tree (' + d + '); logs and tokens must stay out of repositories');
    }
    if (path.dirname(d) === d) break;
  }
  const port = env.LINE_BRIDGE_PORT ? Number(env.LINE_BRIDGE_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('LINE_BRIDGE_PORT must be a port number between 1024 and 65535, got ' + JSON.stringify(env.LINE_BRIDGE_PORT));
  }
  // A test that forgot to pass its own port would talk to the user's real LINE page.
  if (env.LINE_BRIDGE_TEST === '1' && port === DEFAULT_PORT) {
    throw new Error('LINE_BRIDGE_TEST=1 refuses the real port ' + DEFAULT_PORT + '; set LINE_BRIDGE_PORT');
  }
  return { dir, port };
}

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Created once, with "wx": two processes starting together end up with one value.
function ensureSecret(file) {
  try {
    fs.writeFileSync(file, crypto.randomBytes(16).toString('hex'), { flag: 'wx', encoding: 'ascii' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  for (let i = 0; i < 20; i++) {
    const s = fs.readFileSync(file, 'ascii').trim();
    if (/^[0-9a-f]{32}$/.test(s)) return s;
    pause(10);   // another process is still writing it
  }
  throw new Error(file + ' does not hold a 32-character hex secret; delete it to have a new one made');
}

export function readSecrets(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return {
    pageToken: ensureSecret(path.join(dir, 'page.token')),
    controlSecret: ensureSecret(path.join(dir, 'control.secret')),
  };
}

// "<KIND> <json>" lines, as relay.py writes them, each with a seq so a reader
// can pick up where it stopped.
function openEvents(file, now) {
  let seq = 0, lines = 0;
  try {
    const st = fs.statSync(file);
    const all = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    // The seq goes on from the last line, also into a fresh file.
    for (let i = all.length - 1; i >= 0 && !seq; i--) {
      try { seq = Number(JSON.parse(all[i].slice(all[i].indexOf(' ') + 1)).seq) || 0; } catch (e) { /* a torn line */ }
    }
    if (st.size > LOG_MAX_BYTES || st.mtimeMs < now() - KEEP_MS) fs.renameSync(file, file + '.1');
    else lines = all.length;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const ring = [], waiting = new Set();
  let broken = null;
  return {
    file,
    get seq() { return seq; },
    get lines() { return lines; },
    get error() { return broken; },
    // The line is flat, "<KIND> {seq, at, ...data}"; a reader of /events gets
    // { seq, at, kind, data }, since the page's data has a `kind` of its own.
    emit(kind, data) {
      const stamp = { seq: ++seq, at: new Date(now()).toISOString() };
      // Called from timers too: a full disk or a locked file must not take the
      // hub down with a message in flight. The event still reaches /events.
      try {
        fs.appendFileSync(file, kind + ' ' + JSON.stringify(Object.assign({}, stamp, data, stamp)) + '\n', 'utf8');
        lines++;
        broken = null;
      } catch (e) {
        broken = String(e && e.message || e);
      }
      ring.push(Object.assign({ kind, data }, stamp));
      if (ring.length > RING) ring.shift();
      for (const w of Array.from(waiting)) w();
      return stamp;
    },
    since(after) {
      const out = { events: ring.filter(e => e.seq > after), cursor: seq };
      if (ring.length && after < ring[0].seq - 1) out.gap = true;   // older ones are only in the file
      return out;
    },
    onNext(fn) { waiting.add(fn); return () => waiting.delete(fn); },
  };
}

function prune(dir, now) {
  const dumps = path.join(dir, 'dumps');
  let names = [];
  try { names = fs.readdirSync(dumps); } catch (e) { return; }
  for (const n of names) {
    const p = path.join(dumps, n);
    try { if (fs.statSync(p).mtimeMs < now() - KEEP_MS) fs.unlinkSync(p); } catch (e) { /* in use, or gone */ }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > BODY_MAX_BYTES) { reject(fail(413, 'body too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const data = text ? JSON.parse(text) : {};
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
        resolve(data);
      } catch (e) {
        reject(fail(400, 'body must be a UTF-8 JSON object: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

function reply(res, status, obj, origin) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store',
  };
  res.writeHead(status, origin === EXT_ORIGIN ? Object.assign(headers, CORS) : headers);
  res.end(body);
}

// Binds 127.0.0.1:<port> and resolves once it listens; rejects with the listen
// error (EADDRINUSE when another hub has the port). Nothing is written to disk
// before the port is ours.
export function startHub({ dir, port, now = Date.now, downAfterMs = 90_000, ownerGoneMs = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.removeListener('error', reject);
      try {
        resolve(run(server, { dir, port, now, downAfterMs, ownerGoneMs }));
      } catch (e) {
        server.close();
        reject(e);
      }
    });
  });
}

function run(server, { dir, port, now, downAfterMs, ownerGoneMs }) {
  fs.mkdirSync(path.join(dir, 'dumps'), { recursive: true });
  let { pageToken, controlSecret } = readSecrets(dir);
  prune(dir, now);
  const events = openEvents(path.join(dir, 'events.log'), now);
  const epoch = crypto.randomUUID();
  const startedAt = now();

  let page = null;            // { instance, linkedAt, build }: the one page the hub serves
  let lastSeen = 0, down = false;
  let held = null;            // the page's waiting GET /poll
  const known = new Map();    // chat id -> display name, as this page reported them
  let follow = [], followOwner = null;
  const grants = new Map();   // owner -> { chats: Map(chat id -> name), remaining, expiresAt }
  const items = new Map();    // id -> item still open (queued | delivered | committed)
  const closed = new Map();   // id -> true, so an id is never run twice
  const recent = new Map();   // chatId + '\n' + text -> { at, id }: the duplicate guard
  const gone = new Map();     // id -> op: handed to the page, given up on before it answered
  const owners = new Map();   // owner (a session) -> when it was last heard from

  const sawOwner = o => { if (o) owners.set(String(o), now()); };
  // What every answer to a poll carries: who answers, and which chats the page may follow.
  const polled = list => ({ epoch, follow: follow.map(c => c.chatId), items: list });
  const pageLive = () => !!page && lastSeen > 0 && now() - lastSeen <= downAfterMs;
  const learn = (chatId, name) => {
    if (typeof chatId === 'string' && CHAT_ID.test(chatId) && typeof name === 'string' && name) known.set(chatId, name);
  };

  // ---- which page ----
  // The most recently linked page wins, also across a hub restart: `l` is the
  // page's own clock at link time. An older one is told to stop (409).
  function sawPage(q, announce) {
    const instance = q.get('i'), linkedAt = Number(q.get('l')) || 0, build = q.get('b') || null;
    if (!instance) return false;
    if (!page || (instance !== page.instance && linkedAt > page.linkedAt)) {
      page = { instance, linkedAt, build };
      known.clear();
      const hadFollow = follow.length > 0;
      follow = [];
      followOwner = null;
      // The older page's waiting poll must not be handed the next item.
      if (held) {
        const h = held;
        held = null;
        clearTimeout(h.timer);
        reply(h.res, 409, { error: 'superseded' }, h.origin);
      }
      if (announce) events.emit('PAGE', { event: 'adopted', instance, build, followCleared: hadFollow });
    }
    if (page.instance !== instance) return false;
    page.build = build;
    lastSeen = now();
    if (down) { down = false; events.emit('UP', {}); }
    return true;
  }

  // ---- the duplicate guard ----
  // A claim per accepted send of a text to a chat, newest first; `earlier` is the
  // send that allow_duplicate went past. Each message only ever drops its own.
  const claimKey = (chatId, text) => chatId + '\n' + norm(text);
  function dropClaim(key, id) {
    let node = recent.get(key), newer = null;
    while (node && node.id !== id) { newer = node; node = node.earlier; }
    if (!node) return false;
    if (newer) newer.earlier = node.earlier;
    else if (node.earlier) recent.set(key, node.earlier);
    else recent.delete(key);
    return true;
  }
  const hasClaim = (key, id) => { for (let n = recent.get(key); n; n = n.earlier) if (n.id === id) return true; return false; };

  // ---- items ----
  // pageSaid: the result is the page's own report.
  function settle(item, result, { pageSaid = false } = {}) {
    if (!items.has(item.id)) return;
    clearTimeout(item.timer);
    items.delete(item.id);
    let free = false;
    if (item.kind === 'send') {
      // Only a notSent that cannot be wrong frees the text for another try: one
      // the page reported (it looked at the box), or one for a message the page
      // never had. When the hub itself gives up on a message the page holds, the
      // page may have typed it, and the user's own Enter can still send it: the
      // claim stays until the page says what became of it (a late report), or
      // for its two minutes.
      free = !!result.notSent && (pageSaid || item.state === 'queued');
      if (free) dropClaim(claimKey(item.chatId, item.text), item.id);
      if (item.grant && free) item.grant.remaining++;
    }
    // What a late report needs: the approval to give a reply back to, when it
    // turns out that nothing went out.
    closed.set(item.id, item.kind === 'send' && !free && item.grant ? { grant: item.grant } : true);
    if (closed.size > 2000) closed.delete(closed.keys().next().value);
    if (item.kind !== 'send' && item.state === 'delivered' && !item.answered) {
      // The page may still be running it: remember which op, for when it answers.
      gone.set(item.id, item.op);
      if (gone.size > 200) gone.delete(gone.keys().next().value);
    }
    item.resolve(result);
  }

  function open(item, waitMs) {
    return new Promise(resolve => {
      item.resolve = resolve;
      item.state = 'queued';
      items.set(item.id, item);
      item.timer = setTimeout(() => onDeadline(item), waitMs);
      if (held) {
        const h = held;
        held = null;
        clearTimeout(h.timer);
        deliver(h.res, h.origin, item);
      }
    });
  }

  function onDeadline(item) {
    if (item.kind === 'op') {
      return settle(item, {
        ok: false, delivered: item.state !== 'queued',
        why: item.state === 'queued'
          ? 'the LINE page did not pick this up in time (last seen ' + Math.round((now() - lastSeen) / 1000) + ' s ago)'
          : 'the LINE page took this but did not answer in time',
      });
    }
    const base = { id: item.id, chat: item.chat, chatId: item.chatId, text: item.text, ok: false, by: 'hub' };
    const result = item.state === 'committed'
      ? Object.assign(base, { unconfirmed: true, why: 'Enter was allowed but no result came back - read the chat before sending it again' })
      : Object.assign(base, { notSent: true, why: item.state === 'queued'
        ? 'the LINE page did not pick the message up in time; nothing was typed'
        : 'the LINE page took the message but was not ready to send it in time; it will not be sent' });
    events.emit('SENDFAIL', result);
    settle(item, result);
  }

  // The caller hung up: nobody is waiting for the answer any more.
  function abandon(item) {
    if (!items.has(item.id)) return;
    if (item.state === 'committed') return;   // Enter was allowed: keep it for the late report
    if (item.kind === 'send') {
      events.emit('SENDFAIL', { id: item.id, chat: item.chat, chatId: item.chatId, text: item.text, ok: false, notSent: true, by: 'hub', why: 'the caller went away before the message was sent' });
    }
    settle(item, { ok: false, notSent: true, why: 'the caller went away' });
  }

  const publicItem = it => it.kind === 'op'
    ? { id: it.id, kind: 'op', op: it.op, args: it.args, runBy: it.runBy }
    : { id: it.id, kind: 'send', chat: it.chat, chatId: it.chatId, text: it.text, direct: it.direct };

  // Handed out once. If this answer never reaches the page, the item simply runs
  // into its deadline: for a send that is a definite notSent, since no go was given.
  function deliver(res, origin, item) {
    item.state = 'delivered';
    item.instance = page && page.instance;
    lastSeen = now();
    reply(res, 200, polled([publicItem(item)]), origin);
  }

  const nextQueued = () => { for (const it of items.values()) if (it.state === 'queued') return it; return null; };

  // ---- page endpoints ----
  function handlePoll(req, res, q, origin) {
    if (!sawPage(q, true)) return reply(res, 409, { error: 'superseded' }, origin);
    if (held) {   // one poll at a time: answer the older one
      const h = held;
      held = null;
      clearTimeout(h.timer);
      reply(h.res, 200, polled([]), h.origin);
    }
    const item = nextQueued();
    if (item) return deliver(res, origin, item);
    const wait = clamp(q.get('wait'), 0, POLL_HOLD_MS);
    if (!wait) return reply(res, 200, polled([]), origin);
    const h = { res, origin };
    h.timer = setTimeout(() => {
      if (held !== h) return;
      held = null;
      lastSeen = now();
      reply(res, 200, polled([]), origin);
    }, wait);
    res.on('close', () => { if (held === h) { held = null; clearTimeout(h.timer); } });
    held = h;
  }

  function handleCommit(body) {
    const it = items.get(body.id);
    if (!it || it.kind !== 'send') return { go: false, why: 'the relay no longer waits for this message; it was not sent' };
    if (it.state !== 'delivered') return { go: false, why: 'this message was already ' + it.state };
    // The last moment anything can be called off: after a go the Enter is the page's.
    let why = null;
    if (now() >= it.commitBy) {
      why = 'the LINE page was ready to send only after the time limit (is its window hidden or minimised?); not sent';
    } else if (it.grant && grants.get(it.owner) !== it.grant) {
      why = 'the approval for auto-replies was taken back before this one was sent; not sent';
    }
    if (why) {
      const result = { id: it.id, chat: it.chat, chatId: it.chatId, text: it.text, ok: false, notSent: true, by: 'hub', why };
      events.emit('SENDFAIL', result);
      settle(it, result);
      return { go: false, why };
    }
    it.state = 'committed';
    return { go: true };
  }

  function report(body) {
    const r = { id: String(body.id), chat: String(body.chat || ''), chatId: String(body.chatId || ''), text: String(body.text || ''), ok: body.ok === true };
    if (body.notSent === true) r.notSent = true;
    if (body.unconfirmed === true) r.unconfirmed = true;
    if (typeof body.why === 'string') r.why = body.why.slice(0, 500);
    if (typeof body.restored === 'boolean') r.restored = body.restored;
    if (typeof body.restoreWhy === 'string') r.restoreWhy = body.restoreWhy.slice(0, 200);
    return r;
  }

  // Reports are taken from any page instance: the one that pressed Enter may
  // have been replaced by a fresh paste before it could say so.
  function handleSent(body) {
    const r = report(body);
    const it = items.get(body.id);
    if (it && it.kind === 'send') {
      if (r.chatId !== it.chatId || norm(r.text) !== norm(it.text)) {
        events.emit('PAGE', { event: 'report-mismatch', id: r.id });
        return { ok: true };
      }
      events.emit(r.ok ? 'SENT' : 'SENDFAIL', r);
      settle(it, r, { pageSaid: true });
    } else {
      // The hub restarted, or stopped waiting: still the truth about that message,
      // and what the duplicate guard goes by. Taken back: the claim the hub kept
      // for it can go. Went out, or may have: it counts against sending it again
      // - whatever the caller was told meanwhile.
      if (CHAT_ID.test(r.chatId) && r.text) {
        const key = claimKey(r.chatId, r.text), at = now();
        if (r.notSent) {
          if (dropClaim(key, r.id)) {
            const c = closed.get(r.id);
            if (c && c.grant) c.grant.remaining++;
          }
        } else if (!hasClaim(key, r.id)) {
          const head = recent.get(key);
          recent.set(key, { at, id: r.id, earlier: head && at - head.at < DUP_MS ? head : null });
        }
      }
      events.emit(r.ok ? 'SENT' : 'SENDFAIL', Object.assign(r, { late: true }));
    }
    return { ok: true };
  }

  function handleResult(body) {
    const it = items.get(body.id);
    if (!it || it.kind !== 'op') {
      // An answer to an op nobody waits for any more. A late "unfollowed" is
      // true whoever hears it. A late "following" is not taken up: the hub does
      // not list those chats, so the page drops them at its next poll.
      const op = gone.get(body.id);
      gone.delete(body.id);
      if (op === 'unfollow' && body.ok === true && follow.length) {
        follow = [];
        followOwner = null;
        events.emit('FOLLOW', { chats: [], late: true });
      }
      return { ok: true };
    }
    it.answered = true;
    const ok = body.ok === true;
    const value = body.value && typeof body.value === 'object' ? body.value : {};
    if (ok) {
      if (it.op === 'status') {
        learn(value.chat, value.header);
        for (const row of Array.isArray(value.list) ? value.list : []) learn(row && row.chat, row && row.name);
      } else if (it.op === 'read') {
        learn(value.chat, value.header);
      } else if (it.op === 'follow') {
        const chats = (Array.isArray(value.chats) ? value.chats : []).filter(c => c && CHAT_ID.test(c.chat || ''));
        for (const c of chats) learn(c.chat, c.name);
        follow = chats.map(c => ({ name: String(c.name), chatId: c.chat }));
        followOwner = it.owner;
        sawOwner(it.owner);   // the visit can take a while; its owner is not gone for having waited
        events.emit('FOLLOW', { owner: it.owner, chats: follow });
      } else if (it.op === 'unfollow') {
        follow = [];
        followOwner = null;
        events.emit('FOLLOW', { owner: it.owner, chats: [] });
      }
    }
    settle(it, ok ? { ok: true, value } : { ok: false, delivered: true, why: String(body.why || 'the page refused').slice(0, 500), value });
    return { ok: true };
  }

  function handleLog(body, q) {
    const fresh = !page || page.instance !== q.get('i');
    if (!sawPage(q, false)) return null;
    if (body.event === 'linked') learn(body.chat, body.header);
    if (body.event === 'unfollowed') { follow = []; followOwner = null; }
    events.emit('PAGE', Object.assign({}, body, fresh ? { instance: page.instance } : null));
    return { ok: true, epoch };
  }

  // ---- control endpoints ----
  function notReady(body, op) {
    if (!pageLive()) {
      return page
        ? 'the LINE page has not been heard from for ' + Math.round((now() - lastSeen) / 1000) + ' s - is the extension window still open? Run line_setup and paste again if it was reloaded'
        : 'no LINE page is linked - run line_setup and paste into the extension console';
    }
    if (body.build && page.build !== body.build && op !== 'status') {
      return 'the script in the LINE page is not the current one - run line_setup and paste again';
    }
    return null;
  }

  function takeId(body) {
    if (typeof body.id !== 'string' || !ITEM_ID.test(body.id)) throw fail(400, 'id must be 8-64 letters, digits or dashes');
    if (items.has(body.id) || closed.has(body.id)) throw fail(409, 'this id was already used; ids are never run twice');
    return body.id;
  }

  function handleCall(body, res) {
    const id = takeId(body);
    if (!OPS.has(body.op)) throw fail(400, 'op must be one of ' + Array.from(OPS).join(', '));
    const why = notReady(body, body.op);
    if (why) return { ok: false, delivered: false, notReady: true, why };
    const runMs = clamp(body.runMs || RUN_MS, 100, RUN_MS);
    const item = {
      id, kind: 'op', op: body.op, owner: String(body.owner || ''),
      args: body.args && typeof body.args === 'object' ? body.args : {}, runBy: now() + runMs,
    };
    res.on('close', () => { if (!res.writableEnded) abandon(item); });
    return open(item, clamp(body.waitMs || runMs + 30_000, 100, MAX_WAIT_MS));
  }

  function sendItem(body, res, { direct, grant, commitBy }) {
    const id = takeId(body);
    const { chat, chatId, text } = body;
    const refuse = why => ({ id, chat, chatId, text, ok: false, notSent: true, why });
    if (typeof text !== 'string' || !text.trim()) return refuse('empty text');
    if (/[\r\n]/.test(text)) return refuse('one line per message: send each line on its own');
    if (text.length > TEXT_MAX_CHARS) return refuse('text is longer than ' + TEXT_MAX_CHARS + ' characters');
    if (typeof chat !== 'string' || !chat || typeof chatId !== 'string' || !CHAT_ID.test(chatId)) {
      return refuse('chat (the display name) and chatId are both required');
    }
    const why = notReady(body);
    if (why) return refuse(why);
    // A display name is not an identity: only a pair this page reported is accepted.
    if (known.get(chatId) !== chat) {
      return refuse('this page has not reported a chat ' + JSON.stringify(chat) + ' with id ' + chatId + ' - take both from line_status or line_read');
    }
    const key = claimKey(chatId, text);
    const before = recent.get(key);
    if (before && now() - before.at < DUP_MS && !(direct && body.allowDuplicate === true)) {
      return Object.assign(refuse('the same text was sent to this chat ' + Math.round((now() - before.at) / 1000) +
        ' s ago (or its outcome is not known yet) - read the chat first' + (direct ? '; allow_duplicate sends it anyway' : '')), { duplicate: true });
    }
    if (grant) grant.remaining--;   // taken now, so parallel replies cannot overspend
    // `earlier`: the send this one was allowed to repeat, should this one end notSent.
    recent.set(key, { at: now(), id, earlier: before && now() - before.at < DUP_MS ? before : null });
    for (const [k, v] of recent) if (now() - v.at >= DUP_MS) recent.delete(k);
    const item = { id, kind: 'send', chat, chatId, text, direct, grant, owner: String(body.owner || ''), commitBy };
    res.on('close', () => { if (!res.writableEnded) abandon(item); });
    return open(item, clamp(commitBy - now() + clamp(body.reportMs || REPORT_MS, 50, REPORT_MS), 100, MAX_WAIT_MS));
  }

  function handleSend(body, res) {
    return sendItem(body, res, { direct: true, grant: null, commitBy: now() + clamp(body.commitMs || COMMIT_MS, 50, COMMIT_MS) });
  }

  // An auto-reply: honoured only inside what the user approved in line_follow.
  function handleReply(body, res) {
    const refuse = (why, noGrant = true) => Object.assign(
      { id: body.id, chat: body.chat, chatId: body.chatId, text: body.text, ok: false, notSent: true, why },
      noGrant ? { noGrant: true } : null);
    const g = grants.get(String(body.owner || ''));
    if (!g) return refuse('no auto-reply is approved for this session - line_follow with auto_reply asks the user');
    if (now() >= g.expiresAt) return refuse('the approved time for auto-replies has run out');
    if (g.chats.get(body.chatId) !== body.chat) return refuse('auto-replies were not approved for this chat');
    if (g.remaining <= 0) return refuse('the approved number of auto-replies is used up');
    if (typeof body.text === 'string' && body.text.length > REPLY_MAX_CHARS) {
      return refuse('an auto-reply is at most ' + REPLY_MAX_CHARS + ' characters', false);
    }
    const commitBy = Math.min(now() + clamp(body.commitMs || COMMIT_MS, 50, COMMIT_MS), g.expiresAt);
    return sendItem(body, res, { direct: false, grant: g, commitBy });
  }

  function handleGrant(body) {
    const owner = String(body.owner || '');
    const chats = new Map();
    for (const c of Array.isArray(body.chats) ? body.chats : []) {
      if (!c || known.get(c.chatId) !== c.name) throw fail(400, 'grant: unknown chat ' + JSON.stringify(c && c.name));
      chats.set(c.chatId, c.name);
    }
    const remaining = clamp(body.maxReplies, 0, 200), minutes = clamp(body.minutes, 0, 720);
    if (!owner || !chats.size || !remaining || !minutes) throw fail(400, 'grant needs owner, chats, maxReplies (1-200) and minutes (1-720)');
    const g = { chats, remaining, expiresAt: now() + minutes * 60_000 };
    grants.set(owner, g);
    events.emit('GRANT', { owner, chats: Array.from(chats, ([chatId, name]) => ({ chatId, name })), remaining, expiresAt: new Date(g.expiresAt).toISOString() });
    return { ok: true, remaining, expiresAt: g.expiresAt };
  }

  function handleEvents(res, q) {
    const from = q.has('after') ? Number(q.get('after')) || 0 : events.seq;   // no cursor: only what comes next
    const wait = clamp(q.get('wait'), 0, EVENTS_HOLD_MS);
    const send = () => reply(res, 200, Object.assign(events.since(from), { file: events.file, lines: events.lines },
      events.error ? { error: events.error } : null));
    if (events.seq > from || !wait) return send();
    let timer = null;
    const off = events.onNext(() => { off(); clearTimeout(timer); send(); });
    timer = setTimeout(() => { off(); send(); }, wait);
    res.on('close', () => { off(); clearTimeout(timer); });
  }

  // A new page token makes every copy of the old one (clipboard history, an old
  // paste) useless. Not while a page is using it.
  function handleRotate() {
    if (pageLive()) return { rotated: false, why: 'a LINE page is linked with the current token' };
    const file = path.join(dir, 'page.token');
    pageToken = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(file, pageToken, 'ascii');
    page = null;
    known.clear();
    follow = [];
    followOwner = null;
    return { rotated: true };
  }

  const state = () => ({
    hub: { name: 'line-bridge', api: API, pid: process.pid, epoch, dir, port, startedAt },
    page: page ? {
      instance: page.instance, build: page.build, linkedAt: page.linkedAt, live: pageLive(), down,
      lastSeenAgoMs: lastSeen ? now() - lastSeen : null,
    } : null,
    follow, followOwner,
    grants: Array.from(grants, ([owner, g]) => ({
      owner, remaining: g.remaining, expiresAt: g.expiresAt,
      chats: Array.from(g.chats, ([chatId, name]) => ({ chatId, name })),
    })),
    open: items.size,
    events: Object.assign({ file: events.file, seq: events.seq, lines: events.lines }, events.error ? { error: events.error } : null),
  });

  // Stop following. A session that says stop means it for the one LINE window
  // there is, whoever asked for the follow; a session that merely ends
  // (onlyOwn) takes down only a follow of its own. The page drops its list at
  // its next poll, which no longer names those chats.
  function handleRevoke(body) {
    const owner = String(body.owner || '');
    const out = { ok: true, revoked: grants.delete(owner), unfollowed: false };
    if (body.unfollow === true && follow.length && !(body.onlyOwn === true && followOwner !== owner)) {
      follow = [];
      followOwner = null;
      out.unfollowed = true;
      events.emit('FOLLOW', { owner, chats: [], why: typeof body.why === 'string' ? body.why.slice(0, 100) : 'asked to stop' });
    }
    return out;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname, q = url.searchParams, origin = req.headers.origin;
    // A name that resolves to 127.0.0.1 is not us (DNS rebinding).
    if (req.headers.host !== '127.0.0.1:' + port) return reply(res, 403, { error: 'host' });

    if (PAGE_PATHS.has(p)) {
      if (origin !== undefined && origin !== EXT_ORIGIN) return reply(res, 403, { error: 'origin' });
      if (req.method === 'OPTIONS') { res.writeHead(204, origin ? CORS : {}); return res.end(); }
      if (!same(req.headers[TOKEN_HEADER], pageToken)) return reply(res, 403, { error: 'token' }, origin);
      if (req.method === 'GET' && p === '/poll') return handlePoll(req, res, q, origin);
      if (req.method === 'GET' && p === '/wait') {
        if (page && page.instance === q.get('i')) lastSeen = now();
        return void setTimeout(() => reply(res, 200, { ok: true }, origin), clamp(q.get('ms'), 0, SLEEP_MAX_MS));
      }
      if (req.method !== 'POST') return reply(res, 405, { error: 'method' }, origin);
      const body = await readBody(req);
      if (p === '/commit') return reply(res, 200, handleCommit(body), origin);
      if (p === '/sent') return reply(res, 200, handleSent(body), origin);
      if (p === '/result') return reply(res, 200, handleResult(body), origin);
      if (p === '/log') {
        const out = handleLog(body, q);
        return out ? reply(res, 200, out, origin) : reply(res, 409, { error: 'superseded' }, origin);
      }
      if (p === '/in') {
        if (!sawPage(q, true)) return reply(res, 409, { error: 'superseded' }, origin);
        learn(body.chatId, body.chat);
        events.emit('IN', body);
        return reply(res, 200, { ok: true }, origin);
      }
      return reply(res, 404, { error: 'no such path' }, origin);
    }

    if (origin !== undefined) return reply(res, 403, { error: 'origin' });
    if (p === '/ping' && req.method === 'GET') return reply(res, 200, { pong: true, hub: 'line-bridge', api: API, pid: process.pid });
    if (!CONTROL_PATHS.has(p)) return reply(res, 404, { error: 'no such path' });
    if (!same(req.headers[TOKEN_HEADER], controlSecret)) return reply(res, 403, { error: 'token' });
    if (req.method === 'GET') sawOwner(q.get('owner'));   // a session saying it is still there
    if (req.method === 'GET' && p === '/state') return reply(res, 200, state());
    if (req.method === 'GET' && p === '/events') return handleEvents(res, q);
    if (req.method !== 'POST') return reply(res, 405, { error: 'method' });
    const body = await readBody(req);
    sawOwner(body.owner);
    if (p === '/call') return reply(res, 200, await handleCall(body, res));
    if (p === '/send') return reply(res, 200, await handleSend(body, res));
    if (p === '/reply') return reply(res, 200, await handleReply(body, res));
    if (p === '/grant') return reply(res, 200, handleGrant(body));
    if (p === '/revoke') return reply(res, 200, handleRevoke(body));
    if (p === '/rotate') return reply(res, 200, handleRotate());
    return reply(res, 404, { error: 'no such path' });
  }

  server.on('request', (req, res) => {
    handle(req, res).catch(e => {
      const origin = req.headers.origin;
      reply(res, e && e.status || 500, { error: String(e && e.message || e) }, origin === EXT_ORIGIN ? origin : undefined);
    });
  });

  // Silence is not success: say so once when the page stops polling. And a
  // follow whose session has gone (a window closed, a crash) is ended: the page
  // would otherwise keep opening chats, marking them read, for nobody.
  const tickMs = Math.min(5000, downAfterMs / 3, ownerGoneMs / 3);
  let lastTick = now();
  const watchdog = setInterval(() => {
    const t = now();
    // The machine slept, or the clock jumped: nobody could have said anything
    // meanwhile. Count from here.
    if (t - lastTick > 3 * tickMs) for (const o of owners.keys()) owners.set(o, t);
    lastTick = t;
    if (lastSeen && !down && t - lastSeen > downAfterMs) {
      down = true;
      events.emit('DOWN', { lastSeenAgoSec: Math.round((t - lastSeen) / 1000) });
    }
    const quiet = o => t - (owners.get(o) || 0) > ownerGoneMs;
    if (followOwner && quiet(followOwner)) {
      const owner = followOwner;
      follow = [];
      followOwner = null;
      events.emit('FOLLOW', { owner, chats: [], why: 'the session that asked has gone quiet' });
    }
    for (const [o, g] of grants) if (quiet(o) || t >= g.expiresAt) grants.delete(o);
    for (const o of owners.keys()) if (quiet(o)) owners.delete(o);
  }, tickMs);
  watchdog.unref();

  events.emit('START', { port, pid: process.pid, epoch });

  return {
    port, dir, epoch, state,
    // Answers whoever is still waiting, then lets go of the port.
    close() {
      clearInterval(watchdog);
      for (const it of Array.from(items.values())) {
        clearTimeout(it.timer);
        items.delete(it.id);
        const why = 'the relay is shutting down';
        it.resolve(it.kind === 'op' ? { ok: false, delivered: it.state !== 'queued', why }
          : Object.assign({ id: it.id, chat: it.chat, chatId: it.chatId, text: it.text, ok: false },
            it.state === 'committed' ? { unconfirmed: true, why: why + ' after Enter was allowed - read the chat before sending it again' }
              : { notSent: true, why }));
      }
      if (held) { clearTimeout(held.timer); reply(held.res, 200, polled([]), held.origin); held = null; }
      return new Promise(resolve => {
        server.close(() => resolve());
        // Give the answers above time to reach their sockets, then drop what is
        // left: the page's keep-alive connections would hold the port open.
        setTimeout(() => server.closeAllConnections(), 150);
      });
    },
  };
}
