#!/usr/bin/env node
// Poke a running Zinester server to pull new items from every subscribed feed.
// Zero dependencies — used by the systemd timer (or plain cron) for a daily,
// credential-free "auto-ingest" of any newsletter that publishes an RSS/Atom
// feed. Inbox-only newsletters use POST /api/reader/items instead (see DEPLOY).
//
//   node tools/refresh.mjs [baseUrl]      (default http://127.0.0.1:8787)
//   ZINESTER_URL=http://127.0.0.1:9000 node tools/refresh.mjs

const base = (process.argv[2] || process.env.ZINESTER_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');

try {
  const r = await fetch(base + '/api/reader/refresh', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    signal: AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined,
  });
  if (!r.ok) { console.error(`refresh failed: HTTP ${r.status}`); process.exit(1); }
  const { added = 0, feeds = [] } = await r.json();
  const errs = feeds.filter(f => f.lastError);
  console.log(`[${new Date().toISOString()}] refreshed ${feeds.length} feed(s): ${added} new item(s)` +
    (errs.length ? `; ${errs.length} errored (${errs.map(f => f.title).join(', ')})` : ''));
} catch (e) {
  console.error('refresh could not reach ' + base + ': ' + (e.message || e));
  process.exit(1);
}
