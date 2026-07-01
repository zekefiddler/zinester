// Zinester storage layer.
//
// One interface, three implementations. The editor talks only to the object
// returned by `openStore()` and never cares whether it's backed by an ESP32/SD
// card, the reference Node server, or purely the browser (IndexedDB).
//
//   const store = await openStore();
//   store.remote          -> true if a device/server backend is present
//   store.author          -> { id, name }
//   store.setAuthorName(n)
//   store.putAsset(file|dataUrl, {name,w,h,visibility}) -> assetMeta {id,url,...}
//   store.listAssets({scope})                            -> [assetMeta]
//   store.updateAsset(id, {visibility,name})             -> assetMeta
//   store.deleteAsset(id)
//   store.assetURL(meta)  -> URL usable as <img src>
//   store.listProjects({scope}) / getProject(id) / saveProject(doc) / deleteProject(id)

const AUTHOR_KEY = 'zinester.authorId';
const NAME_KEY   = 'zinester.authorName';

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxxyxxx4xxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}
function getAuthor() {
  let id = localStorage.getItem(AUTHOR_KEY);
  if (!id) { id = uuid(); localStorage.setItem(AUTHOR_KEY, id); }
  return { id, name: localStorage.getItem(NAME_KEY) || '' };
}

// Normalize an input (File, Blob, or data URL string) to { dataUrl, mime }.
function toDataURL(input) {
  if (typeof input === 'string') return Promise.resolve({ dataUrl: input, mime: (input.match(/^data:([^;,]+)/) || [])[1] || 'application/octet-stream' });
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ dataUrl: r.result, mime: input.type || 'application/octet-stream' });
    r.onerror = reject; r.readAsDataURL(input);
  });
}
function imageSize(dataUrl) {
  return new Promise(resolve => { const i = new Image();
    i.onload = () => resolve({ w: i.naturalWidth, h: i.naturalHeight });
    i.onerror = () => resolve({ w: null, h: null }); i.src = dataUrl; });
}

// ---------------------------------------------------------------------------
// RemoteStore — talks to /api (reference server or ESP32 firmware)
// ---------------------------------------------------------------------------
class RemoteStore {
  constructor(base, health) { this.base = base; this.health = health; this.remote = true;
    this.author = getAuthor(); }
  _headers(extra = {}) {
    const h = { 'X-Zinester-Author': this.author.id, ...extra };
    if (this.author.name) h['X-Zinester-Author-Name'] = encodeURIComponent(this.author.name);
    return h;
  }
  setAuthorName(n) { this.author.name = n; localStorage.setItem(NAME_KEY, n); }
  async _json(path, opts = {}) {
    const r = await fetch(this.base + path, { ...opts, headers: this._headers(opts.headers || {}) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    return r.status === 204 ? null : r.json();
  }
  async putAsset(input, meta = {}) {
    const { dataUrl, mime } = await toDataURL(input);
    const dim = (meta.w && meta.h) ? { w: meta.w, h: meta.h } : await imageSize(dataUrl);
    const body = JSON.stringify({ name: meta.name || (input.name || 'asset'), dataUrl,
      w: dim.w, h: dim.h, visibility: meta.visibility || 'private' });
    return this._json('/api/assets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  }
  async listAssets({ scope = 'shared' } = {}) { return (await this._json('/api/assets?scope=' + scope)).assets; }
  updateAsset(id, patch) { return this._json('/api/assets/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); }
  deleteAsset(id) { return this._json('/api/assets/' + id, { method: 'DELETE' }); }
  assetURL(meta) { return this.base + (meta.url || ('/api/assets/' + meta.id)); }

  async listProjects({ scope = 'mine' } = {}) { return (await this._json('/api/projects?scope=' + scope)).projects; }
  getProject(id) { return this._json('/api/projects/' + id); }
  async saveProject(doc) {
    if (doc.id) return this._json('/api/projects/' + doc.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) });
    return this._json('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) });
  }
  deleteProject(id) { return this._json('/api/projects/' + id, { method: 'DELETE' }); }
}

// ---------------------------------------------------------------------------
// LocalStore — browser-only (IndexedDB for asset blobs, localStorage for meta).
// Single-user: "shared" simply means it shows in your own gallery.
// ---------------------------------------------------------------------------
class LocalStore {
  constructor() { this.remote = false; this.author = getAuthor(); this._db = null; this._urls = new Map(); }
  setAuthorName(n) { this.author.name = n; localStorage.setItem(NAME_KEY, n); }
  _open() {
    if (this._db) return this._db;
    this._db = new Promise((resolve, reject) => {
      const req = indexedDB.open('zinester', 1);
      req.onupgradeneeded = () => { const db = req.result;
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' }); };
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    return this._db;
  }
  async _tx(store, mode, fn) { const db = await this._open();
    return new Promise((resolve, reject) => { const tx = db.transaction(store, mode);
      const os = tx.objectStore(store); const rq = fn(os);
      tx.oncomplete = () => resolve(rq && rq.result); tx.onerror = () => reject(tx.error); }); }
  _all(store) { return this._tx(store, 'readonly', os => os.getAll()); }

  async putAsset(input, meta = {}) {
    const { dataUrl, mime } = await toDataURL(input);
    const dim = (meta.w && meta.h) ? { w: meta.w, h: meta.h } : await imageSize(dataUrl);
    const blob = await (await fetch(dataUrl)).blob();
    const rec = { id: 'a_' + uuid(), name: meta.name || (input.name || 'asset'), mime, blob,
      size: blob.size, w: dim.w, h: dim.h, visibility: meta.visibility || 'private',
      authorId: this.author.id, authorName: this.author.name, createdAt: Date.now() };
    await this._tx('assets', 'readwrite', os => os.put(rec));
    return this._meta(rec);
  }
  _meta(r) { const { blob, ...m } = r; return { ...m, url: null }; }
  async listAssets({ scope = 'shared' } = {}) {
    const all = await this._all('assets');
    return all.filter(a => scope === 'mine' || scope === 'all' ? true : a.visibility === 'shared')
      .sort((a, b) => b.createdAt - a.createdAt).map(r => this._meta(r));
  }
  async updateAsset(id, patch) {
    const r = await this._tx('assets', 'readonly', os => os.get(id)); if (!r) throw new Error('not found');
    Object.assign(r, patch); await this._tx('assets', 'readwrite', os => os.put(r)); return this._meta(r);
  }
  async deleteAsset(id) { const u = this._urls.get(id); if (u) { URL.revokeObjectURL(u); this._urls.delete(id); }
    await this._tx('assets', 'readwrite', os => os.delete(id)); return { ok: true }; }
  // NOTE: async in LocalStore — callers must await assetURL() (RemoteStore is sync,
  // but the editor always awaits it so both paths work).
  async assetURL(meta) {
    if (this._urls.has(meta.id)) return this._urls.get(meta.id);
    const r = await this._tx('assets', 'readonly', os => os.get(meta.id));
    if (!r) return meta.src || '';
    const u = URL.createObjectURL(r.blob); this._urls.set(meta.id, u); return u;
  }

  async listProjects({ scope = 'mine' } = {}) { const all = await this._all('projects');
    return all.sort((a, b) => b.updatedAt - a.updatedAt).map(({ data, ...m }) => m); }
  async getProject(id) { return this._tx('projects', 'readonly', os => os.get(id)); }
  async saveProject(doc) {
    const id = doc.id || ('p_' + uuid());
    const rec = { id, name: doc.name || 'Untitled', format: doc.format, visibility: doc.visibility || 'private',
      authorId: this.author.id, authorName: this.author.name, updatedAt: Date.now(), thumb: doc.thumb || null,
      data: { ...doc, id } };
    await this._tx('projects', 'readwrite', os => os.put(rec)); const { data, ...m } = rec; return m;
  }
  async deleteProject(id) { await this._tx('projects', 'readwrite', os => os.delete(id)); return { ok: true }; }
}

// ---------------------------------------------------------------------------
// openStore — probe for a backend, else fall back to the browser.
// ---------------------------------------------------------------------------
export async function openStore(base = '') {
  try {
    const ctrl = AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined;
    const r = await fetch(base + '/api/health', { signal: ctrl });
    if (r.ok) { const health = await r.json(); if (health && health.ok) return new RemoteStore(base, health); }
  } catch { /* no backend — offline/static host */ }
  return new LocalStore();
}
