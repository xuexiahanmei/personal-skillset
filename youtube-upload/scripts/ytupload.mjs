#!/usr/bin/env node
// Upload videos to the user's own YouTube channel with the YouTube Data API v3.
// No dependencies (Node 18+). Credentials live outside the repo, in
// ~/.youtube-upload (override with YTUPLOAD_HOME).
//
//   node ytupload.mjs auth [--no-browser]
//   node ytupload.mjs whoami
//   node ytupload.mjs upload <video> [--title T] [--description D | --description-file F] [--tags a,b]
//                    [--privacy private|unlisted|public] [--publish-at "2026-11-01 20:00"]
//                    [--category 22] [--language zh-TW] [--kids yes|no] [--synthetic yes|no]
//                    [--playlist <id|title>] [--thumbnail img.jpg] [--no-notify] [--dry-run]
//   node ytupload.mjs status <video id|url>
//   node ytupload.mjs update <video id|url> [the same metadata options as upload]
//   node ytupload.mjs thumbnail <video id|url> <image>
//   node ytupload.mjs playlists
//   node ytupload.mjs categories [--region TW]
// Add --json to any command for machine-readable output.

import { readFile, writeFile, mkdir, stat, open, unlink, chmod } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename, extname } from 'node:path';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HOME = process.env.YTUPLOAD_HOME || join(homedir(), '.youtube-upload');
const CLIENT_FILE = join(HOME, 'client_secret.json');
const TOKEN_FILE = join(HOME, 'token.json');
const SESSION_DIR = join(HOME, 'sessions');
const API = (process.env.YTUPLOAD_API_BASE || 'https://www.googleapis.com').replace(/\/$/, '');
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
// The `youtube` scope covers uploading, editing, thumbnails and playlists.
const SCOPE = 'https://www.googleapis.com/auth/youtube';
// Resumable chunks must be a multiple of 256 KiB, except the last one.
const CHUNK = Number(process.env.YTUPLOAD_CHUNK) || 16 * 1024 * 1024;
const MAX_RETRIES = 8;
const SESSION_MAX_AGE = 6 * 864e5;   // Google keeps an upload session for about a week
const PRIVACY = ['private', 'unlisted', 'public'];
const BOOLEAN_FLAGS = new Set(['json', 'dry-run', 'no-notify', 'no-browser']);
const VIDEO_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv',
  '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.3gp': 'video/3gpp', '.ts': 'video/mp2t', '.mts': 'video/mp2t',
};
const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------------------------------------------------------------- credentials

async function readJson(file) {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
}

async function loadClient() {
  let raw;
  try { raw = await readJson(CLIENT_FILE); }
  catch (e) {
    if (e.code === 'ENOENT') throw new Error(`no OAuth client at ${CLIENT_FILE}. Follow references/setup.md to create one.`);
    throw new Error(`cannot read ${CLIENT_FILE}: ${e.message}`);
  }
  const c = raw.installed;
  if (!c) throw new Error(`${CLIENT_FILE} is not a "Desktop app" OAuth client${raw.web ? ' (it is a "Web application" one)' : ''}. Create a Desktop app client; see references/setup.md.`);
  return { id: c.client_id, secret: c.client_secret, tokenUri: c.token_uri || 'https://oauth2.googleapis.com/token' };
}

async function tokenRequest(client, params) {
  const res = await fetch(client.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, ...params }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`token request failed (HTTP ${res.status}): ${body.error_description || body.error || 'no details'}`);
    err.code = body.error;
    throw err;
  }
  return body;
}

async function saveToken(t) {
  await mkdir(HOME, { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(t, null, 2));
  await chmod(TOKEN_FILE, 0o600).catch(() => {});
}

let cachedToken = null;

async function accessToken({ force = false } = {}) {
  if (!force && cachedToken && cachedToken.expires_at - 60_000 > Date.now()) return cachedToken.access_token;
  let saved;
  try { saved = await readJson(TOKEN_FILE); }
  catch { throw new Error('not signed in. Run `auth` first (see references/setup.md).'); }
  if (!force && saved.access_token && saved.expires_at - 60_000 > Date.now()) return (cachedToken = saved).access_token;
  const client = await loadClient();
  let fresh;
  try { fresh = await tokenRequest(client, { grant_type: 'refresh_token', refresh_token: saved.refresh_token }); }
  catch (e) {
    if (e.code === 'invalid_grant') {
      throw new Error('the saved sign-in no longer works (revoked, or it expired because the OAuth app is still in "Testing" mode, which limits sign-ins to 7 days). Run `auth` again, and see "Stop the sign-in from expiring" in references/setup.md.');
    }
    throw e;
  }
  cachedToken = { ...saved, access_token: fresh.access_token, expires_at: Date.now() + fresh.expires_in * 1000 };
  if (fresh.refresh_token) cachedToken.refresh_token = fresh.refresh_token;
  await saveToken(cachedToken);
  return cachedToken.access_token;
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch {}
}

// Installed-app OAuth with a loopback redirect and PKCE.
async function auth(opt) {
  const client = await loadClient();
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const url = `${AUTH_URL}?${new URLSearchParams({
    client_id: client.id, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
  })}`;
  console.error(`Sign in with the Google account that owns the channel:\n${url}\n`);
  if (!opt['no-browser']) openBrowser(url);

  const code = await new Promise((resolveCode, reject) => {
    const timer = setTimeout(() => reject(new Error('gave up after 5 minutes without a sign-in')), 5 * 60_000);
    server.on('request', (req, res) => {
      const q = new URL(req.url, redirect).searchParams;
      if (!q.has('code') && !q.has('error')) { res.writeHead(404).end(); return; }   // favicon and the like
      clearTimeout(timer);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (q.get('state') !== state) { res.end('<p>Sign-in failed: state mismatch.</p>'); reject(new Error('state mismatch in the OAuth reply')); }
      else if (q.get('error')) { res.end(`<p>Sign-in refused: ${q.get('error')}</p>`); reject(new Error(`sign-in refused: ${q.get('error')}`)); }
      else { res.end('<p>Signed in to youtube-upload. You can close this tab.</p>'); resolveCode(q.get('code')); }
    });
  }).finally(() => { server.closeAllConnections?.(); server.close(); });

  const t = await tokenRequest(client, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect });
  if (!t.refresh_token) throw new Error('Google returned no refresh token. Remove the app at https://myaccount.google.com/permissions and run auth again.');
  cachedToken = { refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000, scope: t.scope };
  await saveToken(cachedToken);
  return whoami();
}

// ---------------------------------------------------------------- API calls

const HINTS = {
  quotaExceeded: 'The Google Cloud project used up its daily API quota. It resets at midnight Pacific time.',
  uploadLimitExceeded: 'The channel reached its daily upload limit. Try again tomorrow.',
  youtubeSignupRequired: 'This Google account has no YouTube channel yet. Create one at youtube.com, then run auth again.',
  insufficientPermissions: 'The saved sign-in lacks a permission. Run auth again.',
  ACCESS_TOKEN_SCOPE_INSUFFICIENT: 'The saved sign-in lacks a permission. Run auth again.',
  accessNotConfigured: 'Enable "YouTube Data API v3" for the Google Cloud project (references/setup.md step 2).',
  SERVICE_DISABLED: 'Enable "YouTube Data API v3" for the Google Cloud project (references/setup.md step 2).',
  invalidPublishAt: 'The scheduled time must be in the future, and only a private video that was never public can be scheduled.',
  invalidTitle: 'Titles are at most 100 characters and cannot contain < or >.',
  invalidDescription: 'Descriptions are at most 5000 bytes and cannot contain < or >.',
  invalidTags: 'Tags add up to at most 500 characters and cannot contain < or >.',
  playlistNotFound: 'No such playlist, or it belongs to another channel. List yours with `playlists`.',
  videoNotFound: 'No such video, or it belongs to another channel.',
  forbidden: 'YouTube refused. For thumbnails this usually means the channel is not verified for custom thumbnails (verify at https://www.youtube.com/verify).',
};

class ApiError extends Error {}

async function apiError(res) {
  const text = await res.text().catch(() => '');
  let body = {};
  try { body = JSON.parse(text); } catch {}
  const reason = body.error?.errors?.[0]?.reason || body.error?.details?.find?.(d => d.reason)?.reason || body.error?.status;
  const msg = body.error?.message || text.slice(0, 200) || res.statusText;
  const hint = HINTS[reason] ? `\n${HINTS[reason]}` : '';
  const err = new ApiError(`HTTP ${res.status}${reason ? ` ${reason}` : ''}: ${msg}${hint}`);
  err.status = res.status;
  err.reason = reason;
  return err;
}

async function api(method, path, { query = {}, body, raw, contentType, base = '/youtube/v3' } = {}) {
  const url = `${API}${base}${path}?${new URLSearchParams(query)}`;
  for (let attempt = 0; ; attempt++) {
    const headers = { Authorization: `Bearer ${await accessToken({ force: attempt > 0 })}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=UTF-8';
    if (raw !== undefined) headers['Content-Type'] = contentType;
    const res = await fetch(url, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    if (res.status === 401 && attempt === 0) continue;   // stale access token: refresh once
    if (!res.ok) throw await apiError(res);
    return res.status === 204 ? {} : res.json();
  }
}

async function listAll(path, query) {
  const items = [];
  let pageToken;
  do {
    const page = await api('GET', path, { query: { ...query, maxResults: 50, ...(pageToken && { pageToken }) } });
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

// ---------------------------------------------------------------- helpers

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (BOOLEAN_FLAGS.has(key)) opt[key] = true;
      else if (i + 1 < argv.length) opt[key] = argv[++i];
      else throw new Error(`--${key} needs a value`);
    } else pos.push(argv[i]);
  }
  return { pos, opt };
}

function videoId(s) {
  const m = String(s).trim().match(/(?:[?&]v=|youtu\.be\/|\/video\/|\/shorts\/|\/live\/|\/embed\/|^)([\w-]{11})(?=$|[?&#/])/);
  if (!m) throw new Error(`not a YouTube video id or link: ${s}`);
  return m[1];
}

function yesNo(value, name) {
  const v = String(value).trim().toLowerCase();
  if (['yes', 'y', 'true', '1', '是'].includes(v)) return true;
  if (['no', 'n', 'false', '0', '否'].includes(v)) return false;
  throw new Error(`--${name} must be yes or no, not "${value}"`);
}

function splitTags(value) {
  const seen = new Set(), tags = [];
  for (const t of String(value).split(/[,，、]/).map(s => s.trim()).filter(Boolean)) {
    if (!seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); tags.push(t); }
  }
  return tags;
}

// YouTube counts a tag containing a space as if it were quoted, and counts the commas between tags.
function tagsLength(tags) {
  return tags.reduce((n, t) => n + [...t].length + (/\s/.test(t) ? 2 : 0), 0) + Math.max(0, tags.length - 1);
}

// "2026-11-01 20:00" without a zone is read as this computer's local time.
function parseWhen(value, now = Date.now()) {
  const d = new Date(String(value).trim().replace(/^(\d{4}-\d\d-\d\d) (\d)/, '$1T$2'));
  if (Number.isNaN(d.getTime())) throw new Error(`cannot read the time "${value}". Use e.g. 2026-11-01T20:00 or 2026-11-01T20:00+08:00`);
  if (d.getTime() < now + 60_000) throw new Error(`--publish-at ${d.toISOString()} is not in the future`);
  return d;
}

function validateMetadata(snippet, status) {
  const errs = [];
  const title = snippet.title ?? '';
  if (!title.trim()) errs.push('the title is empty');
  if ([...title].length > 100) errs.push(`the title is ${[...title].length} characters; the limit is 100`);
  if (/[<>]/.test(title)) errs.push('the title cannot contain < or >');
  const desc = snippet.description ?? '';
  const bytes = Buffer.byteLength(desc);
  if (bytes > 5000) errs.push(`the description is ${bytes} bytes; the limit is 5000 bytes (a Chinese character takes 3)`);
  if (/[<>]/.test(desc)) errs.push('the description cannot contain < or >');
  const tags = snippet.tags ?? [];
  if (tags.some(t => /[<>]/.test(t))) errs.push('tags cannot contain < or >');
  const tl = tagsLength(tags);
  if (tl > 500) errs.push(`the tags add up to ${tl} characters; the limit is 500 (a tag with a space counts 2 extra, and each comma counts 1)`);
  if (!PRIVACY.includes(status.privacyStatus)) errs.push(`privacy must be one of ${PRIVACY.join(', ')}`);
  if (status.publishAt && status.privacyStatus !== 'private') errs.push('a scheduled video must stay private until its publish time');
  if (errs.length) throw new Error(errs.join('\n'));
}

// Applies command-line options to a snippet and status (fresh for upload, fetched for update).
async function applyOptions(snippet, status, opt, now = Date.now()) {
  if (opt.description !== undefined && opt['description-file'] !== undefined) throw new Error('give --description or --description-file, not both');
  if (opt.title !== undefined) snippet.title = String(opt.title).trim();
  if (opt.description !== undefined) snippet.description = String(opt.description);
  if (opt['description-file'] !== undefined) {
    snippet.description = (await readFile(opt['description-file'], 'utf8')).replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  }
  if (opt.tags !== undefined) snippet.tags = splitTags(opt.tags);
  if (opt.category !== undefined) snippet.categoryId = String(opt.category);
  if (opt.language !== undefined) snippet.defaultLanguage = snippet.defaultAudioLanguage = String(opt.language);
  if (opt.privacy !== undefined) {
    const p = String(opt.privacy).toLowerCase();
    if (!PRIVACY.includes(p)) throw new Error(`--privacy must be one of ${PRIVACY.join(', ')}`);
    status.privacyStatus = p;
    if (p !== 'private') delete status.publishAt;
  }
  if (opt['publish-at'] !== undefined) {
    if (opt.privacy !== undefined && status.privacyStatus !== 'private') {
      throw new Error('--publish-at keeps the video private until that time; drop --privacy or make it private');
    }
    status.privacyStatus = 'private';
    status.publishAt = parseWhen(opt['publish-at'], now).toISOString();
  }
  if (opt.kids !== undefined) status.selfDeclaredMadeForKids = yesNo(opt.kids, 'kids');
  if (opt.synthetic !== undefined) status.containsSyntheticMedia = yesNo(opt.synthetic, 'synthetic');
  validateMetadata(snippet, status);
}

// "bytes=0-524287" means bytes 0..524287 arrived, so the next one to send is 524288.
function nextOffset(range) {
  const m = range && range.match(/bytes=\d+-(\d+)/);
  return m ? Number(m[1]) + 1 : 0;
}

function mimeFor(file) {
  return VIDEO_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function sessionKey(file, size, mtimeMs) {
  return createHash('sha1').update(`${resolve(file).toLowerCase()}|${size}|${mtimeMs}`).digest('hex').slice(0, 16);
}

function fmtBytes(n) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;
}

// ---------------------------------------------------------------- playlists and thumbnails

async function myPlaylists() {
  const items = await listAll('/playlists', { part: 'snippet,status,contentDetails', mine: 'true' });
  return items.map(p => ({ id: p.id, title: p.snippet.title, privacy: p.status?.privacyStatus, videos: p.contentDetails?.itemCount }));
}

async function resolvePlaylist(value) {
  const lists = await myPlaylists();
  const byId = lists.find(p => p.id === value);
  if (byId) return byId;
  const q = String(value).trim().toLowerCase();
  let hits = lists.filter(p => p.title.toLowerCase() === q);
  if (!hits.length) hits = lists.filter(p => p.title.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  const names = (hits.length ? hits : lists).map(p => `  ${p.id}  ${p.title}`).join('\n') || '  (the channel has no playlists)';
  throw new Error(`${hits.length ? 'more than one playlist matches' : 'no playlist matches'} "${value}":\n${names}`);
}

async function addToPlaylist(playlistId, id) {
  await api('POST', '/playlistItems', {
    query: { part: 'snippet' },
    body: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId: id } } },
  });
}

async function checkThumbnail(file) {
  const type = IMAGE_TYPES[extname(file).toLowerCase()];
  if (!type) throw new Error(`thumbnail must be .jpg or .png: ${file}`);
  const { size } = await stat(file);
  if (size > 2 * 1024 * 1024) throw new Error(`thumbnail is ${fmtBytes(size)}; YouTube allows at most 2 MB`);
  return type;
}

async function setThumbnail(id, file) {
  const type = await checkThumbnail(file);
  await api('POST', '/thumbnails/set', { base: '/upload/youtube/v3', query: { videoId: id, uploadType: 'media' }, raw: await readFile(file), contentType: type });
}

// ---------------------------------------------------------------- resumable upload

async function startSession(meta, size, type, notify) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/upload/youtube/v3/videos?${new URLSearchParams({ uploadType: 'resumable', part: 'snippet,status', notifySubscribers: String(notify) })}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken({ force: attempt > 0 })}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': type,
      },
      body: JSON.stringify(meta),
    });
    if (res.status === 401 && attempt === 0) continue;
    if (!res.ok) throw await apiError(res);
    const location = res.headers.get('location');
    if (!location) throw new Error('YouTube did not return an upload session URL');
    return location;
  }
}

// Asks the session how much it already has. Returns { offset } or { done: videoResource }.
async function probe(uploadUrl, size) {
  const res = await fetch(uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Range': `bytes */${size}` } });
  if (res.status === 308) return { offset: nextOffset(res.headers.get('range')) };
  if (res.ok) return { done: await res.json() };
  throw await apiError(res);
}

async function sendFile(file, size, uploadUrl, startAt, progress) {
  const fh = await open(file, 'r');
  try {
    let offset = startAt, failures = 0;
    // Waits, then asks the session where to continue. Returns the video if the upload already finished.
    const retry = async why => {
      for (;;) {
        if (++failures > MAX_RETRIES) throw new Error(`giving up after ${MAX_RETRIES} failed attempts (${why}). Run the same upload again to continue where it stopped.`);
        const wait = Math.min(60, 2 ** failures) * (Number(process.env.YTUPLOAD_RETRY_MS) || 1000) * (0.75 + Math.random() / 2);
        progress(`  retrying in ${Math.round(wait / 1000)} s (${why})`);
        await sleep(wait);
        try {
          const p = await probe(uploadUrl, size);
          if (p.done) return p.done;
          offset = p.offset;
          return null;
        } catch (e) {
          if (e.status === 404 || e.status === 410) { e.expired = true; throw e; }
          why = `checking progress: ${e.cause?.code || e.message}`;
        }
      }
    };
    for (;;) {
      const end = Math.min(offset + CHUNK, size);
      const buf = Buffer.alloc(end - offset);
      await fh.read(buf, 0, buf.length, offset);
      let res;
      try {
        res = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Range': `bytes ${offset}-${end - 1}/${size}` },
          body: buf,
        });
      } catch (e) {
        const done = await retry(`network: ${e.cause?.code || e.message}`);
        if (done) return done;
        continue;
      }
      if (res.status === 308) {
        const next = nextOffset(res.headers.get('range'));
        if (next > offset) failures = 0;
        offset = next;
        progress(null, offset);
        continue;
      }
      if (res.ok) { progress(null, size); return res.json(); }
      if (res.status === 404 || res.status === 410) { const err = await apiError(res); err.expired = true; throw err; }
      if (res.status === 401 || res.status >= 500 || res.status === 429) {
        await res.body?.cancel();
        if (res.status === 401) await accessToken({ force: true });
        const done = await retry(`HTTP ${res.status}`);
        if (done) return done;
        continue;
      }
      throw await apiError(res);
    }
  } finally {
    await fh.close();
  }
}

function progressPrinter(size, quiet) {
  let lastStep = -1;
  return (message, sent) => {
    if (quiet) return;
    if (message) { console.error(message); return; }
    const pct = Math.floor((sent / size) * 100);
    const step = Math.floor(pct / 5);
    if (step !== lastStep) { lastStep = step; console.error(`  ${String(pct).padStart(3)}%  ${fmtBytes(sent)} / ${fmtBytes(size)}`); }
  };
}

async function upload(file, opt) {
  if (!file) throw new Error('which video file?');
  let st;
  try { st = await stat(file); } catch { throw new Error(`no such file: ${file}`); }
  if (!st.isFile() || st.size === 0) throw new Error(`not a video file (or empty): ${file}`);

  const snippet = { title: basename(file, extname(file)).trim(), categoryId: '22' };
  const status = { privacyStatus: 'private', selfDeclaredMadeForKids: false };
  await applyOptions(snippet, status, opt);
  const meta = { snippet, status };
  const notify = !opt['no-notify'];
  const type = mimeFor(file);
  if (opt.thumbnail) await checkThumbnail(opt.thumbnail);

  if (opt['dry-run']) return { dryRun: true, file: resolve(file), size: st.size, type, notifySubscribers: notify, ...meta, playlist: opt.playlist ?? null, thumbnail: opt.thumbnail ?? null };

  // Check the sign-in and the playlist before sending gigabytes.
  const playlist = opt.playlist ? await resolvePlaylist(opt.playlist) : null;
  const progress = progressPrinter(st.size, opt.json);

  await mkdir(SESSION_DIR, { recursive: true });
  const sessionFile = join(SESSION_DIR, `${sessionKey(file, st.size, st.mtimeMs)}.json`);
  const metaJson = JSON.stringify({ meta, notify });
  let session = null;
  try { session = await readJson(sessionFile); } catch {}
  if (session && (session.metaJson !== metaJson || Date.now() - session.created > SESSION_MAX_AGE)) session = null;

  let video, startAt = 0, resumed = false;
  if (session) {
    try {
      const p = await probe(session.uploadUrl, st.size);
      if (p.done) video = p.done;
      else { startAt = p.offset; resumed = true; progress(`Resuming the earlier upload at ${fmtBytes(startAt)} of ${fmtBytes(st.size)}`); }
    } catch { session = null; }
  }
  if (!video) {
    if (!session) {
      session = { uploadUrl: await startSession(meta, st.size, type, notify), metaJson, created: Date.now(), file: resolve(file) };
      await writeFile(sessionFile, JSON.stringify(session));
      progress(`Uploading ${basename(file)} (${fmtBytes(st.size)})`);
    }
    try {
      video = await sendFile(file, st.size, session.uploadUrl, startAt, progress);
    } catch (e) {
      if (e.expired) await unlink(sessionFile).catch(() => {});
      throw e;
    }
  }
  await unlink(sessionFile).catch(() => {});

  const warnings = [];
  const id = video.id;
  if (playlist) {
    try { await addToPlaylist(playlist.id, id); } catch (e) { warnings.push(`not added to playlist "${playlist.title}": ${e.message}`); }
  }
  if (opt.thumbnail) {
    try { await setThumbnail(id, opt.thumbnail); } catch (e) { warnings.push(`thumbnail not set: ${e.message}`); }
  }
  const got = video.status?.privacyStatus;
  if (got && got !== status.privacyStatus) {
    warnings.push(`YouTube set the video to "${got}", not "${status.privacyStatus}". Run \`status ${id}\`; see "If a video comes back private" in SKILL.md.`);
  }
  return {
    id, title: video.snippet?.title ?? snippet.title, resumed,
    privacy: got ?? status.privacyStatus, publishAt: video.status?.publishAt ?? status.publishAt ?? null,
    uploadStatus: video.status?.uploadStatus,
    watch: `https://youtu.be/${id}`, studio: `https://studio.youtube.com/video/${id}/edit`,
    playlist: playlist && !warnings.some(w => w.startsWith('not added')) ? playlist.title : null,
    thumbnail: opt.thumbnail && !warnings.some(w => w.startsWith('thumbnail')) ? resolve(opt.thumbnail) : null,
    warnings,
  };
}

// ---------------------------------------------------------------- other commands

async function whoami() {
  const { items = [] } = await api('GET', '/channels', { query: { part: 'snippet,statistics,status', mine: 'true' } });
  if (!items.length) throw new Error('this Google account has no YouTube channel. Create one at youtube.com first.');
  const c = items[0];
  return {
    id: c.id, title: c.snippet.title, handle: c.snippet.customUrl ?? null,
    subscribers: c.statistics?.hiddenSubscriberCount ? 'hidden' : Number(c.statistics?.subscriberCount ?? 0),
    videos: Number(c.statistics?.videoCount ?? 0),
    longUploads: c.status?.longUploadsStatus ?? 'unknown',
    url: `https://www.youtube.com/channel/${c.id}`,
  };
}

async function videoStatus(idOrUrl) {
  const id = videoId(idOrUrl);
  const { items = [] } = await api('GET', '/videos', { query: { id, part: 'snippet,status,processingDetails,contentDetails' } });
  if (!items.length) throw new Error(`video ${id} not found, or it is not on the signed-in channel`);
  const v = items[0], s = v.status ?? {}, p = v.processingDetails ?? {};
  return {
    id, title: v.snippet.title, privacy: s.privacyStatus, publishAt: s.publishAt ?? null,
    uploadStatus: s.uploadStatus, failureReason: s.failureReason ?? null, rejectionReason: s.rejectionReason ?? null,
    processing: p.processingStatus ?? null,
    processingLeftMs: p.processingProgress?.timeLeftMs ? Number(p.processingProgress.timeLeftMs) : null,
    duration: v.contentDetails?.duration ?? null, madeForKids: s.madeForKids ?? s.selfDeclaredMadeForKids ?? null,
    containsSyntheticMedia: s.containsSyntheticMedia ?? null,
    watch: `https://youtu.be/${id}`, studio: `https://studio.youtube.com/video/${id}/edit`,
  };
}

const SNIPPET_KEYS = ['title', 'description', 'tags', 'categoryId', 'defaultLanguage', 'defaultAudioLanguage'];
const STATUS_KEYS = ['privacyStatus', 'embeddable', 'license', 'publicStatsViewable', 'publishAt', 'selfDeclaredMadeForKids', 'containsSyntheticMedia'];
const SNIPPET_OPTS = ['title', 'description', 'description-file', 'tags', 'category', 'language'];
const STATUS_OPTS = ['privacy', 'publish-at', 'kids', 'synthetic'];

function pick(obj, keys) {
  return Object.fromEntries(keys.filter(k => obj?.[k] !== undefined).map(k => [k, obj[k]]));
}

// videos.update resets any field left out of a part it is given, so send each touched part whole.
async function update(idOrUrl, opt) {
  const id = videoId(idOrUrl);
  const parts = [SNIPPET_OPTS.some(k => k in opt) && 'snippet', STATUS_OPTS.some(k => k in opt) && 'status'].filter(Boolean);
  if (!parts.length) throw new Error('nothing to change. Give --title, --description, --tags, --privacy, --publish-at, ...');
  const { items = [] } = await api('GET', '/videos', { query: { id, part: 'snippet,status' } });
  if (!items.length) throw new Error(`video ${id} not found, or it is not on the signed-in channel`);
  const snippet = pick(items[0].snippet, SNIPPET_KEYS);
  const status = pick(items[0].status, STATUS_KEYS);
  await applyOptions(snippet, status, opt);
  const body = { id };
  if (parts.includes('snippet')) body.snippet = snippet;
  if (parts.includes('status')) body.status = status;
  if (opt['dry-run']) return { dryRun: true, ...body };
  const v = await api('PUT', '/videos', { query: { part: parts.join(',') }, body });
  return { id, title: v.snippet?.title ?? snippet.title, privacy: v.status?.privacyStatus ?? status.privacyStatus, publishAt: v.status?.publishAt ?? null, changed: parts, studio: `https://studio.youtube.com/video/${id}/edit` };
}

async function categories(opt) {
  const region = String(opt.region || 'TW').toUpperCase();
  const { items = [] } = await api('GET', '/videoCategories', { query: { part: 'snippet', regionCode: region, hl: opt.hl || 'zh-TW' } });
  return items.filter(c => c.snippet.assignable).map(c => ({ id: c.id, title: c.snippet.title }));
}

// ---------------------------------------------------------------- printing and main

function localTime(iso) {
  return iso ? new Date(iso).toLocaleString('sv-SE', { hour12: false }).slice(0, 16) + ' (local)' : '';
}

function printUpload(r) {
  if (r.dryRun) {
    console.log(`Dry run, nothing uploaded.\n  file      ${r.file} (${fmtBytes(r.size)}, ${r.type})`);
    console.log(`  title     ${r.snippet.title}\n  privacy   ${r.status.privacyStatus}${r.status.publishAt ? `, publishes ${localTime(r.status.publishAt)}` : ''}`);
    console.log(`  tags      ${(r.snippet.tags ?? []).join(', ') || '-'}\n  category  ${r.snippet.categoryId}   language ${r.snippet.defaultLanguage ?? '-'}`);
    console.log(`  kids      ${r.status.selfDeclaredMadeForKids ? 'yes' : 'no'}   altered/synthetic ${r.status.containsSyntheticMedia ? 'yes' : 'no'}   notify ${r.notifySubscribers ? 'yes' : 'no'}`);
    console.log(`  playlist  ${r.playlist ?? '-'}   thumbnail ${r.thumbnail ?? '-'}`);
    console.log(`  description:\n${(r.snippet.description || '(empty)').replace(/^/gm, '    ')}`);
    return;
  }
  console.log(`Uploaded${r.resumed ? ' (resumed)' : ''}: ${r.title}`);
  console.log(`  id        ${r.id}\n  watch     ${r.watch}\n  studio    ${r.studio}`);
  console.log(`  privacy   ${r.privacy}${r.publishAt ? `, publishes ${localTime(r.publishAt)}` : ''}`);
  if (r.playlist) console.log(`  playlist  ${r.playlist}`);
  if (r.thumbnail) console.log(`  thumbnail set`);
  for (const w of r.warnings) console.log(`WARNING: ${w}`);
  console.log(`YouTube is still processing it; HD versions show up later. Check with: status ${r.id}`);
}

function printStatus(s) {
  console.log(`${s.title}\n  id          ${s.id}\n  privacy     ${s.privacy}${s.publishAt ? `, publishes ${localTime(s.publishAt)}` : ''}`);
  console.log(`  upload      ${s.uploadStatus}${s.failureReason ? ` (failed: ${s.failureReason})` : ''}${s.rejectionReason ? ` (rejected: ${s.rejectionReason})` : ''}`);
  if (s.processing) console.log(`  processing  ${s.processing}${s.processingLeftMs ? `, about ${Math.ceil(s.processingLeftMs / 60000)} min left` : ''}`);
  if (s.duration) console.log(`  duration    ${s.duration}`);
  console.log(`  watch       ${s.watch}\n  studio      ${s.studio}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  const out = (value, printer) => (opt.json ? console.log(JSON.stringify(value, null, 2)) : printer(value));
  const kv = o => { for (const [k, v] of Object.entries(o)) console.log(`  ${k.padEnd(12)}${typeof v === 'object' && v ? JSON.stringify(v) : v}`); };

  if (cmd === 'auth') return out(await auth(opt), c => { console.log(`Signed in. Channel:`); kv(c); });
  if (cmd === 'whoami') return out(await whoami(), kv);
  if (cmd === 'upload') {
    const r = await upload(pos[0], opt);
    if (r.warnings?.length) process.exitCode = 3;
    return out(r, printUpload);
  }
  if (cmd === 'status' && pos[0]) return out(await videoStatus(pos[0]), printStatus);
  if (cmd === 'update' && pos[0]) return out(await update(pos[0], opt), r => (r.dryRun ? console.log(JSON.stringify(r, null, 2)) : (console.log('Updated:'), kv(r))));
  if (cmd === 'thumbnail' && pos[1]) { await setThumbnail(videoId(pos[0]), pos[1]); return out({ id: videoId(pos[0]), thumbnail: resolve(pos[1]) }, () => console.log('Thumbnail set.')); }
  if (cmd === 'playlists') return out(await myPlaylists(), ls => (ls.length ? ls.forEach(p => console.log(`${p.id}  ${p.title}  (${p.privacy}, ${p.videos} videos)`)) : console.log('No playlists.')));
  if (cmd === 'categories') return out(await categories(opt), cs => cs.forEach(c => console.log(`${c.id.padStart(3)}  ${c.title}`)));

  console.error('usage: ytupload.mjs auth | whoami | upload <video> [options] | status <id> | update <id> [options]\n' +
                '                    | thumbnail <id> <image> | playlists | categories [--region TW]   (see SKILL.md)');
  process.exitCode = 2;
}

export {
  parseArgs, videoId, yesNo, splitTags, tagsLength, parseWhen, validateMetadata, applyOptions,
  nextOffset, mimeFor, sessionKey, upload, update, videoStatus, whoami,
};

// Compare real paths: the skill is installed through a junction, and Node reports
// import.meta.url for the resolved target, not the path it was started with.
const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === entry) {
  main().catch(e => { console.error(`ytupload: ${e.message}`); process.exitCode = 1; });
}
