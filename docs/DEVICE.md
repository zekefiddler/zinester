# Running Zinester on an ESP32 (with SD card)

The device serves the frontend and implements the storage API
([`docs/API.md`](API.md)) against an **SD card**. The visitor's browser does all
the canvas work — the ESP32 is only a small web server + file store. The SD card
is a hard requirement: it holds uploaded assets and saved projects, and is what
makes assets shareable between visitors.

## Target board: Seeed Studio XIAO ESP32S3 Sense

The chosen board. It satisfies every requirement below and adds a camera:

- ESP32-S3R8: **8 MB PSRAM**, 8 MB flash, Wi-Fi + BLE.
- **microSD** slot on the Sense expansion board (SPI: `SCK=7, MISO=8, MOSI=9,
  CS=21`; `SD.begin(21)`; FAT32, ≤32 GB).
- **OV2640** 2 MP camera → an extra capability: **capture photos straight into a
  zine** (`GET /api/camera/frame.jpg`, `POST /api/camera/capture`). The frontend
  shows a 📷 button only when `health.camera` is true.
- Caveat: `GPIO21` doubles as the onboard LED. Camera + SD coexist on the bare
  Sense board; the known conflict is only with the **round-display** add-on (cut
  its `J3` pads if you stack one).

Firmware lives in [`../firmware/xiao_esp32s3_zinester/`](../firmware/xiao_esp32s3_zinester/).

## Other boards (if you ever port it)

Requirements that drive the choice:

- **SD card** slot (or easy SPI/SDMMC wiring).
- Enough flash to hold the firmware; **the frontend lives on the SD card**, so
  app size is not constrained by flash.
- PSRAM strongly recommended — asset uploads and buffers are far more
  comfortable with it.
- Wi-Fi (all ESP32 have it) to serve the page over SoftAP or your LAN.

Good candidates:

| Board | SD | PSRAM | Notes |
|---|---|---|---|
| **ESP32-S3 DevKitC-1 (N16R8)** | via module/wiring | 8 MB | Most headroom; recommended default. |
| **LILYGO T-Deck / T-Display-S3** | microSD onboard | yes | Nice if you want a screen too. |
| **ESP32-S3 + microSD breakout** | SPI or SDMMC | 8 MB | Flexible DIY option. |
| **Waveshare ESP32-S3 boards** | model-dependent | model-dependent | Pairs with your existing Waveshare e-ink work. |

Avoid the classic ESP32-WROOM without PSRAM for anything but the smallest zines.

## Firmware responsibilities

Implement exactly the routes in [`docs/API.md`](API.md):

1. **Static files** — serve `/`, `/app.js`, `/store.js`, `/styles.css` from the
   SD card (`/web/…`). Serve pre-**gzipped** copies with
   `Content-Encoding: gzip` to cut transfer time and RAM.
2. **`GET /api/health`** — return the capability JSON so the frontend switches
   into "device" mode.
3. **Assets** — `GET/POST /api/assets`, `GET /api/assets/:id`(binary),
   `PATCH`, `DELETE`. Store binaries as `/assets/<id>.<ext>` on the SD card and
   keep a small `/assets/index.json` (or an append-only NDJSON log) for
   metadata. **Prefer `multipart/form-data` for uploads on-device** and stream
   directly to the card to avoid buffering a whole base64 image in RAM (the
   reference server accepts the JSON+dataUrl form for simplicity; support both).
4. **Projects** — `GET/POST /api/projects`, `GET/PUT/DELETE /api/projects/:id`,
   stored as `/projects/<id>.json`.
5. **Identity** — read `X-Zinester-Author` / `X-Zinester-Author-Name`; enforce
   author-only mutation. No accounts, matching the reference server.

## Suggested stack

- **ESP-IDF** with `esp_http_server`, or **Arduino** with
  [`ESPAsyncWebServer`](https://github.com/ESP32Async/ESPAsyncWebServer).
- `SD` / `SD_MMC` for the card; `ArduinoJson` for the metadata index.
- Serve gzipped static assets; set long cache headers on `/api/assets/:id`.

A concrete Arduino sketch skeleton is in [`../firmware/`](../firmware/).

## Serving to visitors

- **SoftAP** ("Zinester" hotspot) for a self-contained, offline device, or
- join your Wi-Fi and advertise via **mDNS** (`zinester.local`).

## Relationship to the Waveshare e-ink / Pocket BBS

Two different roles, both supported:

- **Serve the editor** (this doc): any browser that connects does the editing.
- **Display finished zines** on an e-ink panel: use the app's **E-ink mode** to
  export a 1-bit dithered 300-dpi PNG per page and render that on the panel.
  The dithering matches what the panel can show, so previews are faithful.
