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
- **Fold formats** with correct single-sided imposition: **8-page mini zine**,
  **accordion (N panels)**, **half-fold card**, **single page / poster**.
- **Print** an imposed sheet (`window.print()` with true-size `@page`) including
  fold/cut guides — no PDF library needed.
- **E-ink mode**: grayscale + 1-bit Floyd–Steinberg preview and 300-dpi **PNG
  export** (via SVG `foreignObject` → canvas, dependency-free) for the Waveshare
  panel.
- Project **save/open** (to the device or browser) and **export/import** `.json`.

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

See [`docs/DEVICE.md`](docs/DEVICE.md) for ESP32 board selection (SD card is a
hard requirement) and [`firmware/`](firmware/) for a reference sketch that
implements the same API against the SD card.

## Layout

```
web/           the frontend (buildless ES modules): index.html, app.js, store.js, styles.css
server/        zero-dependency Node reference backend (implements docs/API.md)
docs/          API.md (storage/sharing contract), DEVICE.md (ESP32 plan)
firmware/      ESP32 + SD reference firmware notes/sketch
data/          runtime store for the reference server (git-ignored)
```

## License

MIT — see [LICENSE](LICENSE).
