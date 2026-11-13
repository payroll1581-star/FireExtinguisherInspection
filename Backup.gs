/**
 * Backup.gs — สำรองข้อมูลทั้งไฟล์ Google Sheet ลง Drive และกู้คืนจากเมนู
 *
 * - สำรองอัตโนมัติรายวัน (trigger ตี 2) + สำรองด้วยมือ + สำรองก่อนทำงานเสี่ยง (ย้ายประวัติเก่า/ล้างข้อมูลตัวอย่าง/กู้คืน)
 * - ตรวจสำเนาทุกครั้ง (เทียบจำนวนแถว) ถ้าไม่ตรงถือว่าล้มเหลวและลบสำเนานั้นทิ้ง
 * - เก็บรายวัน 30 วัน + สิ้นเดือน 12 เดือน ที่เกินย้ายเข้าถังขยะ (กู้ได้ 30 วัน) ไม่ลบถาวร
 * - ล้มเหลว → อีเมลหา ALERT_EMAILS; ไม่มีสำรองสำเร็จเกิน 48 ชม. → เตือนในอีเมลสรุปรายวัน
 * - ค่าลับ (TOKEN_SECRET, PIN_PEPPER) อยู่ใน Script Properties ไม่ได้อยู่ในสำเนา
 *   ถ้าย้ายไปโปรเจกต์ Apps Script ใหม่ ต้องตั้ง PIN ใหม่ให้ทุกคน (เมนู "ตั้ง PIN ใหม่")
 */

const BACKUP = {
  PREFIX: 'Backup_',
  NAME_RE: /^Backup_(\d{4}-\d{2}-\d{2})_(\d{4})$/,
  KEEP_DAILY: 30,
  KEEP_MONTHLY: 12,
  WARN_AFTER_MS: 48 * 60 * 60 * 1000,
  PROP_OK: 'BACKUP_LAST_OK',
  PROP_ERR: 'BACKUP_LAST_ERR',
  PROP_SINCE: 'BACKUP_SINCE',
};

/* ============================== Pure helpers (ทดสอบได้) ============================== */

/** 'Backup_2026-11-13_0200' → { ymd: '2026-11-13', hm: '0200' } หรือ null ถ้าไม่ใช่ชื่อที่ระบบสร้าง */
function parseBackupName_(name) {
  const m = String(name || '').match(BACKUP.NAME_RE);
  return m ? { ymd: m[1], hm: m[2] } : null;
}

function backupNameFor_(date) {
  const iso = isoTz_(date);
  return BACKUP.PREFIX + iso.slice(0, 10) + '_' + iso.slice(11, 13) + iso.slice(14, 16);
}

/**
 * คืนรายชื่อสำเนาที่ควรย้ายเข้าถังขยะ
 * เก็บ: สำเนาล่าสุดของแต่ละวัน ใน 30 วันล่าสุด + สำเนาล่าสุดของแต่ละเดือน ใน 12 เดือนล่าสุด
 * ชื่อที่ไม่ตรงรูปแบบ (ผู้ใช้สร้างเอง) ไม่ถูกแตะต้อง
 */
function planBackupRetention_(names) {
  const keep = {};
  const parsed = [];
  names.forEach(function (n) {
    const p = parseBackupName_(n);
    if (p) parsed.push({ name: n, day: p.ymd, key: p.ymd + p.hm }); else keep[n] = true;
  });
  parsed.sort(function (a, b) { return a.key < b.key ? 1 : (a.key > b.key ? -1 : 0); }); // ใหม่ → เก่า

  function newestPer(keyOf, limit) {
    const seen = {};
    const order = [];
    parsed.forEach(function (p) {
      const k = keyOf(p);
      if (!(k in seen)) { seen[k] = p; order.push(k); }
    });
    order.slice(0, limit).forEach(function (k) { keep[seen[k].name] = true; });
  }
  newestPer(function (p) { return p.day; }, BACKUP.KEEP_DAILY);
  newestPer(function (p) { return p.day.slice(0, 7); }, BACKUP.KEEP_MONTHLY);

  return names.filter(function (n) { return !keep[n]; });
}

/** ชีตที่กู้คืนได้ พร้อมจำนวนคอลัมน์ข้อมูล */
function restorableSheets_() {
  return [
    { name: APP.SHEETS.INSPECTIONS, width: INSPECTION_HEADERS.length },
    { name: APP.SHEETS.EQUIPMENT, width: EQUIPMENT_HEADERS.length },
    { name: APP.SHEETS.USERS, width: USER_HEADERS.length },
    { name: APP.SHEETS.CONFIG, width: CONFIG_HEADERS.length },
    { name: APP.SHEETS.CHECKLIST, width: CHECKLIST_HEADERS.length },
    { name: APP.SHEETS.ARCHIVE, width: INSPECTION_HEADERS.length },
  ];
}

/** 'ALL' หรือรายชื่อชีตคั่นจุลภาค (ไม่สนตัวพิมพ์) → รายการชีต; ชื่อที่ไม่รู้จักหรือว่าง → null */
function parseRestoreSheets_(text, available) {
  const s = str_(text);
  if (!s) return null;
  if (s.toUpperCase() === 'ALL') return available.slice();
  const out = [];
  const parts = s.split(/[,;]+/).map(function (x) { return x.trim().toLowerCase(); }).filter(String);
  if (!parts.length) return null;
  for (let i = 0; i < parts.length; i++) {
    const hit = available.filter(function (a) { return a.name.toLowerCase() === parts[i]; })[0];
    if (!hit) return null;
    if (out.indexOf(hit) === -1) out.push(hit);
  }
  return out;
}

/* ============================== Folder / status ============================== */

function getBackupFolder_() {
  const id = getConfig_().backupFolderId;
  if (!id) throw appError_('SETUP', 'ยังไม่ได้ตั้งค่าโฟลเดอร์สำรองข้อมูล กรุณากดเมนู "ติดตั้งระบบ"');
  return DriveApp.getFolderById(id);
}

function recordBackupOk_() {
  const p = PropertiesService.getScriptProperties();
  p.setProperty(BACKUP.PROP_OK, String(Date.now()));
  p.deleteProperty(BACKUP.PROP_ERR);
}

function recordBackupFail_(message) {
  PropertiesService.getScriptProperties().setProperty(BACKUP.PROP_ERR, String(message).slice(0, 300));
}

function markBackupStart_() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty(BACKUP.PROP_SINCE)) p.setProperty(BACKUP.PROP_SINCE, String(Date.now()));
}

/** ข้อความเตือนสำหรับอีเมลสรุปรายวัน (HTML) หรือ '' ถ้าปกติ */
function backupWarningHtml_() {
  const p = PropertiesService.getScriptProperties();
  const ok = Number(p.getProperty(BACKUP.PROP_OK) || 0);
  const since = Number(p.getProperty(BACKUP.PROP_SINCE) || 0);
  const ref = ok || since;
  if (!ref || Date.now() - ref < BACKUP.WARN_AFTER_MS) return '';
  const err = p.getProperty(BACKUP.PROP_ERR);
  return '<h3 style="color:#8E0000;margin:18px 0 6px">⚠️ ไม่มีการสำรองข้อมูลสำเร็จเกิน 48 ชั่วโมง</h3>' +
    '<p style="font-size:13px">' + (ok ? 'สำรองสำเร็จครั้งล่าสุด ' + escapeHtml_(fmtThaiDateTime_(new Date(ok))) : 'ยังไม่เคยสำรองสำเร็จ') +
    (err ? '<br>สาเหตุล่าสุด: ' + escapeHtml_(err) : '') +
    '<br>กดเมนู <b>💾 สำรองข้อมูลตอนนี้</b> ใน Google Sheet เพื่อลองใหม่</p>';
}

function notifyBackupFailed_(message) {
  try {
    sendMail_('[แจ้งเตือน] สำรองข้อมูลไม่สำเร็จ',
      emailShell_('⚠️ สำรองข้อมูลไม่สำเร็จ', '#C62828',
        '<p>' + escapeHtml_(message) + '</p><p>กดเมนู <b>💾 สำรองข้อมูลตอนนี้</b> ใน Google Sheet เพื่อลองใหม่</p>'));
  } catch (e) {
    console.error('notifyBackupFailed_ failed: ' + e);
  }
}

/* ============================== Create ============================== */

function lastRowOf_(ss, name) {
  const sh = ss.getSheetByName(name);
  return sh ? sh.getLastRow() : 0;
}

/** สร้างสำเนาทั้งไฟล์ + ตรวจสอบ + หมุนเวียน คืน { name, url, id, inspections } (throw เมื่อล้มเหลว) */
function createBackup_() {
  const lock = LockService.getScriptLock();
  // ถือ lock ระหว่างคัดลอก เพื่อไม่ให้มีผลตรวจถูกบันทึกกลางทาง (สำเนาจะตรงกันทุกชีต)
  if (!lock.tryLock(30000)) {
    const busy = 'ระบบกำลังบันทึกข้อมูลของผู้อื่น ลองสำรองใหม่อีกครั้ง';
    recordBackupFail_(busy);
    throw appError_('BUSY', busy);
  }
  let copy = null;
  try {
    const ss = getSS_();
    const folder = getBackupFolder_();
    SpreadsheetApp.flush();
    copy = DriveApp.getFileById(ss.getId()).makeCopy(backupNameFor_(new Date()), folder);

    const cs = SpreadsheetApp.openById(copy.getId());
    const checks = [APP.SHEETS.INSPECTIONS, APP.SHEETS.EQUIPMENT, APP.SHEETS.USERS, APP.SHEETS.ARCHIVE];
    checks.forEach(function (n) {
      const a = lastRowOf_(ss, n);
      const b = lastRowOf_(cs, n);
      if (a !== b) throw new Error('สำเนาไม่ตรงต้นฉบับที่ชีต ' + n + ' (ต้นฉบับ ' + a + ' แถว, สำเนา ' + b + ' แถว)');
    });

    recordBackupOk_();
    const result = { name: copy.getName(), url: copy.getUrl(), id: copy.getId(), inspections: Math.max(0, lastRowOf_(ss, APP.SHEETS.INSPECTIONS) - 1) };
    try { pruneBackups_(folder); } catch (e) { console.warn('pruneBackups_ failed: ' + e); }
    return result;
  } catch (err) {
    if (copy) { try { copy.setTrashed(true); } catch (e2) { /* ignore */ } }
    if (!(err && err.code === 'BUSY')) {
      const msg = err && err.message ? err.message : String(err);
      recordBackupFail_(msg);
      notifyBackupFailed_(msg);
    }
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function listBackups_() {
  const out = [];
  const it = getBackupFolder_().getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (parseBackupName_(f.getName())) out.push({ name: f.getName(), id: f.getId() });
  }
  out.sort(function (a, b) { return a.name < b.name ? 1 : (a.name > b.name ? -1 : 0); });
  return out;
}

function pruneBackups_(folder) {
  const files = {};
  const names = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    (files[f.getName()] = files[f.getName()] || []).push(f);
    names.push(f.getName());
  }
  planBackupRetention_(names).forEach(function (n) {
    (files[n] || []).forEach(function (f) { f.setTrashed(true); });
  });
}

/** Trigger รายวัน (ตี 2) */
function dailyBackup(e) {
  requireOwnerOrTrigger_(e);
  try {
    const r = createBackup_();
    return 'สำรองแล้ว: ' + r.name;
  } catch (err) {
    return 'สำรองไม่สำเร็จ: ' + (err && err.message ? err.message : err); // แจ้งอีเมลไปแล้วใน createBackup_
  }
}

/** ใช้ก่อนทำงานเสี่ยงจากเมนู: คืน true ถ้าสำรองสำเร็จ ไม่งั้นแจ้งผู้ใช้และคืน false */
function backupBeforeRisk_(ui) {
  try {
    createBackup_();
    return true;
  } catch (err) {
    ui.alert('หยุดการทำงาน', 'สำรองข้อมูลก่อนทำงานไม่สำเร็จ จึงยังไม่ดำเนินการต่อ\n\n' + (err && err.message ? err.message : err), ui.ButtonSet.OK);
    return false;
  }
}

/* ============================== Menu ============================== */

function menuBackupNow() {
  requireOwner_();
  const ui = SpreadsheetApp.getUi();
  try {
    const r = createBackup_();
    ui.alert('สำรองข้อมูลเรียบร้อย', r.name + '\nประวัติการตรวจ ' + r.inspections + ' แถว\n\n' + r.url, ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('สำรองข้อมูลไม่สำเร็จ', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

function restoreSheet_(cur, src, width) {
  const srcLast = src.getLastRow();
  const rows = srcLast >= 2 ? src.getRange(2, 1, srcLast - 1, width).getValues() : [];
  const curLast = cur.getLastRow();
  if (curLast >= 2) cur.getRange(2, 1, curLast - 1, width).clearContent();
  if (rows.length) cur.getRange(2, 1, rows.length, width).setValues(rows);
  return rows.length;
}

function menuRestore() {
  requireOwner_();
  const ui = SpreadsheetApp.getUi();
  let top;
  try { top = listBackups_().slice(0, 15); } catch (err) { return ui.alert(String(err.message || err)); }
  if (!top.length) return ui.alert('ยังไม่มีไฟล์สำรอง');

  const pickText = promptText_(ui, 'กู้คืนจากสำรอง (1/3)',
    'พิมพ์หมายเลขไฟล์สำรองที่ต้องการ (เลือกได้ 15 ชุดล่าสุด ไฟล์เก่ากว่านั้นเปิดดูใน Drive ได้):\n\n' +
    top.map(function (f, i) { return (i + 1) + ') ' + f.name; }).join('\n'));
  if (pickText === null) return;
  const pick = top[Number(pickText) - 1];
  if (!pick) return ui.alert('หมายเลขไม่ถูกต้อง');

  const avail = restorableSheets_();
  const sheetText = promptText_(ui, 'กู้คืนจากสำรอง (2/3)',
    'พิมพ์ชื่อชีตที่ต้องการกู้คืน คั่นด้วยจุลภาค หรือพิมพ์ ALL\n(กู้เฉพาะ ' + APP.SHEETS.INSPECTIONS + ' คือกรณีประวัติเสียหาย)\n\n' +
    avail.map(function (a) { return a.name; }).join(', '));
  if (sheetText === null) return;
  const chosen = parseRestoreSheets_(sheetText, avail);
  if (!chosen) return ui.alert('ชื่อชีตไม่ถูกต้อง');

  const src = SpreadsheetApp.openById(pick.id);
  const summary = chosen.map(function (a) {
    const sh = src.getSheetByName(a.name);
    return '• ' + a.name + ': ' + (sh ? Math.max(0, sh.getLastRow() - 1) + ' แถว' : 'ไม่มีในไฟล์สำรอง (จะข้าม)');
  }).join('\n');
  const ok = ui.alert('กู้คืนจากสำรอง (3/3)',
    'ไฟล์: ' + pick.name + '\n\nจะเขียนทับข้อมูลปัจจุบันด้วย:\n' + summary +
    '\n\nระบบจะสำรองสภาพปัจจุบันไว้อีกชุดก่อนเสมอ ดำเนินการต่อ?', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  if (!backupBeforeRisk_(ui)) return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return ui.alert('ระบบกำลังบันทึกข้อมูลของผู้อื่น กรุณาลองใหม่');
  const lines = [];
  try {
    const ss = getSS_();
    chosen.forEach(function (a) {
      const s = src.getSheetByName(a.name);
      if (!s) { lines.push('• ' + a.name + ': ข้าม (ไม่มีในไฟล์สำรอง)'); return; }
      let cur = ss.getSheetByName(a.name);
      if (!cur) {
        cur = ss.insertSheet(a.name);
        cur.getRange(1, 1, 1, a.width).setValues([s.getRange(1, 1, 1, a.width).getValues()[0]]);
      }
      lines.push('• ' + a.name + ': กู้คืน ' + restoreSheet_(cur, s, a.width) + ' แถว');
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().removeAll([APP.CACHE_CFG_KEY, APP.CACHE_USERS_KEY, APP.CACHE_DASH_KEY]);
  ui.alert('กู้คืนเรียบร้อย', lines.join('\n'), ui.ButtonSet.OK);
}
