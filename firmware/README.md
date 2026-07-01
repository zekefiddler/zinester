# Zinester ESP32 firmware (reference skeleton)

A starting point for serving the Zinester frontend and storage API from an
ESP32 with an SD card. It implements the contract in
[`../docs/API.md`](../docs/API.md). **This is an untested reference skeleton** —
board wiring (SD CS pin, SPI vs SDMMC) and the exact web-server API vary by
setup, so treat it as a scaffold, not a drop-in binary. Verify on real hardware.

Copy `web/` onto the SD card (ideally pre-gzipped) plus empty `assets/` and
`projects/` folders with `index.json` = `[]`.

## Arduino (ESPAsyncWebServer) skeleton

```cpp
#include <WiFi.h>
#include <SD.h>
#include <ESPAsyncWebServer.h>   // https://github.com/ESP32Async/ESPAsyncWebServer
#include <ArduinoJson.h>

#define SD_CS 5                  // set to your board's SD chip-select
AsyncWebServer server(80);

static String authorOf(AsyncWebServerRequest* r) {
  return r->hasHeader("X-Zinester-Author") ? r->getHeader("X-Zinester-Author")->value() : "";
}

void setup() {
  Serial.begin(115200);
  if (!SD.begin(SD_CS)) { Serial.println("SD init failed"); return; }

  // Wi-Fi: SoftAP for a self-contained device, or WiFi.begin(ssid, pass).
  WiFi.softAP("Zinester");

  // Capability probe — this is how the frontend enters "device" mode.
  server.on("/api/health", HTTP_GET, [](AsyncWebServerRequest* req) {
    req->send(200, "application/json",
      "{\"ok\":true,\"name\":\"zinester-esp32\",\"storage\":\"sd\","
      "\"sharing\":true,\"maxAssetBytes\":8388608,\"version\":1}");
  });

  // List assets (filter by ?scope=shared|mine|all against index.json).
  server.on("/api/assets", HTTP_GET, [](AsyncWebServerRequest* req) {
    // read /assets/index.json, filter by visibility / author, strip internal
    // "file" field, respond { "assets": [...] }.  Use ArduinoJson streaming.
  });

  // Binary asset — served straight off the card with a long cache header.
  server.on("^\\/api\\/assets\\/([A-Za-z0-9_]+)$", HTTP_GET, [](AsyncWebServerRequest* req) {
    String id = req->pathArg(0);
    // look up file+mime in index.json, then:
    // AsyncWebServerResponse* r = req->beginResponse(SD, "/assets/"+file, mime);
    // r->addHeader("Cache-Control","public, max-age=31536000, immutable");
    // req->send(r);
  });

  // Upload — PREFER multipart on-device: stream chunks to the card so a whole
  // base64 image never sits in RAM. (The reference server also accepts JSON
  // {name,dataUrl,...}; support both if you like.)
  server.on("/api/assets", HTTP_POST,
    [](AsyncWebServerRequest* req){ /* finalize: append metadata to index.json, send 201 */ },
    [](AsyncWebServerRequest* req, String fn, size_t i, uint8_t* data, size_t len, bool last){
      /* open /assets/<newid>.<ext> on first chunk, File.write(data,len), close on last */
    });

  // PATCH/DELETE /api/assets/:id  — author-only (compare authorOf(req)).
  // GET/POST/GET/PUT/DELETE /api/projects[...]  — JSON docs under /projects/.

  // Static frontend from the SD card, gzip-aware, index.html as default.
  server.serveStatic("/", SD, "/web/").setDefaultFile("index.html");

  server.begin();
}

void loop() {}
```

## Notes

- Serve **pre-gzipped** `app.js.gz` / `styles.css.gz` with
  `Content-Encoding: gzip` (ESPAsyncWebServer's `serveStatic` can auto-pick a
  `.gz` sibling) to save transfer time and RAM.
- Keep `index.json` small; for many assets prefer an append-only NDJSON log
  compacted occasionally, so writes don't rewrite a large file each time.
- Enforce author-only mutation with the `X-Zinester-Author` header — same rule
  as the reference server. A device-admin PIN (`X-Zinester-Admin`) is optional.
- Cross-check every route against [`../docs/API.md`](../docs/API.md); the
  frontend depends only on that contract.
