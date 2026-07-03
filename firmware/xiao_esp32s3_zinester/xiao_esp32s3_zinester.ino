// Zinester firmware for the Seeed Studio XIAO ESP32S3 Sense.
// Serves the frontend + storage/sharing API (see ../../docs/API.md) from the
// microSD card, and adds camera capture using the onboard OV2640.
//
// STATUS: reference sketch — feature-complete against docs/API.md (assets +
// projects CRUD, ownership checks, camera frame/capture), written to mirror the
// Node reference server, whose behaviour is verified end-to-end. This sketch has
// NOT itself been compiled or flashed here — verify on hardware. Known caveat:
// image UPLOAD decodes the base64 data URL in RAM (matches the client + Node
// server); for very large images add a multipart onUpload handler that streams
// to the card. Camera capture avoids this entirely (writes the JPEG directly).
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
#include <AsyncJson.h>           // ships with ESPAsyncWebServer — buffers+parses JSON bodies
#include <ArduinoJson.h>
#include "mbedtls/base64.h"      // built-in; decodes uploaded data URLs

// ---- config ----------------------------------------------------------------
static const char* AP_SSID = "Zinester";     // SoftAP name; or switch to STA below
static const char* AP_PASS = "";             // "" = open network

// microSD (XIAO ESP32S3 Sense expansion board) — SPI, confirmed pinout:
#define SD_SCK   7
#define SD_MISO  8
#define SD_MOSI  9
#define SD_CS    21                            // NB: shared with the onboard LED

#define MAX_ASSET_BYTES (8 * 1024 * 1024)      // per-asset cap; matches docs/API.md

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
static JsonArray asArray(JsonDocument& doc) {           // ensure the doc root is an array
  JsonArray a = doc.as<JsonArray>(); return a.isNull() ? doc.to<JsonArray>() : a;
}
// Serialize an index entry as its public form: add "url", drop internal "file".
static String publicEntry(JsonObjectConst m, const char* base) {
  JsonDocument out; out.set(m); out["url"] = String(base) + (const char*)m["id"]; out.remove("file");
  String s; serializeJson(out, s); return s;
}
static void sendJson(AsyncWebServerRequest* req, int code, const String& body) {
  AsyncWebServerResponse* res = req->beginResponse(code, "application/json", body); cors(res); req->send(res);
}
static void sendErr(AsyncWebServerRequest* req, int code, const char* msg) {
  sendJson(req, code, String("{\"error\":\"") + msg + "\"}");
}

// Append an asset's metadata to the index and return its public JSON. Shared by
// camera capture and uploads.
static String registerAsset(AsyncWebServerRequest* req, const String& id, const String& name,
                            const String& mime, const String& file, size_t size, int w, int h,
                            const String& visibility) {
  JsonDocument idx; loadArray("/assets/index.json", idx); JsonArray arr = asArray(idx);
  JsonObject m = arr.add<JsonObject>();
  m["id"] = id; m["name"] = name; m["mime"] = mime; m["file"] = file; m["size"] = size;
  m["w"] = w; m["h"] = h; m["visibility"] = (visibility == "shared") ? "shared" : "private";
  m["authorId"] = authorOf(req); m["authorName"] = authorNameOf(req); m["createdAt"] = (double)millis();
  String body = publicEntry(m, "/api/assets/");
  saveArray("/assets/index.json", idx);
  return body;
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
// The request body {visibility,name} is parsed by the AsyncCallbackJsonWebHandler
// registered in setup(); default to private when absent.
static void handleCapture(AsyncWebServerRequest* req, JsonVariant json) {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) return sendErr(req, 500, "capture failed");
  String id = newId("a_"); String file = "/assets/" + id + ".jpg";
  File out = SD.open(file, FILE_WRITE);
  if (!out) { esp_camera_fb_return(fb); return sendErr(req, 500, "sd write"); }
  out.write(fb->buf, fb->len); out.close();
  size_t len = fb->len; int w = fb->width, h = fb->height; esp_camera_fb_return(fb);

  JsonObject b = json.as<JsonObject>();
  String vis = b["visibility"] | "private"; String name = b["name"] | "photo.jpg";
  String body = registerAsset(req, id, name, "image/jpeg", id + ".jpg", len, w, h, vis);
  sendJson(req, 201, body);
}

// POST /api/assets — JSON { name, dataUrl, w, h, visibility }. Matches the client
// and the Node reference server. NOTE: the base64 body is buffered in RAM; for
// large images prefer a multipart onUpload handler that streams to the card.
static void handleUpload(AsyncWebServerRequest* req, JsonVariant json) {
  JsonObject b = json.as<JsonObject>();
  String dataUrl = b["dataUrl"] | "";
  int comma = dataUrl.indexOf(',');
  int colon = dataUrl.indexOf(':');
  if (comma < 0 || colon != 4) return sendErr(req, 400, "dataUrl required");
  int semi = dataUrl.indexOf(';');
  String mime = dataUrl.substring(5, (semi > 0 && semi < comma) ? semi : comma);
  bool b64 = dataUrl.indexOf(";base64,") > 0;
  const char* enc = dataUrl.c_str() + comma + 1;
  size_t encLen = dataUrl.length() - (comma + 1);

  size_t need = 0;
  if (b64) { mbedtls_base64_decode(nullptr, 0, &need, (const unsigned char*)enc, encLen); }
  else need = encLen;
  if (need == 0 || need > MAX_ASSET_BYTES) return sendErr(req, 413, "asset too large");
  uint8_t* buf = (uint8_t*)ps_malloc(need);
  if (!buf) return sendErr(req, 500, "oom");
  size_t outLen = need;
  if (b64) {
    if (mbedtls_base64_decode(buf, need, &outLen, (const unsigned char*)enc, encLen) != 0) {
      free(buf); return sendErr(req, 400, "bad base64"); }
  } else { memcpy(buf, enc, need); outLen = need; }

  String id = newId("a_"); String ext = extForMime(mime); String file = "/assets/" + id + "." + ext;
  File out = SD.open(file, FILE_WRITE);
  if (!out) { free(buf); return sendErr(req, 500, "sd write"); }
  out.write(buf, outLen); out.close(); free(buf);

  String vis = b["visibility"] | "private"; String name = b["name"] | "asset";
  int w = b["w"] | 0, h = b["h"] | 0;
  String body = registerAsset(req, id, name, mime, id + "." + ext, outLen, w, h, vis);
  sendJson(req, 201, body);
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
static String idFromUrl(AsyncWebServerRequest* req) {   // last path segment of /api/x/:id
  String u = req->url(); int i = u.lastIndexOf('/'); return i >= 0 ? u.substring(i + 1) : u;
}
// PATCH /api/assets/:id — author-only { visibility, name }.
static void handleAssetPatch(AsyncWebServerRequest* req, JsonVariant json) {
  String id = idFromUrl(req);
  JsonDocument idx; loadArray("/assets/index.json", idx);
  for (JsonObject a : idx.as<JsonArray>()) {
    if (id == (const char*)a["id"]) {
      if (String(a["authorId"] | "") != authorOf(req)) return sendErr(req, 403, "not owner");
      JsonObject b = json.as<JsonObject>();
      if (!b["visibility"].isNull()) { String v = b["visibility"].as<String>(); a["visibility"] = (v == "shared") ? "shared" : "private"; }
      if (!b["name"].isNull()) a["name"] = b["name"].as<String>();
      String body = publicEntry(a, "/api/assets/");
      saveArray("/assets/index.json", idx);
      return sendJson(req, 200, body);
    }
  }
  sendErr(req, 404, "not found");
}
// DELETE /api/assets/:id — author-only.
static void handleAssetDelete(AsyncWebServerRequest* req) {
  String id = idFromUrl(req);
  JsonDocument idx; loadArray("/assets/index.json", idx); JsonArray arr = idx.as<JsonArray>();
  for (size_t i = 0; i < arr.size(); i++) {
    JsonObject a = arr[i];
    if (id == (const char*)a["id"]) {
      if (String(a["authorId"] | "") != authorOf(req)) return sendErr(req, 403, "not owner");
      SD.remove(String("/assets/") + (const char*)a["file"]);
      arr.remove(i); saveArray("/assets/index.json", idx);
      return sendJson(req, 200, "{\"ok\":true}");
    }
  }
  sendErr(req, 404, "not found");
}

// ---- projects --------------------------------------------------------------
// GET /api/projects?scope=mine|shared|all
static void handleProjectsList(AsyncWebServerRequest* req) {
  String scope = req->hasParam("scope") ? req->getParam("scope")->value() : "mine";
  String me = authorOf(req);
  JsonDocument idx; loadArray("/projects/index.json", idx);
  JsonDocument out; JsonArray arr = out["projects"].to<JsonArray>();
  for (JsonObject p : idx.as<JsonArray>()) {
    String vis = p["visibility"] | "private"; String au = p["authorId"] | "";
    bool ok = (scope == "shared") ? (vis == "shared") : (scope == "all") ? (vis == "shared" || au == me) : (au == me);
    if (!ok) continue;
    JsonObject o = arr.add<JsonObject>(); o.set(p); o.remove("file");
  }
  String body; serializeJson(out, body); sendJson(req, 200, body);
}
// GET /api/projects/:id — full doc { ...meta, data }.
static void handleProjectGet(AsyncWebServerRequest* req) {
  String id = idFromUrl(req);
  JsonDocument idx; loadArray("/projects/index.json", idx);
  for (JsonObject p : idx.as<JsonArray>()) {
    if (id == (const char*)p["id"]) {
      JsonDocument doc; File f = SD.open(String("/projects/") + (const char*)p["file"], FILE_READ);
      if (!f) return sendErr(req, 404, "missing file");
      DeserializationError e = deserializeJson(doc, f); f.close();
      if (e) return sendErr(req, 500, "read error");
      doc.remove("file"); String body; serializeJson(doc, body); return sendJson(req, 200, body);
    }
  }
  sendErr(req, 404, "not found");
}
// Write a project doc file + return its metadata JSON (without data/file).
static String writeProject(AsyncWebServerRequest* req, const String& id, JsonObject doc, const String& existingFile) {
  String file = existingFile.length() ? existingFile : (id + ".json");
  JsonDocument rec;
  rec["id"] = id;
  rec["name"] = (const char*)(doc["name"] | "Untitled");
  rec["format"] = (const char*)(doc["format"] | "mini8");
  String v = doc["visibility"] | "private"; rec["visibility"] = (v == "shared") ? "shared" : "private";
  rec["authorId"] = authorOf(req); rec["authorName"] = authorNameOf(req);
  rec["updatedAt"] = (double)millis();
  if (!doc["thumb"].isNull()) rec["thumb"] = doc["thumb"];
  // file on disk holds meta + full data
  JsonDocument fileDoc; fileDoc.set(rec); fileDoc["file"] = file; fileDoc["data"] = doc;
  File f = SD.open(String("/projects/") + file, FILE_WRITE);
  if (f) { serializeJson(fileDoc, f); f.close(); }
  String meta; serializeJson(rec, meta); return meta;   // rec has no data/file
}
// POST /api/projects — create from a full project doc.
static void handleProjectPost(AsyncWebServerRequest* req, JsonVariant json) {
  JsonObject doc = json.as<JsonObject>();
  if (doc["panels"].isNull() || doc["format"].isNull()) return sendErr(req, 400, "invalid project");
  String id = newId("p_");
  String meta = writeProject(req, id, doc, "");
  JsonDocument idx; loadArray("/projects/index.json", idx); JsonArray arr = asArray(idx);
  JsonDocument mdoc; deserializeJson(mdoc, meta); JsonObject e = arr.add<JsonObject>();
  e.set(mdoc.as<JsonObject>()); e["file"] = id + ".json";
  saveArray("/projects/index.json", idx);
  sendJson(req, 201, meta);
}
// PUT /api/projects/:id — author-only replace.
static void handleProjectPut(AsyncWebServerRequest* req, JsonVariant json) {
  String id = idFromUrl(req);
  JsonDocument idx; loadArray("/projects/index.json", idx);
  for (JsonObject p : idx.as<JsonArray>()) {
    if (id == (const char*)p["id"]) {
      if (String(p["authorId"] | "") != authorOf(req)) return sendErr(req, 403, "not owner");
      String file = String((const char*)p["file"]);
      String meta = writeProject(req, id, json.as<JsonObject>(), file);
      JsonDocument mdoc; deserializeJson(mdoc, meta);
      p.set(mdoc.as<JsonObject>()); p["file"] = file;
      saveArray("/projects/index.json", idx);
      return sendJson(req, 200, meta);
    }
  }
  sendErr(req, 404, "not found");
}
// DELETE /api/projects/:id — author-only.
static void handleProjectDelete(AsyncWebServerRequest* req) {
  String id = idFromUrl(req);
  JsonDocument idx; loadArray("/projects/index.json", idx); JsonArray arr = idx.as<JsonArray>();
  for (size_t i = 0; i < arr.size(); i++) {
    JsonObject p = arr[i];
    if (id == (const char*)p["id"]) {
      if (String(p["authorId"] | "") != authorOf(req)) return sendErr(req, 403, "not owner");
      SD.remove(String("/projects/") + (const char*)p["file"]);
      arr.remove(i); saveArray("/projects/index.json", idx);
      return sendJson(req, 200, "{\"ok\":true}");
    }
  }
  sendErr(req, 404, "not found");
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
    auto* cap = new AsyncCallbackJsonWebHandler("/api/camera/capture", handleCapture);
    cap->setMethod(HTTP_POST); server.addHandler(cap);
  }

  // assets — GET list/binary + DELETE are plain routes; POST/PATCH carry a JSON
  // body so they go through AsyncCallbackJsonWebHandler (prefix-matches /:id too).
  server.on("/api/assets", HTTP_GET, handleAssetsList);
  server.on("^\\/api\\/assets\\/([A-Za-z0-9_]+)$", HTTP_GET, [](AsyncWebServerRequest* req) {
    handleAssetBinary(req, req->pathArg(0));
  });
  server.on("^\\/api\\/assets\\/([A-Za-z0-9_]+)$", HTTP_DELETE, handleAssetDelete);
  { auto* h = new AsyncCallbackJsonWebHandler("/api/assets", handleUpload); h->setMethod(HTTP_POST); server.addHandler(h); }
  { auto* h = new AsyncCallbackJsonWebHandler("/api/assets", handleAssetPatch); h->setMethod(HTTP_PATCH); server.addHandler(h); }

  // projects
  server.on("/api/projects", HTTP_GET, handleProjectsList);
  server.on("^\\/api\\/projects\\/([A-Za-z0-9_]+)$", HTTP_GET, handleProjectGet);
  server.on("^\\/api\\/projects\\/([A-Za-z0-9_]+)$", HTTP_DELETE, handleProjectDelete);
  { auto* h = new AsyncCallbackJsonWebHandler("/api/projects", handleProjectPost); h->setMethod(HTTP_POST); server.addHandler(h); }
  { auto* h = new AsyncCallbackJsonWebHandler("/api/projects", handleProjectPut); h->setMethod(HTTP_PUT); server.addHandler(h); }

  // static frontend from the SD card (serves gzipped siblings automatically).
  server.serveStatic("/", SD, "/web/").setDefaultFile("index.html");

  server.begin();
  Serial.println("Zinester server up");
}

void loop() { delay(1000); }
