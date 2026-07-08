#!/usr/bin/env node
// Zinester reference backend — implements docs/API.md against a local directory
// that stands in for the ESP32's SD card. Zero npm dependencies (Node >= 18):
// it uses only built-in modules so it runs anywhere Node does. Serves the static
// frontend from web/ and the JSON+binary API under /api.
//
//   node server/server.mjs [--port 8787] [--data ./data] [--web ./web]

import http from 'node:http';
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fetchFeed, summarizeItem } from './reader.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = parseInt(process.env.PORT || arg('--port', '8787'), 10);
const DATA = path.resolve(ROOT, arg('--data', 'data'));
const WEB  = path.resolve(ROOT, arg('--web', 'web'));
const MAX_ASSET_BYTES = 8 * 1024 * 1024; // 8 MB per asset (tune for SD/RAM)
// Mock camera lets us exercise the /api/camera flow without hardware. The real
// XIAO ESP32S3 Sense firmware sets camera=true and returns live JPEG frames.
const MOCK_CAMERA = argv.includes('--mock-camera') || process.env.MOCK_CAMERA === '1';
// A small valid PNG used as the stand-in "camera frame" in mock mode.
const MOCK_FRAME = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR4nGNk+M9AAJEwUglBAQBhBQEBQNk5nQAAAABJRU5ErkJggg==', 'base64');

const ASSET_DIR = path.join(DATA, 'assets');
const PROJ_DIR  = path.join(DATA, 'projects');
const ASSET_IDX = path.join(ASSET_DIR, 'index.json');
const PROJ_IDX  = path.join(PROJ_DIR, 'index.json');
// Reader (content curation): feed subscriptions + ingested items with summaries.
const READER_DIR = path.join(DATA, 'reader');
const FEEDS_IDX  = path.join(READER_DIR, 'feeds.json');
const ITEMS_IDX  = path.join(READER_DIR, 'items.json');
const SEED_FEEDS = path.resolve(ROOT, 'reader', 'seed-feeds.json');

// --- tiny fs-backed index helpers ------------------------------------------
async function ensureDirs() {
  await fs.mkdir(ASSET_DIR, { recursive: true });
  await fs.mkdir(PROJ_DIR, { recursive: true });
  await fs.mkdir(READER_DIR, { recursive: true });
  for (const f of [ASSET_IDX, PROJ_IDX, ITEMS_IDX]) {
    try { await fs.access(f); } catch { await fs.writeFile(f, '[]'); }
  }
  // On very first run, pre-load the committed starter feed subscriptions so the
  // reader isn't empty. Items are pulled lazily when the user hits Refresh.
  try { await fs.access(FEEDS_IDX); } catch {
    let seed = [];
    try { seed = JSON.parse(await fs.readFile(SEED_FEEDS, 'utf8')); } catch {}
    const feeds = (Array.isArray(seed) ? seed : []).filter(s => s && s.url).map(s => ({
      id: uid('f_'), url: s.url, title: s.title || s.url, siteTitle: s.title || '',
      addedAt: Date.now(), lastFetchedAt: null, lastError: null }));
    await writeIndex(FEEDS_IDX, feeds);
  }
}
async function readIndex(f) { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return []; } }
async function writeIndex(f, list) { await fs.writeFile(f, JSON.stringify(list, null, 2)); }

const uid = (p) => p + crypto.randomBytes(9).toString('base64url');
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp' };

// --- request helpers --------------------------------------------------------
function send(res, status, body, headers = {}) {
  const h = { 'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Zinester-Author,X-Zinester-Author-Name,X-Zinester-Admin',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', ...headers };
  if (body != null && !h['Content-Type']) h['Content-Type'] = 'application/json';
  res.writeHead(status, h);
  res.end(body == null ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)));
}
function readBody(req, limit = MAX_ASSET_BYTES * 1.4) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('payload too large')); req.destroy(); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const author = (req) => req.headers['x-zinester-author'] || '';
const authorName = (req) => { try { return decodeURIComponent(req.headers['x-zinester-author-name'] || ''); } catch { return ''; } };

// --- static file serving ----------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.normalize(path.join(WEB, rel));
  if (!full.startsWith(WEB)) return send(res, 403, { error: 'forbidden' });
  try {
    const st = await fs.stat(full);
    if (st.isDirectory()) return serveStatic(req, res, rel.replace(/\/?$/, '/index.html'));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache' });
    createReadStream(full).pipe(res);
  } catch { send(res, 404, { error: 'not found' }); }
}

// --- API: assets ------------------------------------------------------------
async function listAssets(req, res, q) {
  const list = await readIndex(ASSET_IDX);
  const me = author(req);
  const scope = q.get('scope') || 'shared';
  const out = list.filter(a => {
    if (scope === 'mine') return a.authorId === me;
    if (scope === 'all') return a.visibility === 'shared' || a.authorId === me;
    return a.visibility === 'shared';
  }).sort((a, b) => b.createdAt - a.createdAt).map(publicAsset);
  send(res, 200, { assets: out });
}
// Persist an asset from a data URL + metadata. Shared by uploads and camera capture.
async function persistAsset(dataUrl, { name, w, h, visibility, authorId, authorName }) {
  const m = /^data:([^;,]+)(;base64)?,/.exec(dataUrl || '');
  if (!m) throw Object.assign(new Error('dataUrl required'), { status: 400 });
  const mime = m[1];
  const bin = Buffer.from(dataUrl.slice(m[0].length), m[2] ? 'base64' : 'utf8');
  if (bin.length > MAX_ASSET_BYTES) throw Object.assign(new Error('asset too large'), { status: 413 });
  const id = uid('a_'); const ext = EXT[mime] || 'bin';
  await fs.writeFile(path.join(ASSET_DIR, id + '.' + ext), bin);
  const meta = { id, name: (name || 'asset').slice(0, 120), mime, file: id + '.' + ext,
    size: bin.length, w: w || null, h: h || null,
    visibility: visibility === 'shared' ? 'shared' : 'private',
    authorId: authorId || '', authorName: authorName || '', createdAt: Date.now() };
  const list = await readIndex(ASSET_IDX); list.push(meta); await writeIndex(ASSET_IDX, list);
  return meta;
}
async function createAsset(req, res) {
  const raw = await readBody(req);
  let body; try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'invalid json' }); }
  try {
    const meta = await persistAsset(body.dataUrl, { name: body.name, w: body.w, h: body.h,
      visibility: body.visibility, authorId: author(req), authorName: authorName(req) });
    send(res, 201, publicAsset(meta));
  } catch (e) { send(res, e.status || 500, { error: e.message }); }
}

// --- API: camera (device capability; mock in the reference server) ----------
function cameraFrame(req, res) {
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*' });
  res.end(MOCK_FRAME);
}
async function cameraCapture(req, res) {
  let body = {}; try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch {}
  const dataUrl = 'data:image/png;base64,' + MOCK_FRAME.toString('base64');
  const meta = await persistAsset(dataUrl, { name: body.name || 'photo.png', w: 8, h: 8,
    visibility: body.visibility, authorId: author(req), authorName: authorName(req) });
  send(res, 201, publicAsset(meta));
}
function publicAsset(m) { const { file, ...rest } = m; return { ...rest, url: '/api/assets/' + m.id }; }
async function getAssetBinary(req, res, id) {
  const list = await readIndex(ASSET_IDX); const m = list.find(a => a.id === id);
  if (!m) return send(res, 404, { error: 'not found' });
  try {
    res.writeHead(200, { 'Content-Type': m.mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
    createReadStream(path.join(ASSET_DIR, m.file)).pipe(res);
  } catch { send(res, 404, { error: 'missing file' }); }
}
async function patchAsset(req, res, id) {
  const list = await readIndex(ASSET_IDX); const m = list.find(a => a.id === id);
  if (!m) return send(res, 404, { error: 'not found' });
  if (m.authorId !== author(req)) return send(res, 403, { error: 'not owner' });
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  if (body.visibility === 'shared' || body.visibility === 'private') m.visibility = body.visibility;
  if (typeof body.name === 'string') m.name = body.name.slice(0, 120);
  await writeIndex(ASSET_IDX, list); send(res, 200, publicAsset(m));
}
async function deleteAsset(req, res, id) {
  const list = await readIndex(ASSET_IDX); const i = list.findIndex(a => a.id === id);
  if (i < 0) return send(res, 404, { error: 'not found' });
  if (list[i].authorId !== author(req)) return send(res, 403, { error: 'not owner' });
  try { await fs.unlink(path.join(ASSET_DIR, list[i].file)); } catch {}
  list.splice(i, 1); await writeIndex(ASSET_IDX, list); send(res, 200, { ok: true });
}

// --- API: projects ----------------------------------------------------------
async function listProjects(req, res, q) {
  const list = await readIndex(PROJ_IDX); const me = author(req);
  const scope = q.get('scope') || 'mine';
  const out = list.filter(p => {
    if (scope === 'shared') return p.visibility === 'shared';
    if (scope === 'all') return p.visibility === 'shared' || p.authorId === me;
    return p.authorId === me;
  }).sort((a, b) => b.updatedAt - a.updatedAt).map(({ file, ...m }) => m);
  send(res, 200, { projects: out });
}
async function createProject(req, res) {
  const doc = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  if (!doc.panels || !doc.format) return send(res, 400, { error: 'invalid project' });
  const id = uid('p_'); const file = id + '.json';
  const meta = { id, name: (doc.name || 'Untitled').slice(0, 120), format: doc.format,
    visibility: doc.visibility === 'shared' ? 'shared' : 'private',
    authorId: author(req), authorName: authorName(req), updatedAt: Date.now(),
    thumb: doc.thumb || null, file };
  await fs.writeFile(path.join(PROJ_DIR, file), JSON.stringify({ ...meta, data: doc }));
  const list = await readIndex(PROJ_IDX); list.push(meta); await writeIndex(PROJ_IDX, list);
  const { file: _f, ...pub } = meta; send(res, 201, pub);
}
async function getProject(req, res, id) {
  const list = await readIndex(PROJ_IDX); const m = list.find(p => p.id === id);
  if (!m) return send(res, 404, { error: 'not found' });
  try { const doc = JSON.parse(await fs.readFile(path.join(PROJ_DIR, m.file), 'utf8'));
    const { file, ...pub } = m; send(res, 200, { ...pub, data: doc.data }); }
  catch { send(res, 404, { error: 'missing file' }); }
}
async function putProject(req, res, id) {
  const list = await readIndex(PROJ_IDX); const m = list.find(p => p.id === id);
  if (!m) return send(res, 404, { error: 'not found' });
  if (m.authorId !== author(req)) return send(res, 403, { error: 'not owner' });
  const doc = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  m.name = (doc.name || m.name).slice(0, 120); m.format = doc.format || m.format;
  if (doc.visibility) m.visibility = doc.visibility === 'shared' ? 'shared' : 'private';
  if (doc.thumb !== undefined) m.thumb = doc.thumb; m.updatedAt = Date.now();
  await fs.writeFile(path.join(PROJ_DIR, m.file), JSON.stringify({ ...m, data: doc }));
  await writeIndex(PROJ_IDX, list); const { file, ...pub } = m; send(res, 200, pub);
}
async function deleteProject(req, res, id) {
  const list = await readIndex(PROJ_IDX); const i = list.findIndex(p => p.id === id);
  if (i < 0) return send(res, 404, { error: 'not found' });
  if (list[i].authorId !== author(req)) return send(res, 403, { error: 'not owner' });
  try { await fs.unlink(path.join(PROJ_DIR, list[i].file)); } catch {}
  list.splice(i, 1); await writeIndex(PROJ_IDX, list); send(res, 200, { ok: true });
}

// --- API: reader (content curation) -----------------------------------------
// A personal reading queue: feed subscriptions + ingested items with summaries
// and attribution. Unlike assets/projects this store is single-tenant (it's the
// operator's own queue), so it is not author-scoped.
const clampStr = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');

// Insert any parsed items not already present. Returns how many were added.
async function upsertItems(feed, parsed) {
  const items = await readIndex(ITEMS_IDX);
  const seen = new Set(items.map(it => (it.feedId || '') + '|' + (it.guid || it.url)));
  let added = 0;
  for (const raw of parsed.items) {
    const key = (feed ? feed.id : '') + '|' + (raw.guid || raw.url);
    if (!raw.url && !raw.title) continue;
    if (seen.has(key) || (raw.url && items.some(it => it.url === raw.url))) continue;
    const { summary, engine, excerpt } = await summarizeItem(raw);
    items.push({
      id: uid('i_'), feedId: feed ? feed.id : null,
      source: (feed && feed.title) || parsed.title || raw.author || 'Unknown',
      guid: raw.guid || raw.url, title: clampStr(raw.title, 300) || '(untitled)',
      url: raw.url || '', author: clampStr(raw.author, 120),
      publishedAt: raw.publishedAt || null, addedAt: Date.now(),
      summary, engine, excerpt: clampStr(excerpt, 1200),
      tags: [], state: 'unread', starred: false, note: '', readAt: null });
    seen.add(key); added++;
  }
  if (added) await writeIndex(ITEMS_IDX, items);
  return added;
}

async function listFeeds(req, res) { send(res, 200, { feeds: await readIndex(FEEDS_IDX) }); }

async function addFeed(req, res) {
  let body; try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { return send(res, 400, { error: 'invalid json' }); }
  if (!body.url) return send(res, 400, { error: 'url required' });
  let parsed;
  try { parsed = await fetchFeed(body.url); }
  catch (e) { return send(res, e.status || 502, { error: 'could not fetch feed: ' + e.message }); }
  const feeds = await readIndex(FEEDS_IDX);
  let feed = feeds.find(f => f.url === body.url);
  if (!feed) {
    feed = { id: uid('f_'), url: body.url, title: clampStr(body.title || parsed.title || body.url, 200),
      siteTitle: clampStr(parsed.title, 200), addedAt: Date.now(), lastFetchedAt: null, lastError: null };
    feeds.push(feed);
  }
  feed.lastFetchedAt = Date.now(); feed.lastError = null;
  await writeIndex(FEEDS_IDX, feeds);
  const added = await upsertItems(feed, parsed);
  send(res, 201, { feed, added });
}

async function deleteFeed(req, res, id, q) {
  const feeds = await readIndex(FEEDS_IDX); const i = feeds.findIndex(f => f.id === id);
  if (i < 0) return send(res, 404, { error: 'not found' });
  feeds.splice(i, 1); await writeIndex(FEEDS_IDX, feeds);
  if (q.get('purge') === '1') {
    const items = await readIndex(ITEMS_IDX);
    await writeIndex(ITEMS_IDX, items.filter(it => it.feedId !== id));
  }
  send(res, 200, { ok: true });
}

async function refreshFeeds(req, res) {
  let body = {}; try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch {}
  const feeds = await readIndex(FEEDS_IDX);
  const targets = body.feedId ? feeds.filter(f => f.id === body.feedId) : feeds;
  let added = 0;
  for (const feed of targets) {
    try {
      const parsed = await fetchFeed(feed.url);
      added += await upsertItems(feed, parsed);
      feed.lastFetchedAt = Date.now(); feed.lastError = null;
      if (!feed.siteTitle && parsed.title) feed.siteTitle = clampStr(parsed.title, 200);
    } catch (e) { feed.lastError = String(e.message || e); feed.lastFetchedAt = Date.now(); }
  }
  await writeIndex(FEEDS_IDX, feeds);
  send(res, 200, { added, feeds });
}

async function listItems(req, res, q) {
  let items = await readIndex(ITEMS_IDX);
  const state = q.get('state'); const source = q.get('source');
  if (state && state !== 'all') {
    if (state === 'starred') items = items.filter(it => it.starred);
    else items = items.filter(it => (it.state || 'unread') === state);
  }
  if (source) items = items.filter(it => it.source === source || it.feedId === source);
  items.sort((a, b) => (b.publishedAt || b.addedAt) - (a.publishedAt || a.addedAt));
  const limit = Math.min(parseInt(q.get('limit') || '500', 10) || 500, 1000);
  send(res, 200, { items: items.slice(0, limit) });
}

async function getItem(req, res, id) {
  const items = await readIndex(ITEMS_IDX); const it = items.find(x => x.id === id);
  return it ? send(res, 200, it) : send(res, 404, { error: 'not found' });
}

// Manual / email import: push an article the server didn't fetch (e.g. a
// newsletter pulled from an inbox). Summarizes if no summary is supplied.
async function addItem(req, res) {
  let body; try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { return send(res, 400, { error: 'invalid json' }); }
  if (!body.title && !body.url) return send(res, 400, { error: 'title or url required' });
  const items = await readIndex(ITEMS_IDX);
  if (body.url && items.some(it => it.url === body.url)) return send(res, 200, { duplicate: true });
  let summary = clampStr(body.summary, 800), engine = body.summary ? 'manual' : null, excerpt = clampStr(body.excerpt, 1200);
  if (!summary) {
    const s = await summarizeItem({ title: body.title, content: body.content, description: body.description });
    summary = s.summary; engine = s.engine; excerpt = excerpt || s.excerpt;
  }
  const it = { id: uid('i_'), feedId: null, source: clampStr(body.source, 200) || clampStr(body.author, 120) || 'Import',
    guid: body.guid || body.url || body.title, title: clampStr(body.title, 300) || '(untitled)',
    url: body.url || '', author: clampStr(body.author, 120),
    publishedAt: body.publishedAt || Date.now(), addedAt: Date.now(),
    summary, engine, excerpt, tags: Array.isArray(body.tags) ? body.tags.slice(0, 12).map(t => clampStr(t, 40)) : [],
    state: 'unread', starred: false, note: '', readAt: null };
  items.push(it); await writeIndex(ITEMS_IDX, items);
  send(res, 201, it);
}

async function patchItem(req, res, id) {
  const items = await readIndex(ITEMS_IDX); const it = items.find(x => x.id === id);
  if (!it) return send(res, 404, { error: 'not found' });
  let body; try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { return send(res, 400, { error: 'invalid json' }); }
  if (['unread', 'reading', 'read', 'archived'].includes(body.state)) {
    it.state = body.state; if (body.state === 'read' && !it.readAt) it.readAt = Date.now();
  }
  if (typeof body.starred === 'boolean') it.starred = body.starred;
  if (typeof body.note === 'string') it.note = clampStr(body.note, 20000);
  if (Array.isArray(body.tags)) it.tags = body.tags.slice(0, 12).map(t => clampStr(t, 40));
  await writeIndex(ITEMS_IDX, items); send(res, 200, it);
}

async function deleteItem(req, res, id) {
  const items = await readIndex(ITEMS_IDX); const i = items.findIndex(x => x.id === id);
  if (i < 0) return send(res, 404, { error: 'not found' });
  items.splice(i, 1); await writeIndex(ITEMS_IDX, items); send(res, 200, { ok: true });
}

// --- router -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, null);
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname, q = url.searchParams;

    if (!p.startsWith('/api/')) return serveStatic(req, res, p);

    if (p === '/api/health') return send(res, 200, { ok: true, name: 'zinester-reference',
      storage: 'fs', sharing: true, camera: MOCK_CAMERA, reader: true,
      summarizer: process.env.ANTHROPIC_API_KEY ? 'claude' : 'extractive',
      maxAssetBytes: MAX_ASSET_BYTES, version: 1 });

    // camera
    if (p === '/api/camera/frame.jpg' && req.method === 'GET') {
      if (!MOCK_CAMERA) return send(res, 404, { error: 'no camera' });
      return cameraFrame(req, res);
    }
    if (p === '/api/camera/capture' && req.method === 'POST') {
      if (!MOCK_CAMERA) return send(res, 404, { error: 'no camera' });
      return cameraCapture(req, res);
    }

    // assets
    if (p === '/api/assets' && req.method === 'GET') return listAssets(req, res, q);
    if (p === '/api/assets' && req.method === 'POST') return createAsset(req, res);
    let mm;
    if ((mm = p.match(/^\/api\/assets\/([^/]+)\/meta$/)) && req.method === 'GET') {
      const list = await readIndex(ASSET_IDX); const m = list.find(a => a.id === mm[1]);
      return m ? send(res, 200, publicAsset(m)) : send(res, 404, { error: 'not found' });
    }
    if ((mm = p.match(/^\/api\/assets\/([^/]+)$/))) {
      if (req.method === 'GET') return getAssetBinary(req, res, mm[1]);
      if (req.method === 'PATCH') return patchAsset(req, res, mm[1]);
      if (req.method === 'DELETE') return deleteAsset(req, res, mm[1]);
    }
    // projects
    if (p === '/api/projects' && req.method === 'GET') return listProjects(req, res, q);
    if (p === '/api/projects' && req.method === 'POST') return createProject(req, res);
    if ((mm = p.match(/^\/api\/projects\/([^/]+)$/))) {
      if (req.method === 'GET') return getProject(req, res, mm[1]);
      if (req.method === 'PUT') return putProject(req, res, mm[1]);
      if (req.method === 'DELETE') return deleteProject(req, res, mm[1]);
    }
    // reader
    if (p === '/api/reader/feeds' && req.method === 'GET') return listFeeds(req, res);
    if (p === '/api/reader/feeds' && req.method === 'POST') return addFeed(req, res);
    if ((mm = p.match(/^\/api\/reader\/feeds\/([^/]+)$/)) && req.method === 'DELETE') return deleteFeed(req, res, mm[1], q);
    if (p === '/api/reader/refresh' && req.method === 'POST') return refreshFeeds(req, res);
    if (p === '/api/reader/items' && req.method === 'GET') return listItems(req, res, q);
    if (p === '/api/reader/items' && req.method === 'POST') return addItem(req, res);
    if ((mm = p.match(/^\/api\/reader\/items\/([^/]+)$/))) {
      if (req.method === 'GET') return getItem(req, res, mm[1]);
      if (req.method === 'PATCH') return patchItem(req, res, mm[1]);
      if (req.method === 'DELETE') return deleteItem(req, res, mm[1]);
    }
    send(res, 404, { error: 'no such route' });
  } catch (e) {
    send(res, e.message === 'payload too large' ? 413 : 500, { error: String(e.message || e) });
  }
});

await ensureDirs();
server.listen(PORT, () => {
  console.log(`Zinester reference server → http://localhost:${PORT}`);
  console.log(`  web:  ${WEB}`);
  console.log(`  data: ${DATA}  (SD-card stand-in)`);
});
