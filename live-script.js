/*
 * Home energy: live figures for the family app.
 *
 * This is NOT part of the app's page. It's a small Google Apps Script, pasted into
 * script.google.com in the house's own Google account (the walk-through, part 4).
 * It reads the inverter's latest reading from FoxESS and hands it to the family app,
 * about every 5 minutes, which is as often as FoxESS's cloud updates.
 *
 * - It only reads: the two FoxESS calls below. Nothing here can change the inverter.
 * - The FoxESS key stays in this script's properties (FOXESS_API_KEY). Nobody has to
 *   type it: the playbook's daily job hands it over (doPost below), and it's only
 *   kept once FoxESS has accepted it. It's never sent back out, to the app or anyone.
 * - Several screens share one FoxESS call: a reading is kept for 4 minutes.
 * - Deploy as a web app: Execute as "Me", Who has access "Anyone". Its address is
 *   the only thing the app needs, and it's kept private (in GitHub's secrets and the
 *   private figures repository), because the figures show when the house is in use.
 */

var FOXESS = "https://www.foxesscloud.com";
var READ_ONLY = ["/op/v0/device/list", "/op/v0/device/real/query"];   // nothing that changes settings
var VARIABLES = ["pvPower", "loadsPower", "gridConsumptionPower", "feedinPower",
                 "batChargePower", "batDischargePower", "SoC"];
var KEEP_SECONDS = 240;

// The daily job hands over the FoxESS key here (a POST with {"foxess_key": "..."}).
// A key is only kept once FoxESS has accepted it, and never replaces one that still
// works, so the address alone can't be used to swap the key. The answer never
// includes the key.
function doPost(e) {
  var posted = "";
  try { posted = String(JSON.parse((e && e.postData && e.postData.contents) || "{}").foxess_key || "").trim(); }
  catch (error) { return answer_({ ok: false, error: "That wasn't JSON." }); }
  if (!posted) return answer_({ ok: false, error: "No key was sent." });
  var properties = PropertiesService.getScriptProperties();
  var current = (properties.getProperty("FOXESS_API_KEY") || "").trim();
  if (posted === current) return answer_({ ok: true, key: "already saved" });
  if (current && inverter_(current)) return answer_({ ok: true, key: "kept: the saved key still works" });
  var sn = inverter_(posted);
  if (!sn) return answer_({ ok: false, error: "FoxESS refused the key that was sent." });
  properties.setProperty("FOXESS_API_KEY", posted);
  properties.setProperty("FOXESS_SN", sn);
  CacheService.getScriptCache().remove("live");
  return answer_({ ok: true, key: "saved" });
}

// The inverter's serial number if FoxESS accepts this key, or "" if not.
function inverter_(key) {
  try {
    var list = call_("/op/v0/device/list", { currentPage: 1, pageSize: 10 }, key);
    return (list && list.data && list.data[0] && list.data[0].deviceSN) || "";
  } catch (error) {
    return "";
  }
}

function answer_(object) {
  return ContentService.createTextOutput(JSON.stringify(object)).setMimeType(ContentService.MimeType.JSON);
}

// The family app asks here (a web app's GET request).
function doGet() {
  var cache = CacheService.getScriptCache();
  var text = cache.get("live");
  if (!text) {
    try {
      text = JSON.stringify(reading_());
      cache.put("live", text, KEEP_SECONDS);
    } catch (error) {
      text = JSON.stringify({ ok: false, error: String((error && error.message) || error).slice(0, 300) });
    }
  }
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

// Optional: run this from the editor (pick "test", then Run) once the key is saved:
// the reading shows in the Execution log.
function test() {
  var r = reading_();
  Logger.log("FoxESS reading at " + r.time + ": solar " + r.solar_kw + " kW, house " + r.house_kw +
             " kW, buying " + r.buying_kw + " kW, selling " + r.selling_kw + " kW, battery " +
             r.battery_percent + "%.");
}

function reading_() {
  var properties = PropertiesService.getScriptProperties();
  var key = (properties.getProperty("FOXESS_API_KEY") || "").trim();
  if (!key) throw new Error("No FoxESS key yet: the next daily update hands it over.");
  var sn = properties.getProperty("FOXESS_SN");
  if (!sn) {                                      // the inverter's serial number, found once and kept
    var list = call_("/op/v0/device/list", { currentPage: 1, pageSize: 10 }, key);
    sn = list && list.data && list.data[0] && list.data[0].deviceSN;
    if (!sn) throw new Error("FoxESS lists no inverter for this key.");
    properties.setProperty("FOXESS_SN", sn);
  }
  var result = call_("/op/v0/device/real/query", { sn: sn, variables: VARIABLES }, key);
  var latest = (result && result[0]) || {};
  var v = {};
  (latest.datas || []).forEach(function (d) { v[d.variable] = d.value; });
  return {
    ok: true,
    time: latest.time || "",                      // FoxESS's time of the reading, e.g. "2026-10-23 17:00:27 BST+0100"
    solar_kw: v.pvPower,
    house_kw: v.loadsPower,
    buying_kw: v.gridConsumptionPower,
    selling_kw: v.feedinPower,
    battery_charge_kw: v.batChargePower,
    battery_discharge_kw: v.batDischargePower,
    battery_percent: v.SoC,
    asked: new Date().toISOString()
  };
}

// One FoxESS call, signed the way FoxESS's Open API asks: an MD5 of the path, the key
// and the time, joined by the literal characters backslash-r-backslash-n.
function call_(path, body, key) {
  if (READ_ONLY.indexOf(path) < 0) throw new Error("Refused: " + path + " isn't a reading call.");
  var timestamp = String(Date.now());
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5,
                                       path + "\\r\\n" + key + "\\r\\n" + timestamp, Utilities.Charset.UTF_8);
  var signature = digest.map(function (b) { return ("0" + (b & 255).toString(16)).slice(-2); }).join("");
  var response = UrlFetchApp.fetch(FOXESS + path, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(body),
    headers: { token: key, timestamp: timestamp, signature: signature, lang: "en" },
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  if (code === 401 || code === 403) {
    throw new Error("FoxESS refused the key (" + code + "). A new key in GitHub's FOXESS_API_KEY reaches this script with the next daily update.");
  }
  var answer;
  try {
    answer = JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error("FoxESS answered " + code + " with something that isn't JSON.");
  }
  if (answer.errno !== 0) throw new Error("FoxESS " + path + ": " + answer.errno + " " + (answer.msg || answer.message || ""));
  return answer.result;
}
