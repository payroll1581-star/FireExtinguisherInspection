/**
 * Setup.gs — ติดตั้งระบบ, เมนูใน Google Sheet, ข้อมูลตัวอย่าง
 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🧯 ระบบถังดับเพลิง')
    .addItem('⚙️ ติดตั้งระบบ / อัปเดตโครงสร้าง', 'setup')
    .addSeparator()
    .addItem('👤 เพิ่มผู้ใช้', 'menuAddUser')
    .addItem('🔑 ตั้ง PIN ใหม่ / ปลดล็อก', 'menuResetPin')
    .addSeparator()
    .addItem('🖨️ เปิดหน้าพิมพ์ป้าย QR', 'menuOpenPrint')
    .addItem('📄 สร้างรายงานย้อนหลัง', 'menuReportForMonth')
    .addItem('🔔 ทดสอบส่งอีเมลสรุปรายวัน', 'menuTestDailyAlert')
    .addSeparator()
    .addItem('🧪 ใส่ข้อมูลตัวอย่าง', 'menuSeedDemo')
    .addItem('🗑️ ล้างข้อมูลตัวอย่าง', 'menuClearDemo')
    .addItem('✅ ทดสอบระบบ (runTests)', 'runTests')
    .addToUi();
}

function getUiOrNull_() {
  try { return SpreadsheetApp.getUi(); } catch (e) { return null; }
}

function setup() {
  requireOwner_();
  const props = PropertiesService.getScriptProperties();
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss && props.getProperty('SS_ID')) ss = SpreadsheetApp.openById(props.getProperty('SS_ID'));
  if (!ss) throw new Error('กรุณาสร้างสคริปต์จากเมนู Extensions > Apps Script ของ Google Sheet (สคริปต์ต้องผูกกับชีต)');
  props.setProperty('SS_ID', ss.getId());
  ss.setSpreadsheetTimeZone(APP.TZ);
  CacheService.getScriptCache().removeAll([APP.CACHE_CFG_KEY, APP.CACHE_USERS_KEY, APP.CACHE_DASH_KEY]);
  ensureSecrets_();

  const eq = ensureSheet_(ss, APP.SHEETS.EQUIPMENT, EQUIPMENT_HEADERS, [110, 120, 70, 200, 130, 90, 110, 110, 150, 170, 90]);
  const ins = ensureSheet_(ss, APP.SHEETS.INSPECTIONS, INSPECTION_HEADERS, [250, 150, 100, 90, 150, 90, 90, 220, 220, 220, 110, 200, 120, 150, 130, 200]);
  const users = ensureSheet_(ss, APP.SHEETS.USERS, USER_HEADERS, [90, 180, 100, 120, 200, 90, 150]);
  const cfg = ensureSheet_(ss, APP.SHEETS.CONFIG, CONFIG_HEADERS, [180, 320, 460]);
  const cl = ensureSheet_(ss, APP.SHEETS.CHECKLIST, CHECKLIST_HEADERS, [80, 180, 320, 260, 90]);

  // รูปแบบคอลัมน์: ข้อความล้วน (กันชีตแปลงค่าเอง เช่น "1/2" เป็นวันที่) และรูปแบบวันที่
  ['A', 'B', 'C', 'D', 'E', 'G'].forEach(function (c) { eq.getRange(c + '2:' + c).setNumberFormat('@'); });
  ['H', 'I', 'J'].forEach(function (c) { eq.getRange(c + '2:' + c).setNumberFormat('dd/mm/yyyy'); });
  ['A', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'L', 'M', 'O', 'P'].forEach(function (c) { ins.getRange(c + '2:' + c).setNumberFormat('@'); });
  ['B', 'N'].forEach(function (c) { ins.getRange(c + '2:' + c).setNumberFormat('dd/mm/yyyy hh:mm:ss'); });
  ['A', 'B', 'C', 'D', 'E'].forEach(function (c) { users.getRange(c + '2:' + c).setNumberFormat('@'); });
  users.getRange('G2:G').setNumberFormat('dd/mm/yyyy hh:mm');

  ensureConfigDefaults_(cfg);
  ensureChecklistDefaults_(cl);
  ensureFolders_(ss);
  applyValidations_(eq, users, cl);
  protectSheet_(ins, 'ประวัติการตรวจ — บันทึกผ่าน Web App เท่านั้น');
  protectSheet_(users, 'ข้อมูลผู้ใช้และ PIN hash — จัดการผ่านเมนูเท่านั้น');
  if (!users.isSheetHidden()) users.hideSheet();
  setupTriggers_();

  // ลบชีตว่างเริ่มต้น (Sheet1 / แผ่น1)
  ss.getSheets().forEach(function (sh) {
    const n = sh.getName();
    if ((n === 'Sheet1' || n === 'แผ่น1' || n === 'ชีต1') && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });

  const cache = CacheService.getScriptCache();
  cache.removeAll([APP.CACHE_CFG_KEY, APP.CACHE_USERS_KEY, APP.CACHE_DASH_KEY]);

  const ui = getUiOrNull_();
  const noMail = getConfig_().alertEmails.length ? '' : '⚠️ ยังไม่ได้ตั้ง ALERT_EMAILS — เมื่อพบถังชำรุดจะยังไม่มีใครได้รับอีเมล (ระบบจะเก็บไว้และส่งให้ทีหลังเมื่อตั้งค่าแล้ว)\n\n';
  const msg = noMail + 'ติดตั้งระบบเรียบร้อย\n\nขั้นตอนต่อไป:\n1) ใส่อีเมลผู้รับแจ้งเตือนใน Config → ALERT_EMAILS\n' +
    '2) เมนู "เพิ่มผู้ใช้" อย่างน้อย 1 คนที่เป็น Admin\n3) Deploy เป็น Web App แล้ววาง URL (/exec) ใน Config → WEBAPP_URL\n4) ใส่ข้อมูลถังในชีต Equipment';
  if (!ui) { console.log(msg); return msg; }
  const hasDemo = readRows_(APP.SHEETS.EQUIPMENT, 1).some(function (r) { return str_(r[0]).toUpperCase().indexOf(APP.DEMO_PREFIX) === 0; });
  if (!hasDemo && readRows_(APP.SHEETS.EQUIPMENT, 1).length === 0) {
    const ans = ui.alert('ติดตั้งระบบเรียบร้อย', msg + '\n\nต้องการใส่ข้อมูลตัวอย่าง (ถัง 10 ถัง, ผู้ใช้ทดสอบ 2 คน) เพื่อทดลองระบบหรือไม่?', ui.ButtonSet.YES_NO);
    if (ans === ui.Button.YES) seedDemo_(ui);
  } else {
    ui.alert('ติดตั้งระบบเรียบร้อย', msg, ui.ButtonSet.OK);
  }
  return msg;
}

function ensureSheet_(ss, name, headers, widths) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  // เติมเฉพาะหัวคอลัมน์ที่ว่าง (ชีตเก่าที่อัปเดตเวอร์ชันจะได้คอลัมน์ใหม่ โดยไม่ทับหัวเดิม)
  const current = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  if (current.some(function (v, i) { return v === '' && headers[i]; })) {
    sh.getRange(1, 1, 1, headers.length).setValues([current.map(function (v, i) { return v === '' ? headers[i] : v; })]);
  }
  sh.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold').setBackground('#C62828').setFontColor('#ffffff').setVerticalAlignment('middle');
  sh.setFrozenRows(1);
  sh.setRowHeight(1, 32);
  (widths || []).forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  return sh;
}

function ensureConfigDefaults_(sh) {
  const existing = {};
  readRows_(APP.SHEETS.CONFIG, 1).forEach(function (r) { existing[str_(r[0])] = true; });
  const missing = CONFIG_DEFAULTS.filter(function (r) { return !existing[r[0]]; });
  if (missing.length) sh.getRange(sh.getLastRow() + 1, 1, missing.length, 3).setValues(missing);
  sh.getRange('A2:A').setFontWeight('bold');
  sh.getRange('C2:C').setFontColor('#666666').setWrap(true);
}

function ensureChecklistDefaults_(sh) {
  if (sh.getLastRow() >= 2) return;
  sh.getRange(2, 1, CHECKLIST_DEFAULTS.length, CHECKLIST_HEADERS.length).setValues(CHECKLIST_DEFAULTS);
}

function ensureFolders_(ss) {
  const cfg = getConfig_();
  let parent = null;
  function getParent() {
    if (parent) return parent;
    const it = DriveApp.getFoldersByName('ระบบตรวจถังดับเพลิง (ไฟล์ระบบ)');
    parent = it.hasNext() ? it.next() : DriveApp.createFolder('ระบบตรวจถังดับเพลิง (ไฟล์ระบบ)');
    return parent;
  }
  function valid(id) {
    if (!id) return false;
    try { return !DriveApp.getFolderById(id).isTrashed(); } catch (e) { return false; }
  }
  if (!valid(cfg.photoFolderId)) setConfigValue_('PHOTO_FOLDER_ID', getParent().createFolder('รูปถังชำรุด').getId());
  if (!valid(cfg.reportFolderId)) setConfigValue_('REPORT_FOLDER_ID', getParent().createFolder('รายงานประจำเดือน').getId());
}

function applyValidations_(eq, users, cl) {
  const DV = SpreadsheetApp.newDataValidation;
  eq.getRange('A2:A').setDataValidation(DV()
    .requireFormulaSatisfied('=COUNTIF($A$2:$A,A2)<=1').setAllowInvalid(false)
    .setHelpText('รหัสถังต้องไม่ซ้ำ ใช้ตัวอักษรอังกฤษ ตัวเลข - หรือ _ เช่น FE-001').build());
  eq.getRange('E2:E').setDataValidation(DV().requireValueInList(EXTINGUISHER_TYPES, true).setAllowInvalid(false).build());
  eq.getRange('F2:F').setDataValidation(DV().requireNumberGreaterThan(0).setAllowInvalid(true)
    .setHelpText('ขนาดเป็นปอนด์ เช่น 10, 15, 20').build());
  eq.getRange('H2:J').setDataValidation(DV().requireDate().setAllowInvalid(false)
    .setHelpText('พิมพ์วันที่แบบ ค.ศ. ปี-เดือน-วัน เช่น 2026-12-31').build());
  eq.getRange('K2:K').setDataValidation(DV().requireCheckbox().build());
  users.getRange('C2:C').setDataValidation(DV().requireValueInList([ROLE.ADMIN, ROLE.INSPECTOR], true).setAllowInvalid(false).build());
  users.getRange('F2:F').setDataValidation(DV().requireCheckbox().build());
  cl.getRange('E2:E').setDataValidation(DV().requireCheckbox().build());
}

function protectSheet_(sh, description) {
  const existing = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  const p = existing.length ? existing[0] : sh.protect();
  p.setDescription(description);
  p.setWarningOnly(false);
  const me = Session.getEffectiveUser();
  p.addEditor(me);
  const others = p.getEditors().filter(function (u) { return u.getEmail() !== me.getEmail(); });
  if (others.length) p.removeEditors(others);
  if (p.canDomainEdit()) p.setDomainEdit(false);
}

function setupTriggers_() {
  const handlers = ['dailyAlert', 'monthlyReport', 'retryPendingAlerts'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  const hour = getConfig_().dailyAlertHour;
  ScriptApp.newTrigger('dailyAlert').timeBased().atHour(hour).everyDays(1).inTimezone(APP.TZ).create();
  ScriptApp.newTrigger('retryPendingAlerts').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('monthlyReport').timeBased().onMonthDay(1).atHour(7).inTimezone(APP.TZ).create();
}

function menuOpenPrint() {
  requireOwner_();
  const ui = SpreadsheetApp.getUi();
  const url = getWebAppUrl_();
  if (!url) return ui.alert('ยังไม่พบ URL ของ Web App\nกรุณา Deploy เป็น Web App แล้ววาง URL (/exec) ในชีต Config → WEBAPP_URL');
  const link = url + '?page=print';
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;line-height:1.6">' +
    '<p>เปิดหน้าพิมพ์ป้าย QR (ต้องเข้าสู่ระบบด้วยบัญชี Admin)</p>' +
    '<p><a href="' + escapeHtml_(link) + '" target="_blank" style="background:#C62828;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">🖨️ เปิดหน้าพิมพ์</a></p>' +
    '<p style="font-size:12px;color:#666;word-break:break-all">' + escapeHtml_(link) + '</p></div>')
    .setWidth(420).setHeight(200);
  ui.showModalDialog(html, 'พิมพ์ป้าย QR Code');
}

/* ============================== Demo data ============================== */

function menuSeedDemo() {
  requireOwner_();
  seedDemo_(SpreadsheetApp.getUi());
}

function menuClearDemo() {
  requireOwner_();
  const ui = SpreadsheetApp.getUi();
  const ans = ui.alert('ล้างข้อมูลตัวอย่าง', 'ลบถัง ผู้ใช้ และประวัติการตรวจที่ขึ้นต้นด้วย "' + APP.DEMO_PREFIX + '" ทั้งหมด?', ui.ButtonSet.YES_NO);
  if (ans !== ui.Button.YES) return;
  const n = clearDemo_();
  ui.alert('ลบข้อมูลตัวอย่างแล้ว: ถัง ' + n.equipment + ' · ประวัติ ' + n.inspections + ' · ผู้ใช้ ' + n.users);
}

function dateFromYmd_(ymd) {
  const p = ymd.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2]) - APP.TZ_OFFSET_MS);
}

function addDaysYmd_(ymd, days) {
  const p = ymd.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + days)).toISOString().slice(0, 10);
}

function seedDemo_(ui) {
  const exists = readRows_(APP.SHEETS.EQUIPMENT, 1).some(function (r) { return str_(r[0]).toUpperCase().indexOf(APP.DEMO_PREFIX) === 0; });
  if (exists) {
    if (ui) ui.alert('มีข้อมูลตัวอย่างอยู่แล้ว (กด "ล้างข้อมูลตัวอย่าง" ก่อนหากต้องการสร้างใหม่)');
    return;
  }
  const now = new Date();
  const today = ymd_(now);
  const d = function (days) { return dateFromYmd_(addDaysYmd_(today, days)); };
  const P = APP.DEMO_PREFIX;
  const equipment = [
    [P + '001', 'อาคาร A', '1', 'ข้างลิฟต์โถงกลาง', 'ผงเคมีแห้ง ABC', 15, 'Demo', d(-400), d(200), d(1500), true],
    [P + '002', 'อาคาร A', '1', 'ทางเข้าห้องประชุม', 'ผงเคมีแห้ง ABC', 15, 'Demo', d(-400), d(180), d(1500), true],
    [P + '003', 'อาคาร A', '2', 'หน้าห้องไฟฟ้า', 'CO2', 10, 'Demo', d(-700), d(-10), d(900), true],
    [P + '004', 'อาคาร A', '2', 'บันไดหนีไฟฝั่งตะวันออก', 'ผงเคมีแห้ง ABC', 20, 'Demo', d(-300), d(240), d(1600), true],
    [P + '005', 'อาคาร A', '3', 'ห้องเซิร์ฟเวอร์', 'สารสะอาด', 10, 'Demo', d(-200), d(300), d(1700), true],
    [P + '006', 'อาคาร B', '1', 'ครัว', 'โฟม', 20, 'Demo', d(-500), d(15), d(1200), true],
    [P + '007', 'อาคาร B', '1', 'ลานจอดรถ', 'ผงเคมีแห้ง ABC', 20, 'Demo', d(-600), d(120), d(1100), true],
    [P + '008', 'อาคาร B', '2', 'โถงทางเดิน', 'น้ำ', 15, 'Demo', d(-350), d(150), d(25), true],
    [P + '009', 'อาคาร B', '2', 'ห้องเก็บเอกสาร', 'CO2', 10, 'Demo', d(-250), d(260), d(1400), true],
    [P + '010', 'อาคาร B', '3', 'ดาดฟ้า', 'ผงเคมีแห้ง ABC', 15, 'Demo', d(-150), d(330), d(1800), true],
  ];
  const eqSh = sheet_(APP.SHEETS.EQUIPMENT);
  eqSh.getRange(eqSh.getLastRow() + 1, 1, equipment.length, EQUIPMENT_HEADERS.length).setValues(equipment);

  const pinAdmin = String(Math.floor(100000 + Math.random() * 900000));
  const pinInsp = String(Math.floor(100000 + Math.random() * 900000));
  addUser_('ผู้ดูแล (ตัวอย่าง)', ROLE.ADMIN, pinAdmin, P + 'ADMIN');
  addUser_('ผู้ตรวจ (ตัวอย่าง)', ROLE.INSPECTOR, pinInsp, P + 'INSP');

  // ประวัติการตรวจ: ปกติ 4 ถังเดือนนี้, ชำรุดค้างจากเดือนก่อน 1 ถัง, ตรวจผ่านเดือนก่อน 1 ถัง (→ รอการตรวจ)
  const checklist = getChecklist_();
  const thisMonthStart = dateFromYmd_(today.slice(0, 8) + '01');
  const lastMonth = function (days) { return new Date(thisMonthStart.getTime() - days * 86400000); };
  const recent = function (min) { return new Date(Math.max(now.getTime() - min * 60000, thisMonthStart.getTime() + 60000)); };
  const plan = [
    [P + '001', recent(50), {}], [P + '002', recent(45), {}], [P + '004', recent(30), {}], [P + '005', recent(20), {}],
    [P + '007', lastMonth(3), { C3: 'FAIL', C4: 'FAIL' }],
    [P + '008', lastMonth(5), {}],
  ];
  const eqType = {};
  equipment.forEach(function (r) { eqType[r[0]] = r[4]; });
  const rows = plan.map(function (pl) {
    const items = applicableItems_(checklist, eqType[pl[0]]);
    const results = {};
    const failed = [];
    items.forEach(function (it) {
      results[it.id] = pl[2][it.id] || 'PASS';
      if (results[it.id] === 'FAIL') failed.push(it.title);
    });
    return [Utilities.getUuid(), pl[1], pl[0], P + 'INSP', 'ผู้ตรวจ (ตัวอย่าง)', METHOD.QR,
      failed.length ? RESULT.FAIL : RESULT.PASS, failed.join(', '), JSON.stringify(results),
      failed.length ? 'ข้อมูลตัวอย่าง: สายฉีดกรอบ ตัวถังมีสนิม' : '', false, '', '', pl[1], failed.length ? ALERT.SENT : '', ''];
  });
  const insSh = sheet_(APP.SHEETS.INSPECTIONS);
  insSh.getRange(insSh.getLastRow() + 1, 1, rows.length, INSPECTION_HEADERS.length).setValues(rows);
  invalidateDashboard_();

  const msg = 'ใส่ข้อมูลตัวอย่างเรียบร้อย\n\nผู้ใช้ทดสอบ (จด PIN ไว้ — ระบบจะไม่แสดงอีก):\n' +
    '• ผู้ดูแล (ตัวอย่าง) — PIN ' + pinAdmin + '\n• ผู้ตรวจ (ตัวอย่าง) — PIN ' + pinInsp;
  if (ui) ui.alert('ข้อมูลตัวอย่าง', msg, ui.ButtonSet.OK);
  else console.log(msg);
}

function clearDemo_() {
  const P = APP.DEMO_PREFIX;
  function purge(sheetName, col) {
    const sh = sheet_(sheetName);
    const last = sh.getLastRow();
    if (last < 2) return 0;
    const vals = sh.getRange(2, col, last - 1, 1).getValues();
    let n = 0;
    for (let i = vals.length - 1; i >= 0; i--) {
      if (str_(vals[i][0]).toUpperCase().indexOf(P) === 0) { sh.deleteRow(i + 2); n++; }
    }
    return n;
  }
  const result = {
    inspections: purge(APP.SHEETS.INSPECTIONS, 3),
    equipment: purge(APP.SHEETS.EQUIPMENT, 1),
    users: purge(APP.SHEETS.USERS, 1),
  };
  invalidateUsers_();
  invalidateDashboard_();
  return result;
}
