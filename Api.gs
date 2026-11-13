/**
 * Api.gs — จุดเข้าเดียวของ google.script.run: api(action, token, payload)
 * คืนค่า { ok: true, data } หรือ { ok: false, code, error } เสมอ (ไม่ throw ออกไปฝั่ง client)
 */

function getRoutes_() {
  return {
    listUsers:        { auth: false, fn: function () { return listUsersPublic_(); } },
    login:            { auth: false, fn: function (u, p) { return login_(p); } },
    bootstrap:        { role: ROLE.INSPECTOR, fn: apiBootstrap_ },
    getEquipment:     { role: ROLE.INSPECTOR, fn: apiGetEquipment_ },
    submitInspection: { role: ROLE.INSPECTOR, fn: apiSubmitInspection_ },
    getDashboard:     { role: ROLE.INSPECTOR, fn: apiGetDashboard_ },
    getHistory:       { role: ROLE.INSPECTOR, fn: apiGetHistory_ },
    getInspectionLog: { role: ROLE.ADMIN, fn: apiGetInspectionLog_ },
    getPhoto:         { role: ROLE.ADMIN, fn: apiGetPhoto_ },
    getPrintData:     { role: ROLE.ADMIN, fn: apiGetPrintData_ },
  };
}

function api(action, token, payload) {
  try {
    const routes = getRoutes_();
    const route = Object.prototype.hasOwnProperty.call(routes, action) ? routes[action] : null;
    if (!route) return { ok: false, code: 'NOT_FOUND', error: 'ไม่รู้จักคำสั่งนี้' };
    const p = payload && typeof payload === 'object' ? payload : {};
    let user = null;
    if (route.auth !== false) {
      user = verifyToken_(token);
      if (!user) return { ok: false, code: 'AUTH', error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' };
      if (route.role === ROLE.ADMIN && user.role !== ROLE.ADMIN) {
        return { ok: false, code: 'FORBIDDEN', error: 'เมนูนี้สำหรับผู้ดูแลระบบเท่านั้น' };
      }
    }
    return { ok: true, data: route.fn(user, p) };
  } catch (err) {
    if (err && err.isAppError) return { ok: false, code: err.code, error: err.message };
    console.error('api(' + action + ') failed: ' + (err && err.stack ? err.stack : err));
    return { ok: false, code: 'ERROR', error: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง' };
  }
}

/* ============================== Handlers ============================== */

function apiBootstrap_(user) {
  const cfg = getConfig_();
  const dash = getDashboardData_();
  return {
    me: user,
    config: { orgName: cfg.orgName, warnDays: cfg.warnDays, baseUrl: getWebAppUrl_() },
    checklist: getChecklist_(),
    equipment: dash.items,
    generatedAt: dash.generatedAt,
  };
}

function requireEquipmentId_(v) {
  const id = normalizeId_(v);
  if (!APP.ID_PATTERN.test(id)) throw appError_('VALIDATION', 'รหัสถังไม่ถูกต้อง');
  return id;
}

function apiGetEquipment_(user, p) {
  const id = requireEquipmentId_(p.id);
  const item = getDashboardData_().items.filter(function (x) { return x.id === id; })[0];
  if (!item) throw appError_('NOT_FOUND', 'ไม่พบรหัสถัง ' + id + ' ในระบบ (หรือถูกปลดระวางแล้ว)');
  return { item: item, checklist: applicableItems_(getChecklist_(), item.type) };
}

function apiSubmitInspection_(user, p) {
  const uuid = str_(p.uuid).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
    throw appError_('VALIDATION', 'ข้อมูลไม่ถูกต้อง (uuid)');
  }
  const id = requireEquipmentId_(p.equipmentId);
  const method = p.method === METHOD.QR ? METHOD.QR : METHOD.MANUAL;
  const eq = loadEquipment_(false).filter(function (e) { return e.id === id; })[0];
  if (!eq) throw appError_('NOT_FOUND', 'ไม่พบรหัสถัง ' + id + ' ในระบบ');

  // คำนวณผลฝั่ง server เสมอ ไม่เชื่อผลรวมจาก client
  const items = applicableItems_(getChecklist_(), eq.type);
  if (!items.length) throw appError_('SETUP', 'ยังไม่มีรายการตรวจสำหรับถังชนิดนี้ (ชีต Checklist)');
  const answers = p.answers && typeof p.answers === 'object' ? p.answers : {};
  const results = {};
  const failed = [];
  items.forEach(function (it) {
    const v = answers[it.id];
    if (v !== 'PASS' && v !== 'FAIL') throw appError_('VALIDATION', 'กรุณาตอบรายการตรวจให้ครบทุกข้อ');
    results[it.id] = v;
    if (v === 'FAIL') failed.push(it.title);
  });
  const isFail = failed.length > 0;
  const remarks = cleanText_(p.remarks, APP.MAX_REMARK_LEN);
  const repaired = p.repaired === true;
  const now = new Date();
  const inspectedAt = clampClientTime_(p.clientTime, now);
  // ถ้าเวลาจากเครื่องถูกปรับเป็นเวลา server ให้เก็บค่าดิบไว้ตรวจสอบย้อนหลัง
  const rawClientTime = inspectedAt === now ? cleanText_(p.clientTime, 40) : '';

  let photoBlob = null;
  if (isFail) {
    if (!p.photo) throw appError_('VALIDATION', 'กรุณาถ่ายรูปจุดที่ชำรุดก่อนบันทึก');
    photoBlob = decodePhoto_(p.photo, id, inspectedAt);
  }

  const sh = sheet_(APP.SHEETS.INSPECTIONS);
  if (findInspectionRow_(sh, uuid)) return { saved: true, duplicate: true, status: isFail ? STATUS.DAMAGED : STATUS.NORMAL };

  // อัปโหลดรูปก่อนถือ lock เพื่อไม่ให้ผู้ตรวจคนอื่นต้องรอ
  let photoFile = null;
  if (photoBlob) photoFile = getPhotoFolder_().createFile(photoBlob);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    if (photoFile) photoFile.setTrashed(true);
    throw appError_('BUSY', 'ระบบกำลังบันทึกข้อมูลของผู้อื่น กรุณาลองใหม่');
  }
  try {
    if (findInspectionRow_(sh, uuid)) {
      if (photoFile) photoFile.setTrashed(true);
      return { saved: true, duplicate: true, status: isFail ? STATUS.DAMAGED : STATUS.NORMAL };
    }
    try {
      sh.appendRow([
        uuid, inspectedAt, id, user.id, user.name, method,
        isFail ? RESULT.FAIL : RESULT.PASS,
        failed.join(', '), JSON.stringify(results), remarks, repaired,
        photoFile ? photoFile.getUrl() : '', photoFile ? photoFile.getId() : '', now,
        isFail ? ALERT.PENDING : '', rawClientTime,
      ]);
      SpreadsheetApp.flush();
    } catch (err) {
      // บันทึกไม่สำเร็จ → ไม่ทิ้งรูปค้างใน Drive (client จะส่งใหม่ด้วย uuid เดิม)
      if (photoFile) { try { photoFile.setTrashed(true); } catch (e2) { /* ignore */ } }
      throw err;
    }
    invalidateDashboard_();
  } finally {
    lock.releaseLock();
  }

  let alertState = '';
  if (isFail) {
    alertState = sendDamagedAlert_(uuid, {
      equipment: eq, inspector: user.name, time: inspectedAt, failed: failed,
      remarks: remarks, method: method, photoBlob: photoBlob,
    });
  }

  const status = isFail ? STATUS.DAMAGED : (ym_(inspectedAt) === ym_(now) ? STATUS.NORMAL : STATUS.PENDING);
  return { saved: true, duplicate: false, status: status, time: isoTz_(inspectedAt), alert: alertState };
}

function findInspectionRow_(sh, uuid) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const cell = sh.getRange(2, 1, last - 1, 1).createTextFinder(uuid).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : 0;
}

/** เวลาตรวจจากเครื่อง (สำคัญกับคิวออฟไลน์) ยอมรับได้ไม่เกิน 7 วันย้อนหลังและไม่เกินอนาคต 5 นาที */
function clampClientTime_(v, now) {
  const d = new Date(v);
  if (!v || isNaN(d.getTime())) return now;
  if (d.getTime() > now.getTime() + 5 * 60 * 1000) return now;
  if (d.getTime() < now.getTime() - APP.CLIENT_TIME_MAX_AGE_MS) return now;
  return d;
}

function decodePhoto_(dataUrl, equipmentId, time) {
  const s = String(dataUrl || '');
  if (s.length > APP.MAX_PHOTO_B64_LEN) throw appError_('VALIDATION', 'รูปมีขนาดใหญ่เกินไป');
  const m = s.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw appError_('VALIDATION', 'รูปแบบไฟล์รูปไม่ถูกต้อง (ต้องเป็น JPEG)');
  const bytes = Utilities.base64Decode(m[1]);
  // ตรวจ magic bytes ของ JPEG (FF D8) — ค่า byte ใน Apps Script เป็นแบบมีเครื่องหมาย
  if (bytes.length < 4 || (bytes[0] & 0xff) !== 0xff || (bytes[1] & 0xff) !== 0xd8) {
    throw appError_('VALIDATION', 'ไฟล์รูปไม่ใช่ JPEG');
  }
  const stamp = isoTz_(time).slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
  return Utilities.newBlob(bytes, 'image/jpeg', equipmentId + '_' + stamp + '.jpg');
}

function getPhotoFolder_() {
  const id = getConfig_().photoFolderId;
  if (!id) throw appError_('SETUP', 'ยังไม่ได้ตั้งค่าโฟลเดอร์รูป กรุณากดเมนู "ติดตั้งระบบ"');
  return DriveApp.getFolderById(id);
}

function apiGetDashboard_(user) {
  const d = getDashboardData_();
  const out = {
    generatedAt: d.generatedAt, month: d.month, warnDays: d.warnDays,
    items: d.items, summary: d.summary,
  };
  if (user.role === ROLE.ADMIN) out.inspectorStats = d.inspectorStats;
  return out;
}

function inspectionView_(ins, isAdmin, eqMap) {
  const eq = eqMap ? eqMap[ins.equipmentId] : null;
  return {
    id: ins.id,
    time: isoTz_(ins.time),
    equipmentId: ins.equipmentId,
    location: eq ? [eq.building, eq.floor ? 'ชั้น ' + eq.floor : '', eq.location].filter(String).join(' · ') : '',
    by: ins.inspectorName,
    method: ins.method,
    result: ins.result,
    failedItems: ins.failedItems,
    remarks: ins.remarks,
    repaired: ins.repaired,
    hasPhoto: !!ins.photoId,
    photoId: isAdmin ? ins.photoId : '',
  };
}

function apiGetHistory_(user, p) {
  const id = requireEquipmentId_(p.id);
  const isAdmin = user.role === ROLE.ADMIN;
  return loadInspections_()
    .filter(function (x) { return x.equipmentId === id; })
    .sort(function (a, b) { return b.time - a.time; })
    .slice(0, 24)
    .map(function (x) { return inspectionView_(x, isAdmin, null); });
}

function apiGetInspectionLog_(user, p) {
  const ym = /^\d{4}-\d{2}$/.test(str_(p.ym)) ? str_(p.ym) : ym_(new Date());
  const eqMap = {};
  loadEquipment_(true).forEach(function (e) { eqMap[e.id] = e; });
  const rows = loadInspections_()
    .filter(function (x) { return ym_(x.time) === ym; })
    .sort(function (a, b) { return b.time - a.time; });
  return {
    ym: ym,
    total: rows.length,
    rows: rows.slice(0, 1000).map(function (x) { return inspectionView_(x, true, eqMap); }),
  };
}

function apiGetPhoto_(user, p) {
  const photoId = str_(p.photoId);
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(photoId)) throw appError_('VALIDATION', 'รหัสรูปไม่ถูกต้อง');
  // อนุญาตเฉพาะไฟล์ที่ถูกอ้างอิงในชีต Inspections เท่านั้น (กันการอ่านไฟล์อื่นใน Drive ของเจ้าของ)
  // ค้นทั้งชีตหลักและชีตเก็บถาวร (ประวัติเก่าที่ย้ายออกไปแล้วยังเปิดดูรูปได้)
  const found = [APP.SHEETS.INSPECTIONS, APP.SHEETS.ARCHIVE].some(function (name) {
    const sh = getSS_().getSheetByName(name);
    const last = sh ? sh.getLastRow() : 0;
    return last >= 2 && !!sh.getRange(2, 13, last - 1, 1).createTextFinder(photoId).matchEntireCell(true).findNext();
  });
  if (!found) throw appError_('NOT_FOUND', 'ไม่พบรูปนี้');
  const blob = DriveApp.getFileById(photoId).getBlob();
  return { dataUrl: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

function apiGetPrintData_(user, p) {
  const building = str_(p.building);
  const all = loadEquipment_(false);
  const buildings = all.map(function (e) { return e.building; })
    .filter(function (b, i, arr) { return b && arr.indexOf(b) === i; })
    .sort(function (a, b) { return a.localeCompare(b, 'th', { numeric: true }); });
  const items = all
    .filter(function (e) { return !building || e.building === building; })
    .sort(function (a, b) {
      return a.building.localeCompare(b.building, 'th', { numeric: true }) ||
        a.floor.localeCompare(b.floor, 'th', { numeric: true }) ||
        a.id.localeCompare(b.id, 'en', { numeric: true });
    })
    .map(function (e) { return { id: e.id, building: e.building, floor: e.floor, location: e.location, type: e.type }; });
  return { baseUrl: getWebAppUrl_(), orgName: getConfig_().orgName, buildings: buildings, items: items };
}
