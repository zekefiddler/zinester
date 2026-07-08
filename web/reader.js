// Zinester Reader — a personal reading queue over the /api/reader endpoints.
// Gathers feeds + imported newsletters as items with summaries and attribution,
// lets you triage/note them in daily reading sessions, and hands the good ones
// (credited) to the zine editor via "Send to zine".
//
// Feed fetching + storage live on the reference server, so the Reader needs a
// backend (like the camera does). The editor itself stays fully portable.

import { openStore } from './store.js';

const $ = s => document.querySelector(s);
const el = (t, props = {}, kids = []) => {
  const e = document.createElement(t);
  for (const k in props) {
    if (k === 'style') Object.assign(e.style, props[k]);
    else if (k === 'class') e.className = props[k];
    else if (k === 'html') e.innerHTML = props[k];
    else if (k in e) e[k] = props[k]; else e.setAttribute(k, props[k]);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach(c => c != null && e.append(c.nodeType ? c : document.createTextNode(c)));
  return e;
};
let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = ''; t.append(msg.nodeType ? msg : document.createTextNode(msg));
  t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}

// --- reader API -------------------------------------------------------------
async function api(path, opts = {}) {
  const r = await fetch('/api/reader' + path, {
    ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ('HTTP ' + r.status));
  return r.status === 204 ? null : r.json();
}

// --- state ------------------------------------------------------------------
let store = null, remote = false, health = null;
let items = [], feeds = [];
let filter = 'unread', sourceFilter = null;

// --- helpers ----------------------------------------------------------------
function relDate(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = Date.now(), diff = (now - ts) / 1000;
  if (diff < 3600) return Math.max(1, Math.round(diff / 60)) + 'm ago';
  if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
  if (diff < 86400 * 7) return Math.round(diff / 86400) + 'd ago';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const counts = () => ({
  unread: items.filter(i => (i.state || 'unread') === 'unread').length,
  reading: items.filter(i => i.state === 'reading').length,
  read: items.filter(i => i.state === 'read').length,
  starred: items.filter(i => i.starred).length,
  all: items.length,
});

// --- rendering --------------------------------------------------------------
function renderFilters() {
  const c = counts();
  document.querySelectorAll('#filters button').forEach(b => b.classList.toggle('on', b.dataset.state === filter));
  for (const k in c) { const s = document.querySelector(`.ct[data-ct="${k}"]`); if (s) s.textContent = c[k]; }
}

function renderFeeds() {
  const box = $('#feedList'); box.textContent = '';
  if (!feeds.length) { box.append(el('div', { class: 'muted-note' }, remote ? 'No feeds yet. Add one above.' : 'Feeds need the server.')); return; }
  for (const f of feeds) {
    const unread = items.filter(i => i.feedId === f.id && (i.state || 'unread') === 'unread').length;
    const row = el('div', { class: 'feeditem' + (f.lastError ? ' err' : '') }, [
      el('span', { class: 'fname', title: f.lastError ? ('Last error: ' + f.lastError) : f.url,
        onclick: () => { sourceFilter = (sourceFilter === f.id ? null : f.id); render(); } }, f.title),
      el('span', { class: 'fct' }, String(unread)),
      el('button', { class: 'fx', title: 'Unsubscribe', onclick: async () => {
        if (!confirm(`Remove feed "${f.title}"? (its items stay)`)) return;
        await api('/feeds/' + f.id, { method: 'DELETE' }); await reload(); toast('Feed removed'); } }, '✕'),
    ]);
    box.append(row);
  }
}

function engineBadge(it) {
  const label = { claude: 'AI summary', feed: 'from feed', extractive: 'auto', manual: 'noted' }[it.engine] || it.engine || '';
  return el('span', { class: 'eng ' + (it.engine || '') }, label);
}

function itemCard(it) {
  const st = it.state || 'unread';
  const card = el('div', { class: 'item ' + st });

  card.append(el('div', { class: 'ititle' }, it.url
    ? el('a', { href: it.url, target: '_blank', rel: 'noopener',
        onclick: () => { if (st === 'unread') setState(it, 'reading', true); } }, it.title)
    : it.title));

  const meta = el('div', { class: 'imeta' }, [
    it.source ? el('span', { class: 'src' }, it.source) : null,
    it.author && it.author !== it.source ? el('span', {}, it.author) : null,
    it.publishedAt ? el('span', {}, relDate(it.publishedAt)) : null,
    engineBadge(it),
  ]);
  (it.tags || []).forEach(t => meta.append(el('span', { class: 'chip' }, t)));
  card.append(meta);

  if (it.summary) card.append(el('div', { class: 'isum' }, it.summary));

  // expandable excerpt
  if (it.excerpt && it.excerpt.length > (it.summary || '').length + 20) {
    const ex = el('div', { class: 'iexcerpt', style: { display: 'none' } }, it.excerpt);
    const tog = el('button', { class: 'ghost', style: { fontSize: '12px', padding: '3px 8px', alignSelf: 'flex-start' },
      onclick: () => { const open = ex.style.display === 'none'; ex.style.display = open ? 'block' : 'none'; tog.textContent = open ? '▲ Less' : '▼ Excerpt'; } }, '▼ Excerpt');
    card.append(tog, ex);
  }

  // actions
  const stateBtn = (label, target) => el('button', { class: st === target ? 'on' : '',
    onclick: () => setState(it, st === target ? 'unread' : target) }, label);
  const star = el('button', { class: 'star' + (it.starred ? ' on' : ''), title: 'Star',
    onclick: async () => { it.starred = !it.starred; await patch(it, { starred: it.starred }); render(); } }, it.starred ? '★' : '☆');

  const notesWrap = el('div', { style: { width: '100%', display: it.note ? 'block' : 'none' } });
  const ta = el('textarea', { class: 'note', placeholder: 'Notes for this read…', value: it.note || '' });
  const savedTag = el('span', { class: 'note-saved', style: { display: 'none' } }, ' saved');
  let noteT;
  ta.addEventListener('input', () => { it.note = ta.value; clearTimeout(noteT);
    noteT = setTimeout(async () => { await patch(it, { note: ta.value }); savedTag.style.display = 'inline';
      setTimeout(() => savedTag.style.display = 'none', 1200); }, 700); });
  notesWrap.append(ta, savedTag);

  const actions = el('div', { class: 'iactions' }, [
    stateBtn('Reading', 'reading'), stateBtn('✓ Read', 'read'), star,
    el('button', { onclick: () => { const open = notesWrap.style.display === 'none'; notesWrap.style.display = open ? 'block' : 'none'; if (open) ta.focus(); } }, '📝 Notes'),
    el('span', { class: 'grow' }),
    el('button', { class: 'primary', title: 'Add this article (credited) to a zine', onclick: () => sendToZine(it) }, '➕ Send to zine'),
    el('button', { class: 'danger', title: 'Remove from queue', onclick: async () => {
      if (!confirm('Remove this item from the queue?')) return;
      await api('/items/' + it.id, { method: 'DELETE' }); items = items.filter(x => x.id !== it.id); render(); } }, '🗑'),
  ]);
  card.append(actions, notesWrap);
  return card;
}

function render() {
  renderFilters(); renderFeeds();
  let view = items.slice();
  if (filter === 'starred') view = view.filter(i => i.starred);
  else if (filter !== 'all') view = view.filter(i => (i.state || 'unread') === filter);
  if (sourceFilter) view = view.filter(i => i.feedId === sourceFilter);
  view.sort((a, b) => (b.publishedAt || b.addedAt) - (a.publishedAt || a.addedAt));

  const srcName = sourceFilter ? (feeds.find(f => f.id === sourceFilter) || {}).title : null;
  const head = $('#listHead'); head.textContent = '';
  head.append(el('b', {}, filter[0].toUpperCase() + filter.slice(1)), el('span', {}, view.length + ' item' + (view.length === 1 ? '' : 's')));
  if (srcName) head.append(el('button', { class: 'ghost', style: { fontSize: '11px', padding: '2px 8px' }, onclick: () => { sourceFilter = null; render(); } }, '✕ ' + srcName));

  const list = $('#list'); list.textContent = '';
  if (!view.length) {
    list.append(el('div', { class: 'empty' }, remote
      ? (items.length ? 'Nothing here — try another filter.' : 'Queue is empty. Hit ↻ Refresh to pull your feeds, or import newsletters.')
      : 'The reading queue lives on the reference server.'));
  } else view.forEach(it => list.append(itemCard(it)));
}

// --- mutations --------------------------------------------------------------
async function patch(it, body) {
  try { const up = await api('/items/' + it.id, { method: 'PATCH', body: JSON.stringify(body) }); Object.assign(it, up); }
  catch (e) { toast('Save failed: ' + e.message); }
}
async function setState(it, state, silent) {
  it.state = state; if (state === 'read') it.readAt = Date.now();
  await patch(it, { state }); render(); if (!silent) toast('Marked ' + state);
}

// --- send to zine -----------------------------------------------------------
const PX_PER_MM = 96 / 25.4;
const auid = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function blankPanel() { return { id: auid(), bg: '#ffffff', assets: [] }; }

function clipPanel(it) {
  // mini8 A4 panel is ~74.25 x 105 mm. Lay title / summary / attribution.
  const W = (297 / 4) * PX_PER_MM, m = 16, w = W - m * 2;
  const txt = (o) => Object.assign({ id: auid(), type: 'text', x: m, w, rot: 0, opacity: 1,
    fontFamily: 'system-ui', color: '#111', align: 'left', bold: false, italic: false }, o);
  const date = it.publishedAt ? new Date(it.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  const credit = '— ' + [it.author, it.source].filter(Boolean).join(', ') + (date ? ' · ' + date : '') + (it.url ? '\n' + it.url : '');
  return {
    id: auid(), bg: '#ffffff', assets: [
      txt({ text: it.title, y: 16, h: 110, fontSize: 16, bold: true, color: '#111' }),
      txt({ text: it.summary || '', y: 134, h: 170, fontSize: 11, color: '#222' }),
      txt({ text: credit, y: 322, h: 62, fontSize: 9, italic: true, color: '#555' }),
    ],
  };
}

async function sendToZine(it) {
  try {
    const clip = clipPanel(it);
    const list = (await store.listProjects({ scope: 'mine' }))
      .filter(p => /^Reading Clippings/i.test(p.name)).sort((a, b) => b.updatedAt - a.updatedAt);
    let doc = null, existingId = null;
    for (const p of list) {
      const full = await store.getProject(p.id); const d = full.data || full;
      if (d && d.panels && d.panels.some(pl => !pl.assets || pl.assets.length === 0)) { doc = d; existingId = p.id; break; }
    }
    if (!doc) {
      const n = list.length ? ' ' + (list.length + 1) : '';
      doc = { version: 1, name: 'Reading Clippings' + n, format: 'mini8', paper: 'A4',
        visibility: 'private', panels: Array.from({ length: 8 }, blankPanel) };
    }
    const idx = doc.panels.findIndex(pl => !pl.assets || pl.assets.length === 0);
    doc.panels[idx] = clip;
    if (existingId) doc.id = existingId;
    const saved = await store.saveProject(doc);
    const pid = saved.id || existingId;
    await setState(it, 'read', true);
    const link = el('a', { href: 'index.html?project=' + encodeURIComponent(pid), style: { color: 'var(--accent)', fontWeight: '700' } }, 'Open in editor →');
    toast(el('span', {}, [`Added to "${doc.name}" (page ${idx + 1}). `, link]), 6000);
  } catch (e) { toast('Send to zine failed: ' + e.message); }
}

// --- feeds: add / refresh ---------------------------------------------------
async function addFeed() {
  const inp = $('#addFeedUrl'); let url = inp.value.trim();
  if (!url) return; if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const btn = $('#btnAddFeed'); btn.disabled = true; btn.textContent = '…';
  try { const r = await api('/feeds', { method: 'POST', body: JSON.stringify({ url }) });
    inp.value = ''; await reload(); toast(`Added ${r.feed.title} — ${r.added} new item${r.added === 1 ? '' : 's'}`); }
  catch (e) { toast('Could not add feed: ' + e.message, 4000); }
  finally { btn.disabled = false; btn.textContent = '＋ Feed'; }
}
async function refresh() {
  const btn = $('#btnRefresh'); btn.disabled = true; const old = btn.textContent; btn.textContent = '↻ …';
  try { const r = await api('/refresh', { method: 'POST', body: JSON.stringify({}) });
    await reload(); toast(r.added ? `${r.added} new item${r.added === 1 ? '' : 's'}` : 'No new items');
    const errs = (r.feeds || []).filter(f => f.lastError);
    if (errs.length) toast(`${errs.length} feed(s) errored — see the feed list`, 4000); }
  catch (e) { toast('Refresh failed: ' + e.message, 4000); }
  finally { btn.disabled = false; btn.textContent = old; }
}

async function reload() {
  [feeds, items] = await Promise.all([
    api('/feeds').then(r => r.feeds).catch(() => []),
    api('/items?state=all').then(r => r.items).catch(() => []),
  ]);
  render();
}

// --- daily reading timer ----------------------------------------------------
const timer = { goal: 45, elapsed: 0, running: false, startTs: 0, tick: null };
const dayKey = () => 'zinester.reader.timer.' + new Date().toISOString().slice(0, 10);
function fmt(sec) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return m + ':' + String(s).padStart(2, '0'); }
function timerElapsedSec() { return (timer.elapsed + (timer.running ? Date.now() - timer.startTs : 0)) / 1000; }
function saveTimer() { localStorage.setItem(dayKey(), JSON.stringify({ goal: timer.goal, elapsed: timer.elapsed })); }
function loadTimer() {
  try { const s = JSON.parse(localStorage.getItem(dayKey()) || '{}');
    if (s.elapsed) timer.elapsed = s.elapsed; if (s.goal) timer.goal = s.goal; } catch {}
  $('#timerGoal').value = String(timer.goal);
}
function paintTimer() {
  const sec = timerElapsedSec(), goalSec = timer.goal * 60, pct = Math.min(100, (sec / goalSec) * 100);
  $('#timerElapsed').textContent = fmt(sec);
  $('#timerTarget').textContent = '/ ' + timer.goal + ':00';
  $('#timerFill').style.width = pct + '%';
  const done = sec >= goalSec;
  $('#timerCard').classList.toggle('done', done);
  $('#timerNote').textContent = done ? `You hit your ${timer.goal}-minute session. 🎉`
    : (timer.running ? 'Reading… stay with one piece at a time.' : 'Set a goal and start a focused reading block.');
}
function startTimer() {
  if (timer.running) return; timer.running = true; timer.startTs = Date.now();
  $('#btnTimer').textContent = '⏸ Pause'; timer.tick = setInterval(paintTimer, 1000); paintTimer();
}
function pauseTimer() {
  if (!timer.running) return; timer.elapsed += Date.now() - timer.startTs; timer.running = false;
  clearInterval(timer.tick); $('#btnTimer').textContent = '▶ Start'; saveTimer(); paintTimer();
}

// --- boot -------------------------------------------------------------------
async function boot() {
  store = await openStore();
  remote = !!store.remote; health = store.health || null;
  $('#connBadge').textContent = remote ? 'device' : 'local';
  $('#connBadge').className = 'badge ' + (remote ? 'live' : 'local');
  if (health && health.summarizer) {
    const b = $('#sumBadge'); b.style.display = 'inline';
    b.textContent = health.summarizer === 'claude' ? 'AI summaries' : 'auto summaries';
    b.className = 'badge ' + (health.summarizer === 'claude' ? 'live' : 'local');
  }

  if (!remote || !(health && health.reader)) {
    const b = $('#banner'); b.style.display = 'block';
    b.innerHTML = 'The Reader fetches feeds server-side, so it needs the reference backend. Run <code>node server/server.mjs</code> (or <code>npm start</code>) and open this page from it. The zine <a href="index.html">editor</a> works offline without it.';
    $('#btnAddFeed').disabled = $('#btnRefresh').disabled = true;
  }

  // filters
  document.querySelectorAll('#filters button').forEach(b =>
    b.onclick = () => { filter = b.dataset.state; sourceFilter = null; render(); });
  $('#btnAddFeed').onclick = addFeed;
  $('#addFeedUrl').addEventListener('keydown', e => { if (e.key === 'Enter') addFeed(); });
  $('#btnRefresh').onclick = refresh;

  // timer
  loadTimer(); paintTimer();
  $('#btnTimer').onclick = () => (timer.running ? pauseTimer() : startTimer());
  $('#btnTimerReset').onclick = () => { pauseTimer(); timer.elapsed = 0; saveTimer(); paintTimer(); };
  $('#timerGoal').onchange = e => { timer.goal = parseInt(e.target.value, 10); saveTimer(); paintTimer(); };
  window.addEventListener('beforeunload', () => { if (timer.running) { timer.elapsed += Date.now() - timer.startTs; saveTimer(); } });

  if (remote) await reload(); else render();
}
boot();
