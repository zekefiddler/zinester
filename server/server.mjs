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

// --- tiny fs-backed index helpers ------------------------------------------
async function ensureDirs() {
  await fs.mkdir(ASSET_DIR, { recursive: true });
  await fs.mkdir(PROJ_DIR, { recursive: true });
  for (const f of [ASSET_IDX, PROJ_IDX]) {
    try { await fs.access(f); } catch { await fs.writeFile(f, '[]'); }
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

// --- router -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, null);
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname, q = url.searchParams;

    if (!p.startsWith('/api/')) return serveStatic(req, res, p);

    if (p === '/api/health') return send(res, 200, { ok: true, name: 'zinester-reference',
      storage: 'fs', sharing: true, camera: MOCK_CAMERA, maxAssetBytes: MAX_ASSET_BYTES, version: 1 });

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
