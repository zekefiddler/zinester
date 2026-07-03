# Zinester firmware — Seeed Studio XIAO ESP32S3 Sense

Serves the Zinester frontend and storage/sharing API
([`../docs/API.md`](../docs/API.md)) from the microSD card, and adds **camera
capture** using the board's OV2640. The visitor's browser does the editing; the
board is a small web server + file store, with the camera as a bonus asset
source.

> **Status:** [`xiao_esp32s3_zinester/`](xiao_esp32s3_zinester/) is
> **feature-complete** against [`../docs/API.md`](../docs/API.md): static
> serving, `/api/health`, camera **frame + capture**, full **assets** CRUD
> (list, binary, upload, PATCH, DELETE) and full **projects** CRUD — all with
> author-only ownership checks — written to mirror the Node reference server,
> whose behaviour is verified end-to-end here. **The sketch itself has not been
> compiled or flashed here — verify on hardware.**
>
> One deliberate caveat: image **upload** decodes the base64 data URL in RAM (to
> match the client and Node server). Camera capture writes the JPEG straight to
> the card and is unaffected. For very large uploads, add a multipart `onUpload`
> handler that streams to the card — see below.

## This board (verified specs)

- ESP32-S3R8: dual-core LX7, **8 MB PSRAM**, 8 MB flash, Wi-Fi + BLE.
- **OV2640** 2 MP camera (Sense expansion board), via `CAMERA_MODEL_XIAO_ESP32S3`.
- **microSD** slot on the Sense board over **SPI**: `SCK=7, MISO=8, MOSI=9,
  CS=21`. `SD.begin(21)`. Card must be **FAT32, ≤32 GB**.
- Note: `GPIO21` is shared with the onboard LED. Camera + SD work together on the
  bare Sense board; the well-known conflict is only with the **round-display**
  add-on (cut its `J3` pads if you stack one).

## Prepare the SD card

```
/web/            ← copy this repo's web/ folder here (gzip app.js/styles.css to
                   app.js.gz etc. to save RAM/time; serveStatic auto-picks .gz)
/assets/index.json     ← contains: []
/projects/index.json   ← contains: []
```

## Build & flash

**PlatformIO:** open `xiao_esp32s3_zinester/`, then `pio run -t upload`.

**Arduino IDE:** Tools → Board **XIAO_ESP32S3**, PSRAM **OPI PSRAM**; install
libraries **ESPAsyncWebServer** (ESP32Async fork) + **AsyncTCP** and
**ArduinoJson**; open the `.ino` and upload.

## Connect

The sketch starts a **SoftAP** named `Zinester` (edit `AP_SSID`/`AP_PASS`, or
switch to joining your Wi-Fi in STA mode). Join it and browse to
`http://192.168.4.1/`. The header badge should read **device** and a **📷**
button appears in the toolbar because `/api/health` reports `camera: true`.

## Optional: streamed multipart upload (large images)

The one place the sketch buffers in RAM is `POST /api/assets` (it base64-decodes
the data URL, matching the client). If you want to support very large uploads,
add a multipart `onUpload` handler that streams chunks straight to
`/assets/<id>.<ext>` and then calls `registerAsset(...)` in the request
callback — and switch `RemoteStore.putAsset` in [`../web/store.js`](../web/store.js)
to send `FormData` instead of a JSON data URL (and teach
[`../server/server.mjs`](../server/server.mjs) to parse multipart, so the
website path keeps working too). Everything else already streams: camera capture
writes the frame directly, and `GET /api/assets/:id` serves the file off the card
without buffering.

Cross-check every route against [`../docs/API.md`](../docs/API.md) — the frontend
depends only on that contract.
