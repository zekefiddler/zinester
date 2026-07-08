// Zinester editor. Talks to the storage layer (store.js) which may be backed by
// an ESP32/SD card, the reference server, or the browser — the editor doesn't
// care. See docs/API.md for the contract and the project document format.
import { openStore } from './store.js';

// --- constants & formats ----------------------------------------------------
const PX_PER_MM = 96 / 25.4;                 // base px == physical mm at 96dpi
const PAPER = { A4: { w: 210, h: 297 }, Letter: { w: 215.9, h: 279.4 } };
const EXPORT_DPI = 300;
const LS_KEY = 'zinester.project.v1';

const FORMATS = {
  mini8: { label: 'Mini Zine · 8 page', sheet: 'landscape', cols: 4, rows: 2, pages: 8,
    cell2page: [4, 3, 2, 1, 5, 6, 7, 0], cell2rot: [180, 180, 180, 180, 0, 0, 0, 0],
    fold: 'Print single-sided. Fold in half three times to crease 8 rectangles, unfold to a hamburger fold, cut a slit along the centre crease between the two middle panels, open flat, then push the ends together and fold around into a booklet. Page 1 is the front cover.' },
  half2: { label: 'Half-fold Card · 2 panel', sheet: 'landscape', cols: 2, rows: 1, pages: 2,
    cell2page: [1, 0], cell2rot: [0, 0],
    fold: 'Print single-sided. Fold once down the vertical centre. Page 1 is the front, page 2 the back.' },
  accordion: { label: 'Accordion · N panel', sheet: 'landscape', dynamic: true, rows: 1, pages: 4,
    fold: 'Print single-sided. Fold zig-zag (mountain/valley) along each division so the panels concertina in order 1,2,3…' },
  single1: { label: 'Single Page / Poster', sheet: 'portrait', cols: 1, rows: 1, pages: 1,
    cell2page: [0], cell2rot: [0], fold: 'A single full page — no folding. Print and go.' },
};

// --- state ------------------------------------------------------------------
let store = null;
let project = null;
let selId = null, activePanel = 0, editorScale = 1;
let showGrid = false, snap = false, einkMode = false;
let history = [], future = [];
let galleryScope = 'shared', imgReplaceTarget = null;
let uidc = 1;
const uid = () => 'a' + (uidc++) + '_' + Date.now().toString(36);

const $ = s => document.querySelector(s);
const el = (t, props = {}, kids = []) => {
  const e = document.createElement(t);
  for (const k in props) {
    if (k === 'style') Object.assign(e.style, props[k]);
    else if (k === 'class') e.className = props[k];
    else if (k in e) e[k] = props[k]; else e.setAttribute(k, props[k]);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach(c => c != null && e.append(c.nodeType ? c : document.createTextNode(c)));
  return e;
};

// --- geometry ---------------------------------------------------------------
function geom(p = project) {
  const f = FORMATS[p.format];
  const cols = f.dynamic ? p.panels.length : f.cols;
  const rows = f.rows;
  const paper = PAPER[p.paper] || PAPER.A4;
  const long = Math.max(paper.w, paper.h), short = Math.min(paper.w, paper.h);
  const sheetW = f.sheet === 'landscape' ? long : short;
  const sheetH = f.sheet === 'landscape' ? short : long;
  const panelWmm = sheetW / cols, panelHmm = sheetH / rows;
  const cell2page = f.dynamic ? p.panels.map((_, i) => i) : f.cell2page;
  const cell2rot = f.dynamic ? p.panels.map(() => 0) : f.cell2rot;
  return { f, cols, rows, sheetW, sheetH, panelWmm, panelHmm, cell2page, cell2rot,
    baseW: panelWmm * PX_PER_MM, baseH: panelHmm * PX_PER_MM,
    pages: f.dynamic ? p.panels.length : f.pages };
}

// --- project lifecycle ------------------------------------------------------
function blankPanel() { return { id: uid(), bg: '#ffffff', assets: [] }; }
function newProject(format = 'mini8') {
  const pages = FORMATS[format].dynamic ? 4 : FORMATS[format].pages;
  return { version: 1, name: 'Untitled', format, paper: 'A4', visibility: 'private',
    panels: Array.from({ length: pages }, blankPanel) };
}
function ensurePanels() {
  const f = FORMATS[project.format];
  const want = f.dynamic ? Math.max(2, project.panels.length) : f.pages;
  while (project.panels.length < want) project.panels.push(blankPanel());
  if (!f.dynamic) project.panels.length = want;
  activePanel = Math.max(0, Math.min(activePanel, project.panels.length - 1));
}
function activeAssets() { return project.panels[activePanel].assets; }
function findAsset(id) { return activeAssets().find(a => a.id === id); }
function selected() { return selId ? findAsset(selId) : null; }

// --- history + autosave -----------------------------------------------------
// _url is a runtime-only resolved image URL; never persist it.
function serializeDoc() {
  return JSON.parse(JSON.stringify(project, (k, v) => k === '_url' ? undefined : v));
}
function snapshot() { return JSON.stringify({ project: serializeDoc(), activePanel }); }
function pushHistory() { history.push(snapshot()); if (history.length > 120) history.shift(); future.length = 0; updateUndo(); autosave(); }
async function restore(s) { const o = JSON.parse(s); project = o.project; activePanel = o.activePanel; selId = null; await resolveAssetURLs(); }
async function undo() { if (!history.length) return; future.push(snapshot()); await restore(history.pop()); syncControls(); render(); updateUndo(); autosave(); }
async function redo() { if (!future.length) return; history.push(snapshot()); await restore(future.pop()); syncControls(); render(); updateUndo(); autosave(); }
function updateUndo() { $('#btnUndo').disabled = !history.length; $('#btnRedo').disabled = !future.length; }

let saveTimer = null;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(serializeDoc()));
      $('#autosaveNote').textContent = 'Autosaved locally · ' + new Date().toLocaleTimeString(); }
    catch { $('#autosaveNote').textContent = 'Autosave failed (storage full?)'; }
  }, 400);
}
function loadAutosave() { try { const s = localStorage.getItem(LS_KEY); if (s) { const p = JSON.parse(s);
  if (p && p.panels && FORMATS[p.format]) return p; } } catch {} return null; }

// --- asset URL resolution ---------------------------------------------------
// Image assets reference a stored asset by assetId; resolve display URLs at
// load time so LocalStore (object URLs) and RemoteStore (/api URLs) both work.
async function resolveAssetURLs() {
  for (const panel of project.panels) for (const a of panel.assets) {
    if (a.type === 'image' && a.assetId && !a._url) {
      try { a._url = await store.assetURL({ id: a.assetId, url: a.src, src: a.src }); }
      catch { a._url = a.src || ''; }
    }
  }
}

// --- add / place assets -----------------------------------------------------
function addAsset(type, extra = {}) {
  const g = geom();
  const base = { id: uid(), type, x: 0, y: 0, w: g.baseW * 0.4, h: g.baseH * 0.2, rot: 0, opacity: 1 };
  let a;
  if (type === 'text') a = { ...base, w: g.baseW * 0.6, h: g.baseH * 0.16, text: 'Double-click to edit',
    fontSize: Math.round(g.baseH * 0.05), fontFamily: 'system-ui', color: '#111111', align: 'left', bold: false, italic: false, lineHeight: 1.2 };
  else if (type === 'rect') a = { ...base, w: g.baseW * 0.4, h: g.baseH * 0.25, fill: '#6ea8fe', stroke: '#000000', strokeWidth: 0, radius: 0 };
  else if (type === 'ellipse') a = { ...base, w: g.baseW * 0.35, h: g.baseH * 0.25, fill: '#8b5cf6', stroke: '#000000', strokeWidth: 0 };
  else if (type === 'line') a = { ...base, w: g.baseW * 0.6, h: Math.max(3, g.baseH * 0.006), fill: '#111111' };
  else if (type === 'image') a = { ...base, w: extra.w || g.baseW * 0.6, h: extra.h || g.baseH * 0.4 };
  a = { ...a, ...extra, id: a.id, type };
  a.x = extra.x != null ? extra.x : g.baseW / 2 - a.w / 2;
  a.y = extra.y != null ? extra.y : g.baseH / 2 - a.h / 2;
  activeAssets().push(a);
  selId = a.id; pushHistory(); render();
  return a;
}

async function uploadFiles(files, { place = true } = {}) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try {
      const meta = await store.putAsset(f, { visibility: 'private', name: f.name });
      if (place) await placeAsset(meta);
      toast(store.remote ? 'Uploaded to device' : 'Added to library');
    } catch (e) { toast('Upload failed: ' + e.message); }
  }
  refreshGallery();
}
async function placeAsset(meta, dropXY) {
  const url = await store.assetURL(meta);
  const g = geom(); const maxW = g.baseW * 0.7, maxH = g.baseH * 0.7;
  let w = meta.w || 300, h = meta.h || 200; const r = Math.min(maxW / w, maxH / h, 1); w *= r; h *= r;
  const extra = { assetId: meta.id, src: store.remote ? store.assetURL(meta) : null, _url: url, w, h };
  if (dropXY) { extra.x = dropXY.x - w / 2; extra.y = dropXY.y - h / 2; }
  addAsset('image', extra);
}

// --- rendering --------------------------------------------------------------
function computeScale() {
  const g = geom(); const wrap = $('#stagewrap');
  editorScale = Math.min((wrap.clientWidth - 44) / g.baseW, (wrap.clientHeight - 44) / g.baseH);
  editorScale = Math.max(0.05, Math.min(editorScale, 3));
}
function render() {
  ensurePanels();
  const g = geom(); computeScale();
  const stage = $('#stage');
  stage.style.width = (g.baseW * editorScale) + 'px';
  stage.style.height = (g.baseH * editorScale) + 'px';
  let box = stage.querySelector('.panelBox');
  if (!box) { box = el('div', { class: 'panelBox' }); stage.prepend(box); }
  box.style.transform = `scale(${editorScale})`; box.style.transformOrigin = 'top left';
  box.style.width = g.baseW + 'px'; box.style.height = g.baseH + 'px';
  box.style.background = project.panels[activePanel].bg || '#fff';
  box.innerHTML = '';
  if (showGrid) { const ov = el('div', { class: 'grid-ov' }); const step = g.baseW / 12;
    ov.style.backgroundSize = `${step}px ${step}px, ${step}px ${step}px`; box.append(ov); }
  activeAssets().forEach(a => box.append(renderAsset(a)));
  $('#stagepad').innerHTML = ''; const sel = selected(); if (sel) drawSelection(sel);
  renderTabs();
  $('#pageLabel').textContent = `Page ${activePanel + 1} / ${g.pages}`;
  $('#projName').textContent = project.name || 'Untitled';
  renderInspector();
  document.body.classList.toggle('eink', einkMode);
}
function styleAsset(a, e) {
  e.style.left = a.x + 'px'; e.style.top = a.y + 'px';
  e.style.width = a.w + 'px'; e.style.height = a.h + 'px';
  e.style.transform = `rotate(${a.rot || 0}deg)`;
  e.style.opacity = a.opacity == null ? 1 : a.opacity;
}
function renderAsset(a) {
  let e;
  if (a.type === 'text') {
    e = el('div', { class: 'asset text' });
    const t = el('div', { class: 'txt' }); t.textContent = a.text || '';
    Object.assign(t.style, { fontSize: a.fontSize + 'px', fontFamily: a.fontFamily || 'system-ui',
      color: a.color || '#111', textAlign: a.align || 'left', fontWeight: a.bold ? '700' : '400',
      fontStyle: a.italic ? 'italic' : 'normal', lineHeight: a.lineHeight || 1.2 });
    e.append(t);
  } else if (a.type === 'image') {
    e = el('div', { class: 'asset image' });
    const src = a._url || a.src; if (src) e.append(el('img', { src, alt: '' }));
  } else if (a.type === 'rect') {
    e = el('div', { class: 'asset rect' });
    e.style.background = a.fill; e.style.borderRadius = (a.radius || 0) + 'px';
    if (a.strokeWidth > 0) e.style.border = `${a.strokeWidth}px solid ${a.stroke}`;
  } else if (a.type === 'ellipse') {
    e = el('div', { class: 'asset ellipse' });
    e.style.background = a.fill; e.style.borderRadius = '50%';
    if (a.strokeWidth > 0) e.style.border = `${a.strokeWidth}px solid ${a.stroke}`;
  } else if (a.type === 'line') {
    e = el('div', { class: 'asset line' }); e.style.background = a.fill;
  }
  styleAsset(a, e);
  if (a.id === selId) e.classList.add('selected');
  e.dataset.id = a.id;
  e.addEventListener('pointerdown', ev => onAssetDown(ev, a));
  if (a.type === 'text') e.addEventListener('dblclick', () => editText(a, e));
  return e;
}
function drawSelection(a) {
  const pad = $('#stagepad'); const s = editorScale;
  const cx = (a.x + a.w / 2) * s, cy = (a.y + a.h / 2) * s, hw = a.w / 2 * s, hh = a.h / 2 * s;
  const wrap = el('div', { style: { position: 'absolute', left: cx + 'px', top: cy + 'px', width: '0', height: '0', transform: `rotate(${a.rot || 0}deg)` } });
  [['nw', -hw, -hh], ['ne', hw, -hh], ['se', hw, hh], ['sw', -hw, hh], ['n', 0, -hh], ['s', 0, hh], ['e', hw, 0], ['w', -hw, 0]]
    .forEach(([k, dx, dy]) => { const h = el('div', { class: 'handle ' + k, style: { left: dx + 'px', top: dy + 'px' } });
      h.addEventListener('pointerdown', ev => onResizeDown(ev, a, k)); wrap.append(h); });
  wrap.append(el('div', { class: 'rotline', style: { top: (-hh - 26) + 'px', height: '26px' } }));
  const rh = el('div', { class: 'handle rot', style: { left: '0px', top: (-hh - 30) + 'px' } });
  rh.addEventListener('pointerdown', ev => onRotateDown(ev, a)); wrap.append(rh);
  pad.append(wrap);
}

// --- pointer interactions ---------------------------------------------------
function onStagePadDown(ev) { if (ev.target.id === 'stagepad') { selId = null; render(); } }
function onAssetDown(ev, a) {
  ev.stopPropagation(); if (ev.target.isContentEditable) return;
  selId = a.id; render();
  const s = editorScale, startX = ev.clientX, startY = ev.clientY, ox = a.x, oy = a.y; let moved = false;
  const move = e => { let nx = ox + (e.clientX - startX) / s, ny = oy + (e.clientY - startY) / s;
    if (snap) { const g = geom(); const step = g.baseW / 24; nx = Math.round(nx / step) * step; ny = Math.round(ny / step) * step; }
    a.x = nx; a.y = ny; moved = true; quickUpdate(a); drawSelReplace(a); };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (moved) pushHistory(); render(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}
function onResizeDown(ev, a, k) {
  ev.stopPropagation(); ev.preventDefault();
  const s = editorScale, startX = ev.clientX, startY = ev.clientY;
  const o = { x: a.x, y: a.y, w: a.w, h: a.h }, rad = (a.rot || 0) * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const keepAspect = a.type === 'image' || a.type === 'ellipse';
  const move = e => {
    const dx = (e.clientX - startX) / s, dy = (e.clientY - startY) / s;
    const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
    const east = k.includes('e'), west = k.includes('w'), north = k.includes('n'), south = k.includes('s');
    let nw = o.w, nh = o.h;
    if (east) nw = Math.max(6, o.w + lx); if (west) nw = Math.max(6, o.w - lx);
    if (south) nh = Math.max(6, o.h + ly); if (north) nh = Math.max(6, o.h - ly);
    if (keepAspect && (east || west) && (north || south)) nh = nw / (o.w / o.h);
    const dW = nw - o.w, dH = nh - o.h;
    const halfDx = (west ? -dW : east ? dW : 0) / 2, halfDy = (north ? -dH : south ? dH : 0) / 2;
    const scx = halfDx * cos - halfDy * sin, scy = halfDx * sin + halfDy * cos;
    const cxo = o.x + o.w / 2, cyo = o.y + o.h / 2;
    a.w = nw; a.h = nh; a.x = (cxo + scx) - nw / 2; a.y = (cyo + scy) - nh / 2;
    quickUpdate(a); drawSelReplace(a);
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); pushHistory(); render(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}
function onRotateDown(ev, a) {
  ev.stopPropagation(); ev.preventDefault();
  const stage = $('#stage').getBoundingClientRect(), s = editorScale;
  const cx = stage.left + (a.x + a.w / 2) * s, cy = stage.top + (a.y + a.h / 2) * s;
  const move = e => { let ang = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI + 90;
    if (e.shiftKey) ang = Math.round(ang / 15) * 15; a.rot = Math.round(ang); quickUpdate(a); drawSelReplace(a); };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); pushHistory(); render(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}
function quickUpdate(a) { const e = $('#stage').querySelector(`.asset[data-id="${a.id}"]`); if (e) styleAsset(a, e);
  if (a.type === 'text') { const t = e && e.querySelector('.txt'); if (t) t.style.fontSize = a.fontSize + 'px'; } }
function drawSelReplace(a) { $('#stagepad').innerHTML = ''; drawSelection(a); }
function editText(a, e) {
  const t = e.querySelector('.txt'); t.contentEditable = 'true'; t.focus();
  const range = document.createRange(); range.selectNodeContents(t);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  const done = () => { t.contentEditable = 'false'; a.text = t.innerText; t.removeEventListener('blur', done); pushHistory(); render(); };
  t.addEventListener('blur', done);
}

// --- inspector --------------------------------------------------------------
function field(label, inputEl) { const f = el('div', { class: 'field' }); f.append(el('label', {}, label), inputEl); return f; }
function numInput(val, step, fn) { const i = el('input', { type: 'number', value: Math.round(val), step: step || 1 });
  i.addEventListener('input', () => fn(parseFloat(i.value) || 0)); i.addEventListener('change', pushHistory); return i; }
function colorInput(val, fn) { const i = el('input', { type: 'color', value: val || '#000000' });
  i.addEventListener('input', () => { fn(i.value); quickUpdate(selected()); }); i.addEventListener('change', pushHistory); return i; }
function renderInspector() {
  const a = selected();
  $('#inspEmpty').style.display = a ? 'none' : 'block';
  $('#inspAsset').style.display = a ? 'block' : 'none';
  if (!a) return;
  $('#inspTitle').textContent = { text: 'Text', image: 'Image', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line' }[a.type];
  const body = $('#inspBody'); body.innerHTML = '';
  if (a.type === 'text') {
    const ta = el('textarea'); ta.value = a.text;
    ta.addEventListener('input', () => { a.text = ta.value; quickUpdate(a); render2(); });
    ta.addEventListener('change', pushHistory); body.append(ta);
    const font = el('select');
    ['system-ui', 'Georgia', 'Times New Roman', 'Courier New', 'Arial', 'Impact', 'Comic Sans MS', 'Trebuchet MS', 'Verdana']
      .forEach(f => { const o = el('option', { value: f }, f); if (a.fontFamily === f) o.selected = true; font.append(o); });
    font.addEventListener('change', () => { a.fontFamily = font.value; render(); pushHistory(); });
    body.append(field('Font', font));
    body.append(field('Size', numInput(a.fontSize, 1, v => { a.fontSize = Math.max(6, v); render2(); })));
    body.append(field('Colour', colorInput(a.color, v => a.color = v)));
    const al = el('select'); [['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['justify', 'Justify']]
      .forEach(([v, l]) => { const o = el('option', { value: v }, l); if (a.align === v) o.selected = true; al.append(o); });
    al.addEventListener('change', () => { a.align = al.value; render(); pushHistory(); });
    body.append(field('Align', al));
    const bi = el('div', { class: 'row' });
    const b = el('button', { class: a.bold ? 'primary' : '' }, 'B'); b.style.fontWeight = '800';
    b.onclick = () => { a.bold = !a.bold; render(); pushHistory(); };
    const it = el('button', { class: a.italic ? 'primary' : '' }, 'I'); it.style.fontStyle = 'italic';
    it.onclick = () => { a.italic = !a.italic; render(); pushHistory(); };
    bi.append(b, it); body.append(field('Style', bi));
  }
  if (a.type === 'image') {
    body.append(el('p', { class: 'muted-note' }, a.w && a.h ? `On canvas ${Math.round(a.w)}×${Math.round(a.h)}` : 'Image'));
    if (a.assetId) {
      const shareBtn = el('button', { style: { width: '100%' } });
      refreshShareBtn(shareBtn, a);
      shareBtn.onclick = async () => { await toggleShare(a); refreshShareBtn(shareBtn, a); };
      body.append(shareBtn);
    }
    const rep = el('button', { style: { width: '100%', marginTop: '6px' } }, 'Replace image…');
    rep.onclick = () => { imgReplaceTarget = a.id; $('#fileImg').click(); };
    body.append(rep);
  }
  if (a.type === 'rect' || a.type === 'ellipse') {
    body.append(field('Fill', colorInput(a.fill, v => a.fill = v)));
    body.append(field('Stroke', colorInput(a.stroke, v => a.stroke = v)));
    body.append(field('Stroke w', numInput(a.strokeWidth || 0, 1, v => { a.strokeWidth = Math.max(0, v); render2(); })));
    if (a.type === 'rect') body.append(field('Corner', numInput(a.radius || 0, 1, v => { a.radius = Math.max(0, v); render2(); })));
  }
  if (a.type === 'line') { body.append(field('Colour', colorInput(a.fill, v => a.fill = v)));
    body.append(field('Thick', numInput(a.h, 1, v => { a.h = Math.max(1, v); render2(); }))); }
  const op = el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: a.opacity == null ? 1 : a.opacity });
  op.addEventListener('input', () => { a.opacity = parseFloat(op.value); quickUpdate(a); });
  op.addEventListener('change', pushHistory); body.append(field('Opacity', op));
  const pos = el('div', { class: 'row' });
  pos.append(el('label', {}, 'W'), numInput(a.w, 1, v => { a.w = Math.max(4, v); render2(); }),
    el('label', {}, 'H'), numInput(a.h, 1, v => { a.h = Math.max(4, v); render2(); }));
  body.append(pos);
  const rot = el('div', { class: 'row' });
  rot.append(el('label', {}, 'Rotate'), numInput(a.rot || 0, 1, v => { a.rot = v; render2(); }));
  body.append(rot);
}
function refreshShareBtn(btn, a) { const shared = a._shared;
  btn.textContent = shared ? '✓ Shared with visitors' : '↗ Share with visitors';
  btn.className = shared ? 'primary' : ''; btn.style.width = '100%'; }
async function toggleShare(a) {
  const next = a._shared ? 'private' : 'shared';
  try { await store.updateAsset(a.assetId, { visibility: next }); a._shared = next === 'shared';
    toast(next === 'shared' ? 'Asset shared' : 'Asset made private'); refreshGallery(); }
  catch (e) { toast('Could not update: ' + e.message); }
}
function render2() { const box = $('#stage').querySelector('.panelBox'); if (!box) return render();
  const a = selected(); const old = box.querySelector(`.asset[data-id="${selId}"]`);
  if (old && a) box.replaceChild(renderAsset(a), old); drawSelReplace(a); }

// --- z-order / duplicate / delete ------------------------------------------
function zMove(dir) { const arr = activeAssets(), i = arr.findIndex(a => a.id === selId); if (i < 0) return;
  const j = i + dir; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; pushHistory(); render(); }
function dupSel() { const a = selected(); if (!a) return; const c = JSON.parse(JSON.stringify(a));
  c.id = uid(); c.x += 14; c.y += 14; activeAssets().push(c); selId = c.id; pushHistory(); render(); }
function delSel() { const a = selected(); if (!a) return; activeAssets().splice(activeAssets().indexOf(a), 1); selId = null; pushHistory(); render(); }

// --- tabs -------------------------------------------------------------------
function renderTabs() {
  const tabs = $('#tabs'); tabs.innerHTML = '';
  project.panels.forEach((p, i) => { const t = el('div', { class: 'tab' + (i === activePanel ? ' active' : '') });
    t.append(el('div', { class: 'mini' }), (i + 1) + '');
    t.onclick = () => { activePanel = i; selId = null; render(); }; tabs.append(t); });
  $('#btnAddPanel').style.display = FORMATS[project.format].dynamic ? 'inline-block' : 'none';
}

// --- gallery ----------------------------------------------------------------
async function refreshGallery() {
  const g = $('#gallery'); if (!g) return;
  let assets = [];
  try { assets = await store.listAssets({ scope: galleryScope }); } catch { assets = []; }
  g.innerHTML = '';
  if (!assets.length) { g.append(el('div', { class: 'gempty' },
    galleryScope === 'shared' ? 'No shared assets yet. Upload one and tap “Share”.' : 'No assets yet. Upload an image.')); return; }
  for (const meta of assets) {
    const url = await store.assetURL(meta);
    const item = el('div', { class: 'gitem', title: meta.name || '' });
    item.append(el('img', { src: url, alt: meta.name || '' }));
    if (meta.visibility === 'shared') item.append(el('div', { class: 'gtag shared' }, meta.authorName || 'shared'));
    item.onclick = ev => { if (ev.target.classList.contains('gdel')) return; placeAsset(meta); };
    if (meta.authorId === store.author.id) {
      const del = el('button', { class: 'gdel', title: 'Delete' }, '✕');
      del.onclick = async ev => { ev.stopPropagation(); if (!confirm('Delete this asset?')) return;
        try { await store.deleteAsset(meta.id); refreshGallery(); } catch (e) { toast(e.message); } };
      item.append(del);
    }
    g.append(item);
  }
}

// --- print imposition -------------------------------------------------------
function buildPrint() {
  const g = geom(); const root = $('#printRoot'); root.innerHTML = '';
  $('#printPageStyle').textContent = `@media print{@page{size:${g.sheetW}mm ${g.sheetH}mm;margin:0}}`;
  const sheet = el('div', { class: 'print-sheet', style: { width: g.sheetW + 'mm', height: g.sheetH + 'mm' } });
  for (let c = 0; c < g.cols * g.rows; c++) {
    const col = c % g.cols, row = Math.floor(c / g.cols);
    const page = g.cell2page[c], rot = g.cell2rot[c] || 0;
    const cell = el('div', { class: 'print-cell', style: { left: (col * g.panelWmm) + 'mm', top: (row * g.panelHmm) + 'mm',
      width: g.panelWmm + 'mm', height: g.panelHmm + 'mm' } });
    const pd = project.panels[page];
    if (pd) {
      const inner = el('div', { class: 'print-panel', style: { width: g.baseW + 'px', height: g.baseH + 'px',
        background: pd.bg || '#fff', transform: `rotate(${rot}deg)`, transformOrigin: 'center center',
        left: '50%', top: '50%', marginLeft: (-g.baseW / 2) + 'px', marginTop: (-g.baseH / 2) + 'px', overflow: 'hidden' } });
      pd.assets.forEach(a => inner.append(renderStaticAsset(a)));
      cell.append(inner);
    }
    sheet.append(cell);
  }
  for (let c = 1; c < g.cols; c++) sheet.append(el('div', { class: 'fold-guide v fold', style: { left: (c * g.panelWmm) + 'mm', top: 0, height: g.sheetH + 'mm', width: 0 } }));
  for (let r = 1; r < g.rows; r++) sheet.append(el('div', { class: 'fold-guide fold', style: { top: (r * g.panelHmm) + 'mm', left: 0, width: g.sheetW + 'mm', height: 0 } }));
  if (project.format === 'mini8') sheet.append(el('div', { class: 'fold-guide v cut', style: { left: (g.sheetW / 2) + 'mm', top: 0, height: g.sheetH + 'mm', width: 0 } }));
  root.append(sheet);
}
function renderStaticAsset(a) { const e = renderAsset(a); e.style.pointerEvents = 'none'; e.classList.remove('selected'); return e; }
function doPrint() { buildPrint(); setTimeout(() => window.print(), 80); }

// --- PNG export (inline images -> SVG foreignObject -> canvas) ---------------
function fetchDataURL(url) { return fetch(url).then(r => r.blob()).then(b => new Promise((res, rej) => {
  const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b); })); }
async function exportPNG() {
  const g = geom(); const p = project.panels[activePanel];
  const box = el('div', { style: { width: g.baseW + 'px', height: g.baseH + 'px', background: p.bg || '#fff', position: 'relative', overflow: 'hidden' } });
  for (const a of p.assets) {
    const e = renderStaticAsset(a);
    if (a.type === 'image') { const img = e.querySelector('img'); const src = a._url || a.src;
      if (img && src) { try { img.setAttribute('src', await fetchDataURL(src)); } catch {} } } // SVG-as-image can't load external refs
    box.append(e);
  }
  const html = new XMLSerializer().serializeToString(box);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${g.baseW}" height="${g.baseH}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">${html}</div></foreignObject></svg>`;
  const img = new Image();
  const scale = EXPORT_DPI / 96;
  img.onload = () => {
    const cv = el('canvas'); cv.width = Math.round(g.baseW * scale); cv.height = Math.round(g.baseH * scale);
    const ctx = cv.getContext('2d'); ctx.fillStyle = p.bg || '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    if (einkMode) dither(ctx, cv.width, cv.height);
    cv.toBlob(b => downloadBlob(b, (project.name || 'zine') + `-p${activePanel + 1}` + (einkMode ? '-1bit' : '') + '.png'), 'image/png');
  };
  img.onerror = () => toast('PNG export failed');
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
function dither(ctx, w, h) {
  const im = ctx.getImageData(0, 0, w, h), d = im.data, gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x, old = gray[i], nv = old < 128 ? 0 : 255, err = old - nv;
    gray[i] = nv; if (x + 1 < w) gray[i + 1] += err * 7 / 16;
    if (y + 1 < h) { if (x > 0) gray[i + w - 1] += err * 3 / 16; gray[i + w] += err * 5 / 16; if (x + 1 < w) gray[i + w + 1] += err * 1 / 16; } }
  for (let i = 0; i < w * h; i++) { const v = gray[i]; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  ctx.putImageData(im, 0, 0);
}

// --- file import/export -----------------------------------------------------
function downloadBlob(blob, name) { const u = URL.createObjectURL(blob);
  const a = el('a', { href: u, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000); }
function exportProjectFile() { const blob = new Blob([JSON.stringify(serializeDoc(), null, 2)], { type: 'application/json' });
  downloadBlob(blob, (project.name || 'zine').replace(/\s+/g, '-') + '.zine.json'); toast('Exported JSON'); }
function importProjectFile(file) { const r = new FileReader();
  r.onload = async () => { try { const p = JSON.parse(r.result); if (!p.panels || !p.format) throw 0;
    project = p; delete project.id; activePanel = 0; selId = null; history.length = 0; future.length = 0;
    await resolveAssetURLs(); syncControls(); render(); autosave(); toast('Imported'); }
    catch { toast('Invalid project file'); } };
  r.readAsText(file); }

// --- project save / open (via store) ----------------------------------------
async function saveProject() {
  try { const doc = serializeDoc();
    const meta = await store.saveProject(doc); project.id = meta.id;
    toast(store.remote ? 'Saved to device' : 'Saved to browser'); autosave(); }
  catch (e) { toast('Save failed: ' + e.message); }
}
let openScope = 'mine';
async function openProjectDialog() {
  $('#openOverlay').classList.add('open'); await renderProjectList();
}
async function renderProjectList() {
  const list = $('#projList'); list.innerHTML = '<p class="muted-note">Loading…</p>';
  let projects = []; try { projects = await store.listProjects({ scope: openScope }); } catch { projects = []; }
  list.innerHTML = '';
  if (!projects.length) { list.append(el('p', { class: 'muted-note' }, 'No saved projects.')); return; }
  projects.forEach(p => {
    const row = el('div', { class: 'field', style: { borderBottom: '1px solid var(--line)', padding: '8px 0' } });
    row.append(el('div', {}, [el('div', { style: { fontWeight: '600' } }, p.name || 'Untitled'),
      el('div', { class: 'muted-note' }, `${FORMATS[p.format]?.label || p.format} · ${new Date(p.updatedAt).toLocaleString()}${p.authorName ? ' · ' + p.authorName : ''}`)]));
    const openB = el('button', { class: 'primary' }, 'Open');
    openB.onclick = async () => { try { const full = await store.getProject(p.id);
      project = full.data || full; project.id = p.id; activePanel = 0; selId = null; history.length = 0; future.length = 0;
      await resolveAssetURLs(); syncControls(); render(); autosave(); $('#openOverlay').classList.remove('open'); toast('Opened'); }
      catch (e) { toast('Open failed: ' + e.message); } };
    row.append(openB); list.append(row);
  });
}

// --- controls wiring --------------------------------------------------------
function syncControls() {
  $('#selFormat').value = project.format;
  $('#selPaper').value = project.paper;
  $('#inpName').value = project.name || 'Untitled';
  $('#accCount').style.display = FORMATS[project.format].dynamic ? 'inline-block' : 'none';
  $('#accCount').value = project.panels.length;
  $('#helpFold').textContent = FORMATS[project.format].fold;
}
function wire() {
  const selF = $('#selFormat');
  for (const k in FORMATS) selF.append(el('option', { value: k }, FORMATS[k].label));

  document.querySelectorAll('#left [data-add]').forEach(b => b.onclick = () => {
    const t = b.dataset.add; if (t === 'image') { imgReplaceTarget = null; $('#fileImg').click(); } else addAsset(t); });

  selF.onchange = () => { project.format = selF.value;
    if (FORMATS[project.format].dynamic && project.panels.length < 2) while (project.panels.length < 4) project.panels.push(blankPanel());
    activePanel = 0; selId = null; ensurePanels(); syncControls(); pushHistory(); render(); };
  $('#selPaper').onchange = () => { project.paper = $('#selPaper').value; pushHistory(); render(); };
  $('#accCount').onchange = () => { const n = Math.max(2, Math.min(12, parseInt($('#accCount').value) || 4));
    while (project.panels.length < n) project.panels.push(blankPanel()); project.panels.length = n;
    activePanel = Math.min(activePanel, n - 1); pushHistory(); render(); };

  $('#inpName').oninput = () => { project.name = $('#inpName').value; $('#projName').textContent = project.name; autosave(); };
  $('#inpName').onchange = pushHistory;
  $('#panelBg').oninput = () => { project.panels[activePanel].bg = $('#panelBg').value; render(); };
  $('#panelBg').onchange = pushHistory;

  $('#btnPrev').onclick = () => { if (activePanel > 0) { activePanel--; selId = null; render(); } };
  $('#btnNext').onclick = () => { if (activePanel < project.panels.length - 1) { activePanel++; selId = null; render(); } };
  $('#btnAddPanel').onclick = () => { project.panels.splice(activePanel + 1, 0, blankPanel()); activePanel++; $('#accCount').value = project.panels.length; pushHistory(); render(); };
  $('#btnFit').onclick = () => render();

  $('#aFront').onclick = () => zMove(1); $('#aBack').onclick = () => zMove(-1);
  $('#aDup').onclick = dupSel; $('#aDel').onclick = delSel;

  $('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
  $('#btnGrid').onclick = () => { showGrid = !showGrid; snap = showGrid; $('#btnGrid').classList.toggle('primary', showGrid); render(); };
  $('#btnEink').onclick = () => { einkMode = !einkMode; $('#btnEink').classList.toggle('primary', einkMode); render(); toast(einkMode ? 'E-ink 1-bit preview on' : 'E-ink off'); };
  $('#btnPrint').onclick = doPrint;
  $('#btnPng').onclick = exportPNG;
  $('#btnHelp').onclick = () => { $('#helpFold').textContent = FORMATS[project.format].fold; $('#helpOverlay').classList.add('open'); };
  $('#helpOverlay').onclick = e => { if (e.target.id === 'helpOverlay') $('#helpOverlay').classList.remove('open'); };
  $('#openOverlay').onclick = e => { if (e.target.id === 'openOverlay') $('#openOverlay').classList.remove('open'); };

  $('#btnSaveProj').onclick = saveProject;
  $('#btnOpenProj').onclick = openProjectDialog;
  $('#btnExport').onclick = exportProjectFile;
  $('#btnImport').onclick = () => $('#fileProj').click();
  $('#btnNew').onclick = () => { if (confirm('Start a new project? The current one is autosaved; save it first if you want to keep it in the library.')) {
    project = newProject(project.format); activePanel = 0; selId = null; history.length = 0; future.length = 0; syncControls(); render(); autosave(); } };
  $('#btnClearPanel').onclick = () => { if (confirm('Clear all elements on this page?')) { project.panels[activePanel].assets = []; selId = null; pushHistory(); render(); } };
  $('#btnRightToggle').onclick = () => $('#right').classList.toggle('open');
  $('#btnUpload').onclick = () => { imgReplaceTarget = null; galleryUpload = true; $('#fileImg').click(); };

  $('#galScope').querySelectorAll('button').forEach(b => b.onclick = () => {
    galleryScope = b.dataset.scope; $('#galScope').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); refreshGallery(); });
  $('#openScope').querySelectorAll('button').forEach(b => b.onclick = () => {
    openScope = b.dataset.scope; $('#openScope').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); renderProjectList(); });

  $('#inpAuthor').oninput = () => { store.setAuthorName($('#inpAuthor').value.trim()); };

  $('#btnCam').onclick = openCamera;
  $('#camCancel').onclick = closeCamera;
  $('#camSnap').onclick = snapPhoto;
  $('#camOverlay').onclick = e => { if (e.target.id === 'camOverlay') closeCamera(); };

  $('#fileImg').onchange = async e => { const files = [...e.target.files];
    if (imgReplaceTarget) { const a = findAsset(imgReplaceTarget); if (a && files[0]) {
      try { const meta = await store.putAsset(files[0], { visibility: a._shared ? 'shared' : 'private', name: files[0].name });
        a.assetId = meta.id; a.src = store.remote ? store.assetURL(meta) : null; a._url = await store.assetURL(meta);
        a._shared = meta.visibility === 'shared'; pushHistory(); render(); refreshGallery(); } catch (err) { toast(err.message); } }
      imgReplaceTarget = null; }
    else await uploadFiles(files, { place: !galleryUpload });
    galleryUpload = false; e.target.value = ''; };
  $('#fileProj').onchange = e => { if (e.target.files[0]) importProjectFile(e.target.files[0]); e.target.value = ''; };

  $('#stagepad').addEventListener('pointerdown', onStagePadDown);

  const wrap = $('#stagewrap');
  wrap.addEventListener('dragover', e => e.preventDefault());
  wrap.addEventListener('drop', async e => { e.preventDefault();
    const rect = $('#stage').getBoundingClientRect();
    const xy = { x: (e.clientX - rect.left) / editorScale, y: (e.clientY - rect.top) / editorScale };
    const files = [...(e.dataTransfer.files || [])].filter(f => f.type.startsWith('image/'));
    for (const f of files) { try { const meta = await store.putAsset(f, { visibility: 'private', name: f.name }); await placeAsset(meta, xy); } catch (err) { toast(err.message); } }
    if (files.length) refreshGallery(); });

  window.addEventListener('paste', async e => { const items = [...(e.clipboardData?.items || [])];
    const img = items.find(i => i.type.startsWith('image/')); if (img) { const f = img.getAsFile();
      try { const meta = await store.putAsset(f, { visibility: 'private', name: 'pasted.png' }); await placeAsset(meta); refreshGallery(); } catch (err) { toast(err.message); } } });

  window.addEventListener('resize', () => render());
  window.addEventListener('keydown', onKey);

  const mq = window.matchMedia('(max-width:820px)');
  const applyMq = () => { $('#btnRightToggle').style.display = mq.matches ? 'inline-block' : 'none'; };
  mq.addEventListener('change', applyMq); applyMq();
}
let galleryUpload = false;

function onKey(e) {
  if (e.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) { if (e.key === 'Escape') e.target.blur(); return; }
  const meta = e.ctrlKey || e.metaKey;
  if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (meta && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (meta && e.key.toLowerCase() === 'd') { e.preventDefault(); dupSel(); return; }
  if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
  if (meta && e.key.toLowerCase() === 'p') { e.preventDefault(); doPrint(); return; }
  if (meta) return;
  const a = selected();
  switch (e.key) {
    case 'Escape': selId = null; render(); stopCamPreview(); document.querySelectorAll('.overlay').forEach(o => o.classList.remove('open')); break;
    case 'Delete': case 'Backspace': if (a) { e.preventDefault(); delSel(); } break;
    case 't': case 'T': addAsset('text'); break;
    case 'i': case 'I': imgReplaceTarget = null; galleryUpload = false; $('#fileImg').click(); break;
    case 'r': case 'R': addAsset('rect'); break;
    case 'o': case 'O': addAsset('ellipse'); break;
    case 'l': case 'L': addAsset('line'); break;
    case 'g': case 'G': $('#btnGrid').click(); break;
    case '?': $('#btnHelp').click(); break;
    case '[': if (a) zMove(-1); break;
    case ']': if (a) zMove(1); break;
    case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown':
      if (a) { e.preventDefault(); const d = e.shiftKey ? 10 : 1;
        if (e.key === 'ArrowLeft') a.x -= d; if (e.key === 'ArrowRight') a.x += d;
        if (e.key === 'ArrowUp') a.y -= d; if (e.key === 'ArrowDown') a.y += d;
        quickUpdate(a); drawSelReplace(a); clearTimeout(onKey._t); onKey._t = setTimeout(pushHistory, 300); } break;
  }
}
// --- camera -----------------------------------------------------------------
let camTimer = null;
function startCamPreview() { const img = $('#camPreview');
  const tick = () => { img.src = store.cameraFrameURL(); }; tick();
  clearInterval(camTimer); camTimer = setInterval(tick, 800); }
function stopCamPreview() { clearInterval(camTimer); camTimer = null; }
function openCamera() { if (!store.hasCamera) return; $('#camOverlay').classList.add('open'); startCamPreview(); }
function closeCamera() { stopCamPreview(); $('#camOverlay').classList.remove('open'); }
async function snapPhoto() {
  try { const meta = await store.capturePhoto({ visibility: $('#camShare').checked ? 'shared' : 'private' });
    if ($('#camShare').checked) meta.visibility = 'shared';
    closeCamera(); await placeAsset(meta);
    const a = selected(); if (a) a._shared = meta.visibility === 'shared';
    refreshGallery(); toast('Photo captured'); }
  catch (e) { toast('Capture failed: ' + e.message); }
}

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1800); }

// --- boot -------------------------------------------------------------------
async function boot() {
  store = await openStore();
  $('#connBadge').textContent = store.remote ? 'device' : 'local';
  $('#connBadge').className = 'badge ' + (store.remote ? 'live' : 'local');
  $('#connBadge').title = store.remote ? `Connected: ${store.health?.name || 'backend'} — assets stored on device` : 'No backend — assets stored in this browser';
  $('#inpAuthor').value = store.author.name || '';
  if (store.hasCamera) { $('#btnCam').style.display = 'grid'; $('#camLabel').style.display = 'block'; }
  wire();
  // Deep-link: reader's "Send to zine" opens the clippings project via ?project=<id>.
  project = null;
  const openId = new URLSearchParams(location.search).get('project');
  if (openId) {
    try { const full = await store.getProject(openId);
      if (full) { project = full.data || full; project.id = openId; } } catch {}
  }
  project = project || loadAutosave() || newProject('mini8');
  await resolveAssetURLs();
  activePanel = 0; syncControls(); render(); updateUndo(); refreshGallery();
  $('#autosaveNote').textContent = 'Changes autosave to this browser.';
}
boot();
