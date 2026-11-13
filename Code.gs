/**
 * ระบบตรวจเช็คถังดับเพลิงออนไลน์ (Smart Fire Extinguisher Inspection System)
 * Code.gs — ค่าคงที่, doGet, การอ่านข้อมูลจากชีต และการคำนวณสถานะ
 *
 * หมายเหตุด้านความปลอดภัย: ฟังก์ชันระดับบนสุดที่ "ไม่" ลงท้ายด้วย _ จะถูกเรียกจาก
 * google.script.run ได้ ฟังก์ชันภายในทั้งหมดจึงลงท้ายด้วย _ และฟังก์ชันสาธารณะ
 * ที่ไม่ใช่ API (เมนู/trigger/setup) ต้องตรวจสิทธิ์เจ้าของก่อนทำงานเสมอ
 */

const APP = {
  TZ: 'Asia/Bangkok',
  TZ_OFFSET_MS: 7 * 60 * 60 * 1000, // ไทยไม่มี Daylight Saving จึงใช้ offset คงที่ได้
  SHEETS: {
    EQUIPMENT: 'Equipment',
    INSPECTIONS: 'Inspections',
    USERS: 'Users',
    CONFIG: 'Config',
    CHECKLIST: 'Checklist',
  },
  CACHE_DASH_KEY: 'dash_v1',
  CACHE_DASH_TTL: 30,
  CACHE_CFG_KEY: 'cfg_v1',
  CACHE_USERS_KEY: 'users_v1',
  DEMO_PREFIX: 'DEMO-',
  ID_PATTERN: /^[A-Z0-9][A-Z0-9_-]{0,39}$/,
  SESSION_HOURS: 12,
  MAX_PIN_FAILS: 5,
  LOCK_SECONDS: 15 * 60,
  PIN_HASH_ROUNDS: 300,
  MAX_REMARK_LEN: 500,
  MAX_PHOTO_B64_LEN: 4000000, // ~3 MB หลังถอดรหัส
  CLIENT_TIME_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
};

const RESULT = { PASS: 'ผ่าน', FAIL: 'ไม่ผ่าน' };
const METHOD = { QR: 'QR', MANUAL: 'MANUAL' };
const STATUS = { NORMAL: 'NORMAL', DAMAGED: 'DAMAGED', PENDING: 'PENDING' };
const EXPIRY = { OK: 'OK', SOON: 'SOON', EXPIRED: 'EXPIRED' };
const ROLE = { ADMIN: 'ADMIN', INSPECTOR: 'INSPECTOR' };

const EXTINGUISHER_TYPES = ['ผงเคมีแห้ง ABC', 'CO2', 'โฟม', 'น้ำ', 'สารสะอาด'];
const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

// ลำดับคอลัมน์ของแต่ละชีต (ห้ามสลับลำดับคอลัมน์ในชีต)
const EQUIPMENT_HEADERS = ['รหัส', 'อาคาร', 'ชั้น', 'จุดติดตั้ง', 'ชนิด', 'ขนาด (ปอนด์)', 'ยี่ห้อ',
  'วันที่ติดตั้ง', 'วันครบกำหนดบำรุงรักษา', 'วันหมดอายุ/ทดสอบแรงดัน', 'ใช้งานอยู่'];
const INSPECTION_HEADERS = ['รหัสการตรวจ', 'เวลาตรวจ', 'รหัสถัง', 'รหัสผู้ตรวจ', 'ชื่อผู้ตรวจ',
  'วิธีระบุถัง', 'ผลการตรวจ', 'ข้อที่ไม่ผ่าน', 'ผลรายข้อ (JSON)', 'หมายเหตุ', 'ซ่อม/เปลี่ยนแล้ว',
  'ลิงก์รูป', 'รหัสไฟล์รูป', 'รับข้อมูลเมื่อ', 'สถานะแจ้งเตือนอีเมล', 'เวลาจากเครื่อง (เมื่อถูกปรับ)'];
// คอลัมน์ O (สถานะแจ้งเตือน): ว่าง = ไม่ต้องแจ้ง, PENDING = รอส่ง/ส่งไม่สำเร็จ (ระบบลองส่งซ้ำทุกชั่วโมง), SENT = ส่งแล้ว
const ALERT = { PENDING: 'PENDING', SENT: 'SENT' };
const INS_COL = { ALERT: 15, CLIENT_TIME: 16 }; // เลขคอลัมน์ (เริ่มที่ 1)
const USER_HEADERS = ['รหัสผู้ใช้', 'ชื่อ', 'บทบาท', 'Salt', 'PIN Hash', 'ใช้งานอยู่', 'สร้างเมื่อ'];
const CHECKLIST_HEADERS = ['รหัสข้อ', 'รายการตรวจ', 'วิธีตรวจ', 'ใช้กับชนิด (ว่าง = ทุกชนิด)', 'ใช้งานอยู่'];
const CONFIG_HEADERS = ['Key', 'ค่า', 'คำอธิบาย'];

const CONFIG_DEFAULTS = [
  ['ORG_NAME', 'ระบบตรวจเช็คถังดับเพลิง', 'ชื่อหน่วยงาน/ระบบ ที่แสดงบนหน้าเว็บ อีเมล และรายงาน'],
  ['EXPIRY_WARN_DAYS', 30, 'เตือน "ใกล้หมดอายุ" เมื่อเหลือไม่เกินกี่วัน'],
  ['ALERT_EMAILS', '', 'อีเมลผู้รับแจ้งเตือนและรายงาน คั่นด้วยจุลภาค (,)'],
  ['DAILY_ALERT_HOUR', 8, 'ชั่วโมงที่ส่งอีเมลสรุปรายวัน (0–23) — แก้แล้วให้กดเมนู "ติดตั้งระบบ" อีกครั้ง'],
  ['WEBAPP_URL', '', 'URL ของ Web App ที่ลงท้ายด้วย /exec (ใช้สร้าง QR Code)'],
  ['SCANNER_URL', '', 'URL หน้าสแกนกล้องสด (GitHub Pages, https เท่านั้น) — เว้นว่างเพื่อไม่แสดงปุ่ม'],
  ['PHOTO_FOLDER_ID', '', 'โฟลเดอร์ Google Drive เก็บรูปถังชำรุด (ระบบสร้างให้อัตโนมัติ)'],
  ['REPORT_FOLDER_ID', '', 'โฟลเดอร์ Google Drive เก็บรายงาน PDF (ระบบสร้างให้อัตโนมัติ)'],
];

const CHECKLIST_DEFAULTS = [
  ['C1', 'เกจวัดความดัน', 'เข็มเกจอยู่ในโซนสีเขียว ไม่ต่ำหรือสูงเกิน', 'ผงเคมีแห้ง ABC, โฟม, น้ำ, สารสะอาด', true],
  ['C2', 'สลักและซีล', 'สลักนิรภัยเสียบอยู่ ซีลไม่ขาด', '', true],
  ['C3', 'สายฉีดและหัวฉีด', 'ไม่แตก ไม่กรอบ ไม่อุดตัน', '', true],
  ['C4', 'สภาพตัวถัง', 'ไม่บุบ ไม่เป็นสนิม ไม่มีรอยรั่ว', '', true],
  ['C5', 'ฉลากและป้ายวิธีใช้', 'ฉลากติดแน่น อ่านออกชัดเจน', '', true],
  ['C6', 'ตำแหน่งติดตั้ง', 'หยิบใช้สะดวก ไม่มีสิ่งกีดขวาง ความสูงถูกต้อง', '', true],
  ['C7', 'ป้ายสัญลักษณ์', 'มองเห็นป้ายบอกตำแหน่งถังได้ชัด', '', true],
];

/* ============================== Web App ============================== */

function doGet(e) {
  const params = (e && e.parameter) || {};
  let appName = 'ระบบตรวจเช็คถังดับเพลิง';
  let baseUrl = '';
  let scannerUrl = '';
  try {
    appName = getConfig_().orgName || appName;
    scannerUrl = getConfig_().scannerUrl || '';
    baseUrl = getWebAppUrl_();
  } catch (err) {
    return HtmlService.createHtmlOutput(
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<div style="font-family:sans-serif;padding:24px;line-height:1.6">' +
      '<h2>ยังไม่ได้ติดตั้งระบบ</h2><p>ผู้ดูแลต้องเปิด Google Sheet แล้วกดเมนู ' +
      '<b>🧯 ระบบถังดับเพลิง → ⚙️ ติดตั้งระบบ</b> ก่อน</p></div>')
      .setTitle('ตรวจถังดับเพลิง');
  }
  const t = HtmlService.createTemplateFromFile('Index');
  t.initialId = sanitizeIdParam_(params.id);
  t.initialView = params.page === 'print' ? 'print' : '';
  t.baseUrl = baseUrl;
  t.scannerUrl = scannerUrl;
  t.appName = appName;
  return t.evaluate()
    .setTitle('ตรวจถังดับเพลิง')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** ใช้ใน template: <?!= include('Styles'); ?> (อ่านได้เฉพาะไฟล์ HTML ซึ่งเป็นข้อมูลสาธารณะอยู่แล้ว) */
function include(name) {
  const allowed = ['Styles', 'App', 'Print', 'I18n'];
  if (allowed.indexOf(name) === -1) return '';
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function sanitizeIdParam_(v) {
  const id = normalizeId_(v);
  return APP.ID_PATTERN.test(id) ? id : '';
}

function getWebAppUrl_() {
  const cfg = getConfig_();
  if (cfg.webAppUrl) return cfg.webAppUrl;
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

/* ============================== Errors ============================== */

/** ข้อผิดพลาดที่แสดงข้อความให้ผู้ใช้เห็นได้ (ไม่รั่ว stack trace) */
function appError_(code, message) {
  const err = new Error(message);
  err.code = code;
  err.isAppError = true;
  return err;
}

/* ============================== Spreadsheet ============================== */

function getSS_() {
  const id = PropertiesService.getScriptProperties().getProperty('SS_ID');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw appError_('SETUP', 'ยังไม่ได้ติดตั้งระบบ กรุณากดเมนู "ติดตั้งระบบ" ใน Google Sheet');
  return ss;
}

function sheet_(name) {
  const sh = getSS_().getSheetByName(name);
  if (!sh) throw appError_('SETUP', 'ไม่พบชีต "' + name + '" กรุณากดเมนู "ติดตั้งระบบ"');
  return sh;
}

function readRows_(name, width) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, width).getValues();
}

function str_(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function bool_(v) {
  return v === true || String(v).trim().toUpperCase() === 'TRUE';
}

function normalizeId_(v) {
  return str_(v).toUpperCase();
}

/*
 * กัน Formula Injection: คอลัมน์ข้อความที่ผู้ใช้กรอก (ชื่อ, ข้อที่ไม่ผ่าน, หมายเหตุ) ถูกตั้งรูปแบบเป็น
 * "ข้อความล้วน" (@) ใน Setup.gs ชีตจึงไม่ตีความเป็นสูตร และไม่ต้องเติม ' นำหน้า
 * (การเติม ' ในเซลล์ข้อความล้วนจะกลายเป็นตัวอักษรจริงที่ผู้ใช้เห็น)
 * ถ้าเพิ่มคอลัมน์ข้อความใหม่ ต้องเพิ่มใน setNumberFormat('@') ของ setup() ด้วย
 */

function cleanText_(v, maxLen) {
  return str_(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, maxLen);
}

/* ============================== Config ============================== */

function getConfig_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(APP.CACHE_CFG_KEY);
  if (cached) return JSON.parse(cached);
  const map = {};
  readRows_(APP.SHEETS.CONFIG, 2).forEach(function (r) {
    const k = str_(r[0]);
    if (k) map[k] = r[1];
  });
  const warn = Number(map.EXPIRY_WARN_DAYS);
  const hour = Number(map.DAILY_ALERT_HOUR);
  const cfg = {
    orgName: str_(map.ORG_NAME) || 'ระบบตรวจเช็คถังดับเพลิง',
    warnDays: isFinite(warn) && warn >= 0 ? Math.floor(warn) : 30,
    alertEmails: parseEmails_(map.ALERT_EMAILS),
    dailyAlertHour: isFinite(hour) && hour >= 0 && hour <= 23 ? Math.floor(hour) : 8,
    webAppUrl: /^https:\/\/script\.google\.com\//.test(str_(map.WEBAPP_URL)) ? str_(map.WEBAPP_URL) : '',
    scannerUrl: /^https:\/\/[\w.-]+\.github\.io\/[^\s"'<>]*$/.test(str_(map.SCANNER_URL)) ? str_(map.SCANNER_URL) : '',
    photoFolderId: str_(map.PHOTO_FOLDER_ID),
    reportFolderId: str_(map.REPORT_FOLDER_ID),
  };
  cache.put(APP.CACHE_CFG_KEY, JSON.stringify(cfg), 60);
  return cfg;
}

function parseEmails_(v) {
  return str_(v).split(/[,;\s]+/).map(function (s) { return s.trim(); })
    .filter(function (s) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s); });
}

function setConfigValue_(key, value) {
  const sh = sheet_(APP.SHEETS.CONFIG);
  const rows = readRows_(APP.SHEETS.CONFIG, 1);
  for (let i = 0; i < rows.length; i++) {
    if (str_(rows[i][0]) === key) {
      sh.getRange(i + 2, 2).setValue(value);
      CacheService.getScriptCache().remove(APP.CACHE_CFG_KEY);
      return;
    }
  }
  sh.appendRow([key, value, '']);
  CacheService.getScriptCache().remove(APP.CACHE_CFG_KEY);
}

function getChecklist_() {
  return readRows_(APP.SHEETS.CHECKLIST, CHECKLIST_HEADERS.length)
    .filter(function (r) { return str_(r[0]) && str_(r[1]) && bool_(r[4]); })
    .map(function (r) {
      return {
        id: str_(r[0]).toUpperCase(),
        title: str_(r[1]),
        how: str_(r[2]),
        appliesTo: str_(r[3]).split(',').map(function (s) { return s.trim(); }).filter(String),
      };
    });
}

/** รายการตรวจที่ใช้กับชนิดถังนี้ (เช่น ถัง CO2 ไม่มีเกจความดัน) */
function applicableItems_(checklist, type) {
  return checklist.filter(function (it) {
    return !it.appliesTo.length || it.appliesTo.indexOf(type) !== -1;
  });
}

/* ============================== Data loading ============================== */

function loadEquipment_(includeInactive) {
  return readRows_(APP.SHEETS.EQUIPMENT, EQUIPMENT_HEADERS.length).map(function (r, i) {
    return {
      row: i + 2,
      id: normalizeId_(r[0]),
      building: str_(r[1]),
      floor: str_(r[2]),
      location: str_(r[3]),
      type: str_(r[4]),
      size: str_(r[5]),
      brand: str_(r[6]),
      installDate: toYmd_(r[7]),
      serviceDate: toYmd_(r[8]),
      expiryDate: toYmd_(r[9]),
      active: bool_(r[10]),
    };
  }).filter(function (e) { return e.id && (includeInactive || e.active); });
}

function loadInspections_() {
  return readRows_(APP.SHEETS.INSPECTIONS, INSPECTION_HEADERS.length).map(function (r) {
    const time = isDate_(r[1]) ? r[1] : new Date(r[1]);
    return {
      id: str_(r[0]),
      time: time,
      equipmentId: normalizeId_(r[2]),
      inspectorId: str_(r[3]),
      inspectorName: str_(r[4]),
      method: str_(r[5]) === METHOD.MANUAL ? METHOD.MANUAL : METHOD.QR,
      result: str_(r[6]) === RESULT.FAIL ? 'FAIL' : 'PASS',
      failedItems: str_(r[7]),
      remarks: str_(r[9]),
      repaired: bool_(r[10]),
      photoUrl: str_(r[11]),
      photoId: str_(r[12]),
      alertStatus: str_(r[INS_COL.ALERT - 1]),
    };
  }).filter(function (x) { return x.equipmentId && !isNaN(x.time.getTime()); });
}

/* ============================== Date helpers (Asia/Bangkok) ============================== */

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

/** 'yyyy-MM-dd' ตามเวลาไทย */
function ymd_(date) {
  return new Date(date.getTime() + APP.TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'yyyy-MM' ตามเวลาไทย */
function ym_(date) {
  return ymd_(date).slice(0, 7);
}

/** ISO 8601 พร้อม offset +07:00 (google.script.run ส่ง Date object ไม่ได้ จึงส่งเป็นข้อความ) */
function isoTz_(date) {
  return new Date(date.getTime() + APP.TZ_OFFSET_MS).toISOString().slice(0, 19) + '+07:00';
}

/** แปลงค่าในเซลล์วันที่เป็น 'yyyy-MM-dd' รองรับ Date, yyyy-mm-dd และ dd/mm/yyyy (ปี พ.ศ. จะถูกแปลงเป็น ค.ศ.) */
function toYmd_(v) {
  if (isDate_(v)) return isNaN(v.getTime()) ? '' : ymd_(v);
  const s = str_(v);
  if (!s) return '';
  let y, m, d, mt;
  if ((mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) { d = +mt[1]; m = +mt[2]; y = +mt[3]; }
  else return '';
  if (y > 2400) y -= 543;
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  return y + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2);
}

/** จำนวนวันจาก a ถึง b (ทั้งคู่เป็น 'yyyy-MM-dd') */
function daysBetween_(a, b) {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

/** วันที่แบบไทย dd/MM/yyyy (พ.ศ.) จาก 'yyyy-MM-dd' */
function fmtThaiDate_(ymd) {
  if (!ymd) return '-';
  const p = ymd.split('-');
  return p[2] + '/' + p[1] + '/' + (Number(p[0]) + 543);
}

function fmtThaiDateTime_(date) {
  const iso = isoTz_(date);
  return fmtThaiDate_(iso.slice(0, 10)) + ' ' + iso.slice(11, 16) + ' น.';
}

/** เวลาเริ่มต้นของเดือน (ตามเวลาไทย) month = 1..12 */
function monthStart_(year, month) {
  return new Date(Date.UTC(year, month - 1, 1) - APP.TZ_OFFSET_MS);
}

/* ============================== Status logic ============================== */

/**
 * สถานะหลัก: ชำรุด > รอการตรวจ > ปกติ
 * - ผลตรวจล่าสุด "ไม่ผ่าน" = ชำรุด (คงสถานะข้ามเดือนจนกว่าจะตรวจผ่าน)
 * - ผลตรวจล่าสุด "ผ่าน" ในเดือนอ้างอิง = ปกติ
 * - อื่น ๆ = รอการตรวจ
 */
function computeStatus_(last, refYm) {
  if (!last) return STATUS.PENDING;
  if (last.result === 'FAIL') return STATUS.DAMAGED;
  return ym_(last.time) === refYm ? STATUS.NORMAL : STATUS.PENDING;
}

/** ป้ายวันหมดอายุ (แยกจากสถานะหลัก) */
function computeExpiry_(eq, refYmd, warnDays) {
  const details = [];
  if (eq.serviceDate) details.push({ kind: 'service', date: eq.serviceDate, daysLeft: daysBetween_(refYmd, eq.serviceDate) });
  if (eq.expiryDate) details.push({ kind: 'expiry', date: eq.expiryDate, daysLeft: daysBetween_(refYmd, eq.expiryDate) });
  let minDays = null;
  details.forEach(function (d) { if (minDays === null || d.daysLeft < minDays) minDays = d.daysLeft; });
  let flag = EXPIRY.OK;
  if (minDays !== null) {
    if (minDays < 0) flag = EXPIRY.EXPIRED;
    else if (minDays <= warnDays) flag = EXPIRY.SOON;
  }
  return { flag: flag, details: details, minDays: minDays };
}

/** สร้างภาพรวมสถานะทุกถัง ณ เวลาอ้างอิง (ใช้ทั้ง Dashboard, อีเมล และรายงานย้อนหลัง) */
function buildSnapshot_(equipment, inspections, refDate, warnDays) {
  const refMs = refDate.getTime();
  const refYm = ym_(refDate);
  const refYmd = ymd_(refDate);
  const latest = {};
  const monthCount = {};
  inspections.forEach(function (ins) {
    const t = ins.time.getTime();
    if (t > refMs) return;
    const cur = latest[ins.equipmentId];
    if (!cur || t >= cur.time.getTime()) latest[ins.equipmentId] = ins;
    if (ym_(ins.time) === refYm) monthCount[ins.equipmentId] = (monthCount[ins.equipmentId] || 0) + 1;
  });
  return equipment.map(function (eq) {
    const last = latest[eq.id] || null;
    const exp = computeExpiry_(eq, refYmd, warnDays);
    return {
      id: eq.id,
      building: eq.building,
      floor: eq.floor,
      location: eq.location,
      type: eq.type,
      size: eq.size,
      brand: eq.brand,
      serviceDate: eq.serviceDate,
      expiryDate: eq.expiryDate,
      status: computeStatus_(last, refYm),
      expiry: exp.flag,
      expiryDetails: exp.details,
      minDaysLeft: exp.minDays,
      inspectedThisMonth: !!monthCount[eq.id],
      monthCount: monthCount[eq.id] || 0,
      last: last ? {
        time: isoTz_(last.time),
        by: last.inspectorName,
        result: last.result,
        method: last.method,
        repaired: last.repaired,
        failedItems: last.failedItems,
      } : null,
    };
  });
}

function summarize_(items) {
  const s = { total: items.length, normal: 0, damaged: 0, pending: 0, expired: 0, soon: 0, inspected: 0 };
  items.forEach(function (it) {
    if (it.status === STATUS.NORMAL) s.normal++;
    else if (it.status === STATUS.DAMAGED) s.damaged++;
    else s.pending++;
    if (it.expiry === EXPIRY.EXPIRED) s.expired++;
    else if (it.expiry === EXPIRY.SOON) s.soon++;
    if (it.inspectedThisMonth) s.inspected++;
  });
  s.progressPct = s.total ? Math.round((s.inspected / s.total) * 100) : 0;
  return s;
}

/** สถิติรายผู้ตรวจ (ใช้ตรวจจับการพิมพ์รหัสเองบ่อยผิดปกติ) */
function buildInspectorStats_(inspections) {
  const map = {};
  inspections.forEach(function (ins) {
    const k = ins.inspectorId || ins.inspectorName;
    if (!map[k]) map[k] = { id: ins.inspectorId, name: ins.inspectorName, count: 0, manual: 0, fail: 0, tanks: {} };
    const m = map[k];
    m.count++;
    if (ins.method === METHOD.MANUAL) m.manual++;
    if (ins.result === 'FAIL') m.fail++;
    m.tanks[ins.equipmentId] = true;
  });
  return Object.keys(map).map(function (k) {
    const m = map[k];
    return {
      id: m.id, name: m.name, count: m.count, manual: m.manual, fail: m.fail,
      tanks: Object.keys(m.tanks).length,
      manualPct: m.count ? Math.round((m.manual / m.count) * 100) : 0,
    };
  }).sort(function (a, b) { return b.count - a.count; });
}

/** ข้อมูล Dashboard (cache 30 วินาที และล้าง cache ทันทีเมื่อมีการบันทึกผลตรวจ) */
function getDashboardData_(skipCache) {
  if (!skipCache) {
    const cached = cacheGetJson_(APP.CACHE_DASH_KEY);
    if (cached) return cached;
  }
  const cfg = getConfig_();
  const now = new Date();
  const equipment = loadEquipment_(false);
  const inspections = loadInspections_();
  const items = buildSnapshot_(equipment, inspections, now, cfg.warnDays);
  const month = ym_(now);
  const data = {
    generatedAt: isoTz_(now),
    month: month,
    warnDays: cfg.warnDays,
    items: items,
    summary: summarize_(items),
    inspectorStats: buildInspectorStats_(inspections.filter(function (i) { return ym_(i.time) === month; })),
  };
  cachePutJson_(APP.CACHE_DASH_KEY, data, APP.CACHE_DASH_TTL);
  return data;
}

function invalidateDashboard_() {
  CacheService.getScriptCache().remove(APP.CACHE_DASH_KEY);
}

/* ============================== Cache (รองรับข้อมูลเกิน 100KB) ============================== */

function cachePutJson_(key, obj, ttl) {
  try {
    const s = JSON.stringify(obj);
    const size = 25000; // ตัวอักษรไทยใช้ 3 ไบต์ใน UTF-8 จึงแบ่งชิ้นละ 25,000 ตัวอักษร (< 100KB)
    const n = Math.ceil(s.length / size) || 1;
    const map = {};
    for (let i = 0; i < n; i++) map[key + '_' + i] = s.substr(i * size, size);
    map[key] = String(n);
    CacheService.getScriptCache().putAll(map, ttl);
  } catch (e) {
    console.warn('cachePutJson_ failed: ' + e);
  }
}

function cacheGetJson_(key) {
  try {
    const cache = CacheService.getScriptCache();
    const n = Number(cache.get(key));
    if (!n) return null;
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(key + '_' + i);
    const parts = cache.getAll(keys);
    let s = '';
    for (let i = 0; i < n; i++) {
      if (parts[keys[i]] === undefined) return null;
      s += parts[keys[i]];
    }
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}
