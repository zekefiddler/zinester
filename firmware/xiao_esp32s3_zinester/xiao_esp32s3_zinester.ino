// Zinester firmware for the Seeed Studio XIAO ESP32S3 Sense.
// Serves the frontend + storage/sharing API (see ../../docs/API.md) from the
// microSD card, and adds camera capture using the onboard OV2640.
//
// STATUS: reference sketch — the camera/SD/Wi-Fi/static/health/capture paths are
// written against the board's documented pinout, but this has NOT been compiled
// or flashed here. Verify on hardware. Asset upload (multipart), PATCH/DELETE,
// and the projects CRUD are marked TODO with the exact pattern to follow; they
// mirror the fully-worked capture + list handlers below and the Node reference
// server in ../../server/server.mjs.
//
// Board setup (Arduino IDE): Tools → Board "XIAO_ESP32S3", PSRAM "OPI PSRAM".
// Libraries: ESPAsyncWebServer (ESP32Async fork) + AsyncTCP, ArduinoJson.
// SD card: FAT32, ≤32 GB. Copy the web/ folder to /web on the card, and create
// empty /assets and /projects folders each containing an "index.json" of "[]".

#include "esp_camera.h"
#include <WiFi.h>
#include "FS.h"
#include "SD.h"
#include "SPI.h"
#include <ESPAsyncWebServer.h>   // https://github.com/ESP32Async/ESPAsyncWebServer
#include <ArduinoJson.h>

// ---- config ----------------------------------------------------------------
static const char* AP_SSID = "Zinester";     // SoftAP name; or switch to STA below
static const char* AP_PASS = "";             // "" = open network

// microSD (XIAO ESP32S3 Sense expansion board) — SPI, confirmed pinout:
#define SD_SCK   7
#define SD_MISO  8
#define SD_MOSI  9
#define SD_CS    21                            // NB: shared with the onboard LED

// OV2640 camera pins for the XIAO ESP32S3 Sense (== CAMERA_MODEL_XIAO_ESP32S3).
#define PWDN_GPIO_NUM   -1
#define RESET_GPIO_NUM  -1
#define XCLK_GPIO_NUM   10
#define SIOD_GPIO_NUM   40
#define SIOC_GPIO_NUM   39
#define Y9_GPIO_NUM     48
#define Y8_GPIO_NUM     11
#define Y7_GPIO_NUM     12
#define Y6_GPIO_NUM     14
#define Y5_GPIO_NUM     16
#define Y4_GPIO_NUM     18
#define Y3_GPIO_NUM     17
#define Y2_GPIO_NUM     15
#define VSYNC_GPIO_NUM  38
#define HREF_GPIO_NUM   47
#define PCLK_GPIO_NUM   13

AsyncWebServer server(80);
static uint32_t g_counter = 0;                 // for unique ids (+ millis)

// ---- helpers ---------------------------------------------------------------
static String newId(const char* prefix) {
  return String(prefix) + String((uint32_t)millis(), HEX) + String(g_counter++, HEX);
}
static String authorOf(AsyncWebServerRequest* r) {
  return r->hasHeader("X-Zinester-Author") ? r->getHeader("X-Zinester-Author")->value() : "";
}
static String authorNameOf(AsyncWebServerRequest* r) {
  return r->hasHeader("X-Zinester-Author-Name") ? r->getHeader("X-Zinester-Author-Name")->value() : "";
}
static void cors(AsyncWebServerResponse* res) { res->addHeader("Access-Control-Allow-Origin", "*"); }

// Load / save a JSON array index file from the card (simple full read/rewrite —
// fine for hobby scale; switch to append-only NDJSON if you store many items).
static bool loadArray(const char* path, JsonDocument& doc) {
  File f = SD.open(path, FILE_READ);
  if (!f) { doc.to<JsonArray>(); return true; }
  DeserializationError e = deserializeJson(doc, f); f.close();
  if (e) { doc.to<JsonArray>(); }
  return true;
}
static bool saveArray(const char* path, JsonDocument& doc) {
  File f = SD.open(path, FILE_WRITE); if (!f) return false;
  serializeJson(doc, f); f.close(); return true;
}
static const char* extForMime(const String& m) {
  if (m == "image/jpeg") return "jpg"; if (m == "image/png") return "png";
  if (m == "image/gif") return "gif"; if (m == "image/webp") return "webp"; return "bin";
}

// ---- camera ----------------------------------------------------------------
static bool initCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0; c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;  c.pin_d1 = Y3_GPIO_NUM;  c.pin_d2 = Y4_GPIO_NUM;  c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;  c.pin_d5 = Y7_GPIO_NUM;  c.pin_d6 = Y8_GPIO_NUM;  c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM; c.pin_pclk = PCLK_GPIO_NUM; c.pin_vsync = VSYNC_GPIO_NUM; c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM; c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM; c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000; c.frame_size = FRAMESIZE_SVGA;      // 800x600 preview/capture
  c.pixel_format = PIXFORMAT_JPEG; c.grab_mode = CAMERA_GRAB_LATEST;
  c.fb_location = CAMERA_FB_IN_PSRAM; c.jpeg_quality = 12; c.fb_count = 2;
  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) { Serial.printf("camera init failed 0x%x\n", err); return false; }
  return true;
}

// GET /api/camera/frame.jpg — single live frame for the preview.
static void handleFrame(AsyncWebServerRequest* req) {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) { req->send(500, "application/json", "{\"error\":\"capture failed\"}"); return; }
  AsyncWebServerResponse* res = req->beginResponse_P(200, "image/jpeg", fb->buf, fb->len);
  res->addHeader("Cache-Control", "no-store"); cors(res);
  req->onDisconnect([fb]() { esp_camera_fb_return((camera_fb_t*)fb); });
  req->send(res);
}

// POST /api/camera/capture — grab a frame, store it as an asset, return metadata.
static void handleCapture(AsyncWebServerRequest* req) {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) { req->send(500, "application/json", "{\"error\":\"capture failed\"}"); return; }
  String id = newId("a_"); String file = "/assets/" + id + ".jpg";
  File out = SD.open(file, FILE_WRITE);
  if (!out) { esp_camera_fb_return(fb); req->send(500, "application/json", "{\"error\":\"sd write\"}"); return; }
  out.write(fb->buf, fb->len); out.close();
  size_t len = fb->len; uint16_t w = fb->width, h = fb->height; esp_camera_fb_return(fb);

  JsonDocument idx; loadArray("/assets/index.json", idx);
  JsonObject m = idx.as<JsonArray>().add<JsonObject>();
  m["id"] = id; m["name"] = "photo.jpg"; m["mime"] = "image/jpeg"; m["file"] = id + ".jpg";
  m["size"] = len; m["w"] = w; m["h"] = h;
  m["visibility"] = "private";           // honour body {visibility} if you parse it
  m["authorId"] = authorOf(req); m["authorName"] = authorNameOf(req);
  m["createdAt"] = (double)millis();
  saveArray("/assets/index.json", idx);

  JsonDocument outDoc; outDoc.set(m); outDoc["url"] = "/api/assets/" + id; outDoc.remove("file");
  String body; serializeJson(outDoc, body);
  AsyncWebServerResponse* res = req->beginResponse(201, "application/json", body); cors(res); req->send(res);
}

// ---- assets ----------------------------------------------------------------
// GET /api/assets?scope=shared|mine|all
static void handleAssetsList(AsyncWebServerRequest* req) {
  String scope = req->hasParam("scope") ? req->getParam("scope")->value() : "shared";
  String me = authorOf(req);
  JsonDocument idx; loadArray("/assets/index.json", idx);
  JsonDocument out; JsonArray arr = out["assets"].to<JsonArray>();
  for (JsonObject a : idx.as<JsonArray>()) {
    String vis = a["visibility"] | "private"; String au = a["authorId"] | "";
    bool ok = (scope == "mine") ? (au == me) : (scope == "all") ? (vis == "shared" || au == me) : (vis == "shared");
    if (!ok) continue;
    JsonObject o = arr.add<JsonObject>(); o.set(a); o["url"] = String("/api/assets/") + (const char*)a["id"]; o.remove("file");
  }
  String body; serializeJson(out, body);
  AsyncWebServerResponse* res = req->beginResponse(200, "application/json", body); cors(res); req->send(res);
}
// GET /api/assets/:id — stream the binary from the card.
static void handleAssetBinary(AsyncWebServerRequest* req, const String& id) {
  JsonDocument idx; loadArray("/assets/index.json", idx);
  for (JsonObject a : idx.as<JsonArray>()) {
    if (id == (const char*)a["id"]) {
      String path = String("/assets/") + (const char*)a["file"];
      AsyncWebServerResponse* res = req->beginResponse(SD, path, a["mime"] | "application/octet-stream");
      res->addHeader("Cache-Control", "public, max-age=31536000, immutable"); cors(res); req->send(res); return;
    }
  }
  req->send(404, "application/json", "{\"error\":\"not found\"}");
}

// ---- setup / routes --------------------------------------------------------
void setup() {
  Serial.begin(115200);

  bool haveCam = initCamera();      // init camera before touching SPI/SD

  SPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  bool haveSD = SD.begin(SD_CS);
  if (!haveSD) Serial.println("SD init failed — check card (FAT32) and J3 pads");
  if (haveSD) { SD.mkdir("/assets"); SD.mkdir("/projects"); }

  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, strlen(AP_PASS) ? AP_PASS : nullptr);
  Serial.print("AP IP: "); Serial.println(WiFi.softAPIP());   // usually 192.168.4.1

  // Preflight
  server.onNotFound([](AsyncWebServerRequest* r) {
    if (r->method() == HTTP_OPTIONS) { AsyncWebServerResponse* res = r->beginResponse(204); cors(res);
      res->addHeader("Access-Control-Allow-Headers", "Content-Type,X-Zinester-Author,X-Zinester-Author-Name,X-Zinester-Admin");
      res->addHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS"); r->send(res); }
    else r->send(404, "application/json", "{\"error\":\"no such route\"}");
  });

  // health — advertises the camera capability to the frontend.
  server.on("/api/health", HTTP_GET, [haveCam](AsyncWebServerRequest* req) {
    String body = String("{\"ok\":true,\"name\":\"zinester-xiao-s3\",\"storage\":\"sd\",\"sharing\":true,\"camera\":")
      + (haveCam ? "true" : "false") + ",\"maxAssetBytes\":8388608,\"version\":1}";
    AsyncWebServerResponse* res = req->beginResponse(200, "application/json", body); cors(res); req->send(res);
  });

  // camera
  if (haveCam) {
    server.on("/api/camera/frame.jpg", HTTP_GET, handleFrame);
    server.on("/api/camera/capture", HTTP_POST, handleCapture);
  }

  // assets
  server.on("/api/assets", HTTP_GET, handleAssetsList);
  server.on("^\\/api\\/assets\\/([A-Za-z0-9_]+)$", HTTP_GET, [](AsyncWebServerRequest* req) {
    handleAssetBinary(req, req->pathArg(0));
  });
  // TODO POST /api/assets — accumulate the request body (JSON {name,dataUrl,...}
  //   via an onBody handler or, preferably, register an onUpload multipart
  //   handler and stream chunks straight to /assets/<id>.<ext>), then append to
  //   /assets/index.json exactly like handleCapture(). Enforce MAX_ASSET_BYTES.
  // TODO PATCH/DELETE /api/assets/:id — load index, match id, require
  //   authorOf(req) == a["authorId"], then rewrite / SD.remove the file.

  // TODO projects — GET/POST /api/projects and GET/PUT/DELETE /api/projects/:id,
  //   stored as /projects/<id>.json with /projects/index.json metadata; same
  //   author-only rule. Mirror server/server.mjs.

  // static frontend from the SD card (serves gzipped siblings automatically).
  server.serveStatic("/", SD, "/web/").setDefaultFile("index.html");

  server.begin();
  Serial.println("Zinester server up");
}

void loop() { delay(1000); }
