# Zinester

A portable, dependency-free web editor for laying out **printable, cut-and-fold
zines** — a simple scrapbook/imposition tool. Upload, arrange, transform and lay
out assets, then print a sheet with the correct **page imposition** so it folds
(and cuts) into a real booklet.

The whole point is **portability**. The same frontend runs, unchanged, on three
kinds of host:

| Host | How | Storage / sharing |
|---|---|---|
| **ESP32 + SD card** (device) | firmware serves `web/` + the API from the SD card | assets & projects on the SD card, shareable between visitors |
| **Your website / a laptop** | `node server/server.mjs` serves the same API | assets & projects in `data/`, shareable between visitors |
| **Pure static / offline / embedded** | just host the `web/` folder | assets & projects in the browser (IndexedDB), single-user |

The frontend probes `GET /api/health` on boot: if a backend answers it uses it
(the badge in the header reads **device**), otherwise it falls back to
browser-only storage (**local**). One codebase, three deployments.

## Why not just fork an existing zine app?

There are good MIT zine editors already (e.g.
[`virgilvox/zine-maker`](https://github.com/virgilvox/zine-maker)), but they're
built as framework SPAs for a browser on a real computer. Zinester's defining
requirement is being **served from an ESP32 with an SD card, with assets that
visitors can share** — so it's built as a thin, buildless frontend behind a
small, well-specified storage API that an ESP32 can implement directly. See
[`docs/API.md`](docs/API.md).

## Features

- Canvas editor: **text**, **images** (upload / drag-drop / paste), **rect /
  ellipse / line**; move, resize, rotate, layer order, duplicate, opacity, snap
  grid, undo/redo, keyboard shortcuts.
- **Shared asset gallery** — upload to the device's SD card and optionally mark
  an asset *Shared* so every visitor can reuse it.
- **Camera capture** (on camera-equipped devices like the XIAO ESP32S3 Sense) —
  snap a photo straight into a zine; it's stored as a shareable asset.
- **Fold formats** with correct single-sided imposition: **8-page mini zine**,
  **accordion (N panels)**, **half-fold card**, **single page / poster**.
- **Print** an imposed sheet (`window.print()` with true-size `@page`) including
  fold/cut guides — no PDF library needed.
- **E-ink mode**: grayscale + 1-bit Floyd–Steinberg preview and 300-dpi **PNG
  export** (via SVG `foreignObject` → canvas, dependency-free) for the Waveshare
  panel.
- Project **save/open** (to the device or browser) and **export/import** `.json`.

## Reader — gather feeds & newsletters, then compile a zine

Zinester also has a **content-curation front end** for people who want to *read*
first and *make* second. The **Reader** (`/reader.html`, or the 📚 button in the
editor header) gathers RSS/Atom feeds and mailing-list emails, ingests each as a
short **summary with attribution**, and gives you a daily reading queue:

- **Feeds** — subscribe to any RSS/Atom feed; a starter set is pre-loaded.
- **Summaries** — dependency-free by default (feed blurb / extractive); set
  `ANTHROPIC_API_KEY` and it upgrades to Claude-written summaries.
- **Read like a practice** — Unread / Reading / Starred / Read filters, per-item
  notes that autosave, and a **daily 30–90 min reading timer**.
- **Send to zine** — drop an article's title, summary, and a credit line onto
  the next page of a "Reading Clippings" mini-zine, then jump into the editor to
  lay it out. Attribution travels with the clipping.

Newsletters arrive by email, so there's a generic import endpoint
(`POST /api/reader/items`) that any inbox automation can push into the same
queue. The Reader is a **server capability** (it fetches feeds), so it needs the
reference backend running — the editor itself still works offline. Full docs:
[`docs/READER.md`](docs/READER.md).

For a daily habit, run it on an always-on box (Raspberry Pi / mini-PC / NAS):
[`docs/DEPLOY.md`](docs/DEPLOY.md) has a systemd service + a daily
feed-refresh timer (`deploy/`, `tools/refresh.mjs`).

## Run the reference server (website / local dev)

Zero npm dependencies — Node 18+ built-ins only:

```bash
node server/server.mjs            # http://localhost:8787
# options: --port 8787  --data ./data  --web ./web
```

`data/` is the SD-card stand-in; it's git-ignored. Open the URL, upload an
image, mark it Shared, and open the same URL in a second browser profile to see
sharing between "visitors".

## Deploy as a plain static site (no sharing)

Host the `web/` folder on any static host (GitHub Pages, Netlify, your box).
With no `/api` backend the app runs fully client-side with IndexedDB storage.

## Embed in another project (e.g. reading-list-box)

- **Iframe** (works with any stack): `<iframe src=".../zinester/web/index.html">`.
- **Same-origin mount**: serve the `web/` folder under a path and, if that host
  also implements [`docs/API.md`](docs/API.md), assets/projects share its store.
- The project document format is documented in `docs/API.md` so another app can
  read/write `.zine.json` files directly.

## Run on the device

Target board is the **Seeed Studio XIAO ESP32S3 Sense** (8 MB PSRAM, microSD,
OV2640 camera). See [`docs/DEVICE.md`](docs/DEVICE.md) for the wiring/specs and
[`firmware/xiao_esp32s3_zinester/`](firmware/xiao_esp32s3_zinester/) for the
reference sketch that serves the frontend + API from the SD card and adds camera
capture. To try the camera flow without hardware, run the reference server with
`--mock-camera`.

## Layout

```
web/           the frontend (buildless ES modules): index.html, app.js, store.js, styles.css
               + the Reader: reader.html, reader.js, reader.css
server/        zero-dependency Node reference backend: server.mjs + reader.mjs (feeds/summaries)
docs/          API.md (contract), READER.md (curation), DEPLOY.md (always-on box), DEVICE.md (ESP32)
firmware/      ESP32 + SD reference firmware notes/sketch
reader/        seed-feeds.json — starter feed subscriptions (loaded on first run)
deploy/        systemd service + daily-refresh timer for an always-on host
tools/         refresh.mjs — pokes /api/reader/refresh (used by the timer/cron)
data/          runtime store for the reference server, incl. data/reader/ (git-ignored)
```

## License

MIT — see [LICENSE](LICENSE).
