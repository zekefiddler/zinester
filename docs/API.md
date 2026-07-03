# Zinester Storage & Sharing API

This is the contract between the Zinester **frontend** and any **backend** that
stores assets and projects. Three backends implement it identically:

| Backend | Where it runs | Storage | Sharing |
|---|---|---|---|
| **ESP32 firmware** | the device | SD card | real, between visitors |
| **Reference Node server** (`server/server.mjs`) | your website / a laptop | `data/` dir | real, between visitors |
| **LocalStore** (`web/store.js`) | browser only, no server | IndexedDB + localStorage | single-user (own assets only) |

The frontend auto-detects a live backend (`GET /api/health`) and otherwise
falls back to `LocalStore`, so the same UI works on the device, on a normal web
host, and fully offline.

## Identity & sharing model

There are **no accounts**. Each browser generates a random `authorId` (UUID),
stored in `localStorage["zinester.authorId"]`, plus an optional display name.
Every request that creates or mutates data sends:

```
X-Zinester-Author: <authorId>
X-Zinester-Author-Name: <url-encoded display name>   (optional)
```

Every asset and project has `visibility`:

- `private` — visible only to its author.
- `shared` — appears in the device-wide gallery for **all** visitors.

Authors may modify/delete only their own items. A device-admin PIN
(`X-Zinester-Admin`) MAY be honored by a backend to allow housekeeping; the
reference server and firmware treat it as optional and off by default.

## Conventions

- All request/response bodies are JSON unless noted (asset **binary** GET).
- Timestamps are epoch milliseconds.
- IDs are opaque strings (UUID-ish); clients must not construct them.
- Errors: `{ "error": "message" }` with an appropriate 4xx/5xx status.

## Endpoints

### `GET /api/health`
Returns backend capabilities. Presence of this route is how the frontend knows a
device/server backend exists.

```json
{ "ok": true, "name": "zinester-reference", "storage": "fs",
  "sharing": true, "camera": false, "maxAssetBytes": 8388608, "version": 1 }
```

`camera: true` advertises the optional camera capability (the XIAO ESP32S3 Sense
firmware sets this). The frontend only shows camera UI when it is true.

### Assets

An **asset** is an uploaded file (image today; SVG/font later) plus metadata.

**Metadata shape**
```json
{ "id": "a_9f3…", "name": "sticker.png", "mime": "image/png",
  "size": 20481, "w": 512, "h": 512, "visibility": "shared",
  "authorId": "…", "authorName": "zeke", "createdAt": 1751490000000,
  "url": "/api/assets/a_9f3…" }
```

- `GET /api/assets?scope=shared|mine|all`
  - `shared` (default): all `shared` assets.
  - `mine`: caller's own assets (private + shared), by `X-Zinester-Author`.
  - `all`: shared assets + caller's own private ones.
  - Returns `{ "assets": [ …metadata ] }`.
- `POST /api/assets` — create. Body:
  ```json
  { "name": "sticker.png", "dataUrl": "data:image/png;base64,…",
    "w": 512, "h": 512, "visibility": "private" }
  ```
  Returns `201` with the metadata object. Backends MAY also accept
  `multipart/form-data` (preferred on the ESP32 to avoid base64 RAM overhead);
  the reference server accepts the JSON+dataUrl form.
- `GET /api/assets/:id` — the raw **binary** file (with correct `Content-Type`,
  long cache headers). This is what an on-canvas image element points at.
- `GET /api/assets/:id/meta` — metadata only.
- `PATCH /api/assets/:id` — author-only. Body may set `{ "visibility", "name" }`.
- `DELETE /api/assets/:id` — author-only. Removes binary + metadata.

### Camera (optional capability)

Present only when `health.camera === true` (e.g. the XIAO ESP32S3 Sense with its
OV2640). Lets a visitor snap a photo straight into a zine; the captured frame is
stored as a normal **asset** (so it can be shared like any other).

- `GET /api/camera/frame.jpg` — a single JPEG snapshot for live preview. Send
  `Cache-Control: no-store`; the frontend cache-busts with a query param. Returns
  `404` if there is no camera.
- `POST /api/camera/capture` — capture a full-resolution frame and persist it as
  an asset. Body (optional): `{ "name", "visibility" }`. Returns `201` with the
  asset metadata (same shape as `POST /api/assets`).

### Projects

A **project** is a zine document (the JSON the editor produces). Stored whole.

**Metadata shape** (list view omits `data`)
```json
{ "id": "p_1a2…", "name": "My Zine", "format": "mini8",
  "visibility": "private", "authorId": "…", "authorName": "zeke",
  "updatedAt": 1751490000000, "thumb": "data:image/png;base64,…|null" }
```

- `GET /api/projects?scope=shared|mine|all` — `{ "projects": [ …metadata ] }`.
- `POST /api/projects` — create; body is the full project doc. Returns `201` with
  metadata (including new `id`).
- `GET /api/projects/:id` — full doc `{ …metadata, "data": { …zine } }`.
- `PUT /api/projects/:id` — author-only; replaces the doc.
- `DELETE /api/projects/:id` — author-only.

## Project document format (v1)

The editor's native format. Asset references point at stored assets by `assetId`
so shared assets are not duplicated into every project; `src` is a resolvable
fallback (may be a data URL when saved from `LocalStore`).

```json
{
  "version": 1,
  "name": "My Zine",
  "format": "mini8",
  "paper": "A4",
  "panels": [
    { "id": "…", "bg": "#ffffff", "assets": [
      { "id": "…", "type": "image", "assetId": "a_9f3…", "src": "/api/assets/a_9f3…",
        "x": 40, "y": 60, "w": 200, "h": 150, "rot": 0, "opacity": 1 },
      { "id": "…", "type": "text", "text": "hello", "x": 20, "y": 20,
        "w": 160, "h": 40, "fontSize": 18, "fontFamily": "system-ui",
        "color": "#111", "align": "left", "bold": false, "italic": false }
    ] }
  ]
}
```

Coordinates are in **base px** where `1 base px = 1 mm at 96 dpi`
(`96 / 25.4`), so a panel prints at true physical size without extra scaling.
