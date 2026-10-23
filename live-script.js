/*
 * Home energy: live figures for the family app.
 *
 * This is NOT part of the app's page. It's a small Google Apps Script, pasted into
 * script.google.com in the house's own Google account (the walk-through, part 4).
 * It reads the inverter's figures from FoxESS and hands them to the family app,
 * about every 5 minutes, which is as often as FoxESS's cloud updates.
 *
 * - It only reads: the FoxESS calls in READ_ONLY below, the same reading calls the playbook's
 *   own download may make. Nothing here can change the inverter.
 * - The FoxESS key stays in this script's properties (FOXESS_API_KEY). Nobody has to
 *   type it: the playbook's daily job hands it over (doPost below), and it's only
 *   kept once FoxESS has accepted it. It's never sent back out, to the app or anyone.
 * - Several screens share one FoxESS call: today's figures are kept for 4 minutes,
 *   past days for longer, and it stops at 1,000 FoxESS calls a day (FoxESS allows
 *   1,440, and the playbook's daily job needs some).
 * - Deploy as a web app: Execute as "Me", Who has access "Anyone". Its address is
 *   the only thing the app needs, and it's kept private (in GitHub's secrets and the
 *   private figures repository), because the figures show when the house is in use.
 *
 * What it answers (each a GET to the web app's address):
 *   (nothing)               the latest reading, as version 1 did
 *   ?want=day&date=Y-M-D    a day's 5-minute readings and its totals (no date: today)
 *   ?want=month&date=Y-M    each day's totals in a month
 *   ?want=year&date=Y       each month's totals in a year
 *   ?want=fox&path=P&body=B&keep=S
 *                           any of FoxESS's reading calls in RELAY, passed on as it is (B: the
 *                           call's JSON body; S: seconds to keep the answer). This is what lets the
 *                           app show new kinds of figures without this script being pasted again.
 *   ?want=version           this script's version, and how many FoxESS calls it has made today
 * Version 2, 2026-10-23: the day, month and year answers, for the app's charts.
 * Version 3, 2026-10-23: ?want=fox and ?want=version, and FoxESS's own house meter in the totals.
 */

var VERSION = 3;
var FOXESS = "https://www.foxesscloud.com";
// The only FoxESS calls this script can make: the playbook's reading calls. Nothing that changes settings.
var READ_ONLY = ["/op/v0/device/list", "/op/v0/device/real/query", "/op/v0/device/history/query",
                 "/op/v0/device/report/query", "/op/v0/device/generation", "/op/v0/device/battery/soc/get",
                 "/op/v0/device/battery/forceChargeTime/get", "/op/v1/device/scheduler/get",
                 "/op/v0/user/getAccessCount"];
// What the app can ask FoxESS for directly (?want=fox), and how each call is sent: [method, where the
// inverter's serial number goes]. Every reading call but the device list, which names the house.
var RELAY = {
  "/op/v0/device/real/query": ["post", "sn"],
  "/op/v0/device/history/query": ["post", "sn"],
  "/op/v0/device/report/query": ["post", "sn"],
  "/op/v0/device/generation": ["get", "sn"],
  "/op/v0/device/battery/soc/get": ["get", "sn"],
  "/op/v0/device/battery/forceChargeTime/get": ["get", "sn"],
  "/op/v1/device/scheduler/get": ["post", "deviceSN"],
  "/op/v0/user/getAccessCount": ["get", ""]
};
var BODY_LIMIT = 2000;           // characters: a reading call's body is far shorter
var VARIABLES = ["pvPower", "loadsPower", "gridConsumptionPower", "feedinPower",
                 "batChargePower", "batDischargePower", "SoC"];
var ROOFS = ["pv1Power", "pv2Power"];                     // each roof's solar
var NAMES = { pvPower: "solar", loadsPower: "house", gridConsumptionPower: "buying", feedinPower: "selling",
              batChargePower: "charging", batDischargePower: "giving", SoC: "battery",
              pv1Power: "roof1", pv2Power: "roof2" };
// FoxESS's own meters, in kWh (the five the playbook's daily figures use, and its house meter)
var TOTALS = { PVEnergyTotal: "solar", gridConsumption: "bought", feedin: "sold",
               chargeEnergyToTal: "charged", dischargeEnergyToTal: "gave", loads: "house" };
var KEEP_SECONDS = 240;          // today: FoxESS's cloud updates about every 5 minutes
var KEEP_YESTERDAY = 3600;       // yesterday's last readings can arrive a little late
var KEEP_PAST = 21600;           // older: 6 hours, the longest Google keeps anything
var DAILY_CALLS = 1000;
var ZONE = "Europe/London";
var FIRST_MONTH = "2023-01";

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
function doGet(e) {
  var asked = (e && e.parameter) || {};
  var want = String(asked.want || "now"), date = String(asked.date || "");
  var answer;
  try {
    if (want === "now") answer = kept_("live", KEEP_SECONDS, reading_);
    else if (want === "day") answer = day_(date);
    else if (want === "month") answer = month_(date);
    else if (want === "year") answer = year_(date);
    else if (want === "fox") answer = relay_(String(asked.path || ""), String(asked.body || ""), asked.keep);
    else if (want === "version") answer = about_();
    else throw new Error("The app asked for something this script doesn't know: " + want.slice(0, 20) + ".");
  } catch (error) {
    answer = { ok: false, version: VERSION, error: String((error && error.message) || error).slice(0, 300) };
  }
  return answer_(answer);
}

// Optional: run this from the editor (pick "test", then Run) once the key is saved:
// the reading and today's figures show in the Execution log.
function test() {
  var r = reading_();
  Logger.log("FoxESS reading at " + r.time + ": solar " + r.solar_kw + " kW, house " + r.house_kw +
             " kW, buying " + r.buying_kw + " kW, selling " + r.selling_kw + " kW, battery " +
             r.battery_percent + "%.");
  var d = day_("");
  Logger.log("Today so far: " + d.points.t.length + " readings; solar " + d.totals.solar + " kWh, bought " +
             d.totals.bought + " kWh. FoxESS calls today: " + PropertiesService.getScriptProperties().getProperty("CALLS_USED") + ".");
}

// ---- the answers

function reading_() {
  var fox = fox_();
  var result = call_("/op/v0/device/real/query", { sn: fox.sn, variables: VARIABLES }, fox.key);
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

// A day: every 5-minute reading (kW, and the battery's %), and the day's totals (kWh) from
// FoxESS's meters. Each hour's totals are left out: FoxESS rounds them down, so they add
// up to less than the day's (6.5 kWh of solar against 7.2 on 2026-10-22).
function day_(date) {
  var today = Utilities.formatDate(new Date(), ZONE, "yyyy-MM-dd");
  if (!date) date = today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today || date.slice(0, 7) < FIRST_MONTH) {
    throw new Error("There are no figures for that day.");
  }
  var keep = date === today ? KEEP_SECONDS : date === nextDate_(today, -1) ? KEEP_YESTERDAY : KEEP_PAST;
  return kept_("day:" + date, keep, function () {
    var fox = fox_();
    var start = midnight_(date), end = midnight_(nextDate_(date, 1)), until = Math.min(end, Date.now());
    // FoxESS gives at most 24 hours at a time, and the day the clocks go back has 25: that day
    // is asked for in two halves (as the playbook's own download does)
    var spans = [[start, until]];
    if (until - start > 24 * 3600 * 1000) {
      var middle = start + Math.floor((until - start) / 2);
      spans = [[start, middle - 1000], [middle, until]];
    }
    var datas = [];
    spans.forEach(function (span) {
      var history = call_("/op/v0/device/history/query", { sn: fox.sn, variables: VARIABLES.concat(ROOFS),
                                                            begin: span[0], end: span[1] }, fox.key);
      datas = datas.concat((history && history[0] && history[0].datas) || []);
    });
    var points = points_(datas, start);
    var month = monthKept_(date.slice(0, 7), date === today), totals = {};
    Object.keys(month.days).forEach(function (name) { totals[name] = month.days[name][+date.slice(8, 10) - 1]; });
    var answer = { ok: true, version: VERSION, date: date, start: start / 1000, end: end / 1000,
                   points: points.columns, totals: totals, fetched: new Date().toISOString() };
    if (date === today && points.last) answer.now = points.last;
    return answer;
  });
}

function month_(date) {
  var now = Utilities.formatDate(new Date(), ZONE, "yyyy-MM");
  if (!date) date = now;
  if (!/^\d{4}-\d{2}$/.test(date) || date > now || date < FIRST_MONTH) throw new Error("There are no figures for that month.");
  return kept_("month:" + date, date === now ? KEEP_SECONDS : KEEP_PAST, function () { return monthFigures_(date); });
}

// The month's figures for a day's totals: kept ones, unless today's are wanted, which are
// always fetched again (the kept copy is shared with the month answer). Called under the lock.
function monthKept_(month, fresh) {
  var cache = CacheService.getScriptCache();
  var text = fresh ? null : cache.get("month:" + month);
  if (text) return JSON.parse(text);
  var made = monthFigures_(month);
  var current = month === Utilities.formatDate(new Date(), ZONE, "yyyy-MM");
  try { cache.put("month:" + month, JSON.stringify(made), current ? KEEP_SECONDS : KEEP_PAST); } catch (tooBig) {}
  return made;
}

function monthFigures_(month) {
  var fox = fox_();
  var report = report_({ sn: fox.sn, dimension: "month", year: +month.slice(0, 4), month: +month.slice(5, 7) }, fox.key);
  return { ok: true, version: VERSION, month: month, days: totals_(report), fetched: new Date().toISOString() };
}

// FoxESS's meters by day (dimension "month") or by month ("year"). Its house meter ("loads") isn't in FoxESS's
// document, so if FoxESS ever refuses it (40257: a wrong parameter), the other five are asked for without it, as the
// playbook's own download does.
function report_(body, key) {
  body.variables = Object.keys(TOTALS);
  try {
    return call_("/op/v0/device/report/query", body, key);
  } catch (error) {
    if (String((error && error.message) || error).indexOf(" 40257 ") < 0) throw error;
    body.variables = Object.keys(TOTALS).filter(function (v) { return v !== "loads"; });
    return call_("/op/v0/device/report/query", body, key);
  }
}

function year_(date) {
  var now = Utilities.formatDate(new Date(), ZONE, "yyyy");
  if (!date) date = now;
  if (!/^\d{4}$/.test(date) || date > now || date < FIRST_MONTH.slice(0, 4)) throw new Error("There are no figures for that year.");
  return kept_("year:" + date, date === now ? 3600 : KEEP_PAST, function () {
    var fox = fox_();
    var report = report_({ sn: fox.sn, dimension: "year", year: +date }, fox.key);
    return { ok: true, version: VERSION, year: date, months: totals_(report), fetched: new Date().toISOString() };
  });
}

// Any reading call in RELAY, for the app. The script fills in the inverter's serial number (whatever
// the app sent) and takes it back out of the answer.
function relay_(path, bodyText, keep) {
  var how = RELAY.hasOwnProperty(path) ? RELAY[path] : null;
  if (!how) throw new Error("This script only passes on FoxESS's reading calls, and not the device list.");
  if (bodyText.length > BODY_LIMIT) throw new Error("That request is too long.");
  var body = {};
  if (bodyText) {
    try { body = JSON.parse(bodyText); } catch (error) { throw new Error("The request's body wasn't JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("The request's body wasn't a JSON object.");
  }
  var seconds = Math.max(60, Math.min(KEEP_PAST, Math.round(Number(keep)) || KEEP_SECONDS));
  return kept_("fox:" + md5_(path + "\n" + JSON.stringify(body) + "\n" + seconds), seconds, function () {
    var fox = fox_(), query = null;
    if (how[0] === "get") {
      body = null;
      if (how[1]) { query = {}; query[how[1]] = fox.sn; }
    } else if (how[1]) {
      body[how[1]] = fox.sn;
    }
    var result = call_(path, body, fox.key, how[0], query);
    var text = JSON.stringify(result === undefined ? null : result).split(fox.sn).join("");
    return { ok: true, version: VERSION, path: path, result: JSON.parse(text), fetched: new Date().toISOString() };
  });
}

// This script's version, what the app can ask for, and today's FoxESS calls. No FoxESS call.
function about_() {
  var properties = PropertiesService.getScriptProperties();
  var today = Utilities.formatDate(new Date(), ZONE, "yyyy-MM-dd");
  return { ok: true, version: VERSION, relay: Object.keys(RELAY), calls_limit: DAILY_CALLS,
           calls_today: properties.getProperty("CALLS_DAY") === today ? Number(properties.getProperty("CALLS_USED")) || 0 : 0,
           key_saved: !!(properties.getProperty("FOXESS_API_KEY") || "").trim() };
}

// FoxESS's history -> {columns: {t: [seconds after midnight], solar: [kW], ...}, last: the latest reading}
function points_(datas, start) {
  var times = [], seen = {}, columns = {}, raw = {};
  datas.forEach(function (d) {
    var name = NAMES[d.variable];
    if (!name) return;
    var column = columns[name] || (columns[name] = {});         // a variable can come in two halves
    (d.data || []).forEach(function (point) {
      var at = foxTime_(point.time);
      if (at === null) return;
      var s = Math.round((at - start) / 60000) * 60;            // to the minute
      if (!seen[s]) { seen[s] = true; times.push(s); raw[s] = point.time; }
      column[s] = point.value == null || isNaN(Number(point.value)) ? null : Math.round(Number(point.value) * 1000) / 1000;
    });
  });
  times.sort(function (a, b) { return a - b; });
  var out = { t: times };
  Object.keys(columns).forEach(function (name) {
    out[name] = times.map(function (s) { return s in columns[name] ? columns[name][s] : null; });
  });
  var last = null, i = times.length - 1;
  if (i >= 0) {
    var at = function (name) { return out[name] ? out[name][i] : null; };
    last = { ok: true, time: raw[times[i]], solar_kw: at("solar"), house_kw: at("house"), buying_kw: at("buying"),
             selling_kw: at("selling"), battery_charge_kw: at("charging"), battery_discharge_kw: at("giving"),
             battery_percent: at("battery"), roof1_kw: at("roof1"), roof2_kw: at("roof2") };
  }
  return { columns: out, last: last };
}

// FoxESS's report -> {solar: [kWh], bought: [...], ...}, one value per day or month
function totals_(report) {
  var out = {};
  (report || []).forEach(function (r) {
    var name = TOTALS[r.variable];
    if (name) out[name] = (r.values || []).map(function (v) { return v == null ? null : Math.round(Number(v) * 100) / 100; });
  });
  return out;
}

// ---- helpers

// The key and the inverter's serial number (found once and kept).
function fox_() {
  var properties = PropertiesService.getScriptProperties();
  var key = (properties.getProperty("FOXESS_API_KEY") || "").trim();
  if (!key) throw new Error("No FoxESS key yet: the next daily update hands it over.");
  var sn = properties.getProperty("FOXESS_SN");
  if (!sn) {
    var list = call_("/op/v0/device/list", { currentPage: 1, pageSize: 10 }, key);
    sn = list && list.data && list.data[0] && list.data[0].deviceSN;
    if (!sn) throw new Error("FoxESS lists no inverter for this key.");
    properties.setProperty("FOXESS_SN", sn);
  }
  return { key: key, sn: sn };
}

// A kept answer, or a new one, made once even when several screens ask at the same moment.
function kept_(name, seconds, make) {
  var cache = CacheService.getScriptCache();
  var text = cache.get(name);
  if (text) return JSON.parse(text);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error("Busy: try again in a minute.");
  try {
    text = cache.get(name);                                     // another screen may have just fetched it
    if (text) return JSON.parse(text);
    var made = make();
    try { cache.put(name, JSON.stringify(made), seconds); } catch (tooBig) {}
    return made;
  } finally {
    lock.releaseLock();
  }
}

// Counts FoxESS calls per UK day and stops at DAILY_CALLS, so a screen left on (or a
// mistake) can't use up FoxESS's daily allowance, which the daily job needs too.
function spend_() {
  var properties = PropertiesService.getScriptProperties();
  var today = Utilities.formatDate(new Date(), ZONE, "yyyy-MM-dd");
  var used = properties.getProperty("CALLS_DAY") === today ? Number(properties.getProperty("CALLS_USED")) || 0 : 0;
  if (used >= DAILY_CALLS) throw new Error("Today's " + DAILY_CALLS + " FoxESS readings are used up: more after midnight.");
  properties.setProperty("CALLS_DAY", today);
  properties.setProperty("CALLS_USED", String(used + 1));
}

// Midnight in the UK at the start of a date, in milliseconds.
function midnight_(date) {
  return Utilities.parseDate(date + " 00:00:00", ZONE, "yyyy-MM-dd HH:mm:ss").getTime();
}

function nextDate_(date, days) {
  var d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + days));
  return d.toISOString().slice(0, 10);
}

// FoxESS's time, e.g. "2026-10-23 17:00:27 BST+0100", in milliseconds.
function foxTime_(text) {
  var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}).*?([+-])(\d{2}):?(\d{2})$/.exec(String(text || ""));
  if (!m) {
    var plain = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.exec(String(text || ""));
    return plain ? Utilities.parseDate(plain[0], ZONE, "yyyy-MM-dd HH:mm:ss").getTime() : null;
  }
  var utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  var offset = (+m[8] * 60 + +m[9]) * 60000;
  return m[7] === "+" ? utc - offset : utc + offset;
}

function md5_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ("0" + (b & 255).toString(16)).slice(-2); }).join("");
}

// One FoxESS call, signed the way FoxESS's Open API asks: an MD5 of the path, the key
// and the time, joined by the literal characters backslash-r-backslash-n. Sent as a POST
// with a JSON body, or (method "get") as a GET with the query's fields in the address.
function call_(path, body, key, method, query) {
  if (READ_ONLY.indexOf(path) < 0) throw new Error("Refused: " + path + " isn't a reading call.");
  var get = method === "get", address = FOXESS + path;
  if (query) {
    address += "?" + Object.keys(query).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(query[k]); }).join("&");
  }
  for (var attempt = 0; ; attempt++) {
    spend_();
    var timestamp = String(Date.now());
    var signature = md5_(path + "\\r\\n" + key + "\\r\\n" + timestamp);
    var options = { method: get ? "get" : "post", headers: { token: key, timestamp: timestamp, signature: signature, lang: "en" },
                    muteHttpExceptions: true };
    if (!get) { options.contentType = "application/json"; options.payload = JSON.stringify(body || {}); }
    var response = UrlFetchApp.fetch(address, options);
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
    if (answer.errno === 40400 && attempt < 2) {                 // "too frequent": FoxESS allows one call a second
      Utilities.sleep(1500);
      continue;
    }
    if (answer.errno !== 0) throw new Error("FoxESS " + path + ": " + answer.errno + " " + (answer.msg || answer.message || ""));
    return answer.result;
  }
}
