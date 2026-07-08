# Zinester Reader — content curation

The **Reader** turns Zinester into the front end of a reading practice: gather
feeds and newsletters, ingest them as short **summaries with attribution**,
triage them in daily reading sessions, take notes, and send the keepers —
credited — straight into the zine editor.

It's a **server capability** (like the camera). Feeds are fetched and stored by
the reference backend, so the Reader needs `node server/server.mjs` running; the
zine editor itself still works fully offline. `GET /api/health` advertises
`"reader": true` and a `"summarizer"` field (`"extractive"` or `"claude"`).

Open it at **`/reader.html`** (there's a 📚 Reader button in the editor header).

## What it does

- **Feeds** — subscribe to any RSS/Atom feed; Refresh pulls new items. A
  starter set (`reader/seed-feeds.json`) is pre-loaded on first run.
- **Summaries** — every item gets a 2–3 sentence summary. By default this is
  dependency-free: the feed's own blurb when it's clean, otherwise an extractive
  first-sentences summary. Set `ANTHROPIC_API_KEY` and the server upgrades to
  Claude-written summaries automatically (see below).
- **Reading queue** — filter by Unread / Reading / Starred / Read, per-feed
  filtering, star, and per-item **notes** that autosave.
- **Daily reading timer** — pick a 30/45/60/90-minute goal and run a focused
  block; progress persists per day in the browser.
- **Send to zine** — drops the article's title, summary, and a credit line
  (`— author, publication · date` + URL) onto the next page of a **"Reading
  Clippings"** mini-zine, then deep-links into the editor (`?project=<id>`). A
  mini-zine holds 8 clippings; the 9th starts "Reading Clippings 2".

## Summaries with Claude (optional)

```bash
ANTHROPIC_API_KEY=sk-ant-... node server/server.mjs
# optional: ZINESTER_SUMMARY_MODEL=claude-haiku-4-5-20251001  (default)
```

With no key the pipeline stays fully offline and dependency-free. The key is
only ever used server-side and only when summarizing new items.

## Ingesting newsletters (email)

Feeds cover anything with RSS. For mailing-list emails there's a generic import
endpoint — push an article the server didn't fetch and it gets summarized and
queued like any feed item:

```bash
curl -X POST localhost:8787/api/reader/items -H 'content-type: application/json' -d '{
  "title": "Feeding on Illusions",
  "url": "https://theconvivialsociety.substack.com/p/feeding-on-illusions",
  "source": "The Convivial Society", "author": "L. M. Sacasas",
  "content": "<p>full or partial article HTML/text…</p>"
}'
```

Omit `summary` and the server writes one (extractive, or Claude if a key is
set); pass `summary` to keep your own. This is the hook for any inbox
automation — a mail filter, a script over the Gmail/IMAP API, or an assistant —
to feed newsletters into the same queue. `tags` (array) is optional.

## API

All under `/api/reader`. JSON in/out. Unlike assets/projects this store is
**single-tenant** (your own queue) and not author-scoped.

### Feeds
- `GET /feeds` → `{ feeds: [{ id, url, title, siteTitle, addedAt, lastFetchedAt, lastError }] }`
- `POST /feeds` `{ url, title? }` — fetch + subscribe + ingest. → `{ feed, added }`
- `DELETE /feeds/:id` (`?purge=1` also deletes that feed's items) → `{ ok }`
- `POST /refresh` `{ feedId? }` — re-fetch all (or one) feed; ingest new items. → `{ added, feeds }`

### Items
```json
{ "id": "i_…", "feedId": "f_…|null", "source": "A Working Library",
  "title": "…", "url": "…", "author": "Mandy Brown", "publishedAt": 1751…,
  "summary": "…", "engine": "claude|feed|extractive|manual", "excerpt": "…",
  "tags": [], "state": "unread|reading|read|archived", "starred": false,
  "note": "", "addedAt": 1751…, "readAt": null }
```
- `GET /items?state=unread|reading|read|starred|all&source=<feedId>&limit=` → `{ items }`
- `GET /items/:id` → item
- `POST /items` — manual/email import (see above) → the created item
- `PATCH /items/:id` `{ state?, starred?, note?, tags? }` → updated item
- `DELETE /items/:id` → `{ ok }`

## Storage

Under the server's data dir (the SD-card stand-in, git-ignored):

```
data/reader/feeds.json    feed subscriptions
data/reader/items.json    ingested items + your notes/state
```

## Notes & limits

- Feed fetching needs outbound network. In a locked-down/offline environment
  `POST /feeds` and `/refresh` return a fetch error per feed (recorded in the
  feed's `lastError`); import via `POST /items` still works.
- Some publishers put a WAF in front of their feed and may 403 automated
  fetchers. Those can be added as manual items instead.
- The parser is a tolerant, dependency-free RSS 2.0 / RDF / Atom reader
  (`server/reader.mjs`) — no XML library. It handles CDATA, HTML entities,
  `content:encoded`, `dc:creator`, and relative links.
