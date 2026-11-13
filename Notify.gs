/**
 * Notify.gs — อีเมลแจ้งเตือน
 * 1) แจ้งทันทีเมื่อพบถังชำรุด (แนบรูป)
 * 2) สรุปรายวัน (trigger ทุกวันตามชั่วโมงใน Config) ส่งเฉพาะวันที่มีถังชำรุด/หมดอายุ/ใกล้หมดอายุ
 */

function escapeHtml_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function locationText_(eq) {
  return [eq.building, eq.floor ? 'ชั้น ' + eq.floor : '', eq.location].filter(String).join(' · ');
}

function sendMail_(subject, htmlBody, attachments) {
  const cfg = getConfig_();
  if (!cfg.alertEmails.length) {
    console.warn('ไม่ได้ตั้งค่า ALERT_EMAILS ในชีต Config — ข้ามการส่งอีเมล: ' + subject);
    return false;
  }
  if (MailApp.getRemainingDailyQuota() < 1) {
    console.warn('โควตาอีเมลวันนี้หมดแล้ว — ข้ามการส่ง: ' + subject);
    return false;
  }
  const opts = { to: cfg.alertEmails.join(','), subject: subject, htmlBody: htmlBody, name: cfg.orgName };
  if (attachments && attachments.length) opts.attachments = attachments;
  MailApp.sendEmail(opts);
  return true;
}

function emailShell_(title, color, inner) {
  const cfg = getConfig_();
  const url = getWebAppUrl_();
  return '<div style="font-family:Tahoma,Sarabun,sans-serif;max-width:640px;margin:auto;color:#1d1d1f">' +
    '<div style="background:' + color + ';color:#fff;padding:14px 18px;border-radius:10px 10px 0 0">' +
    '<div style="font-size:13px;opacity:.9">' + escapeHtml_(cfg.orgName) + '</div>' +
    '<div style="font-size:19px;font-weight:bold">' + escapeHtml_(title) + '</div></div>' +
    '<div style="border:1px solid #e3e3e6;border-top:0;padding:16px 18px;border-radius:0 0 10px 10px">' + inner +
    (url ? '<p style="margin-top:18px"><a href="' + escapeHtml_(url) + '" style="background:#C62828;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">เปิดระบบตรวจถังดับเพลิง</a></p>' : '') +
    '<p style="font-size:12px;color:#777;margin-top:18px">อีเมลนี้ส่งอัตโนมัติจากระบบ กรุณาอย่าตอบกลับ</p></div></div>';
}

function notifyDamaged_(r) {
  const eq = r.equipment;
  const rows = [
    ['รหัสถัง', eq.id],
    ['ตำแหน่ง', locationText_(eq)],
    ['ชนิด / ขนาด', [eq.type, eq.size ? eq.size + ' ปอนด์' : ''].filter(String).join(' / ')],
    ['ผู้ตรวจ', r.inspector],
    ['เวลาตรวจ', fmtThaiDateTime_(r.time)],
    ['วิธีระบุถัง', r.method === METHOD.MANUAL ? 'พิมพ์รหัสเอง (MANUAL)' : 'สแกน QR'],
    ['ข้อที่ไม่ผ่าน', r.failed.join(', ')],
    ['หมายเหตุ', r.remarks || '-'],
  ];
  const table = '<table style="border-collapse:collapse;width:100%;font-size:14px">' + rows.map(function (x) {
    return '<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;color:#555;width:130px">' + escapeHtml_(x[0]) +
      '</td><td style="padding:6px 8px;border-bottom:1px solid #eee"><b>' + escapeHtml_(x[1]) + '</b></td></tr>';
  }).join('') + '</table>' + (r.photoBlob ? '<p style="font-size:13px;color:#555">📎 แนบรูปจุดชำรุดมากับอีเมลนี้</p>' : '');
  return sendMail_((r.retry ? '[ส่งซ้ำ] ' : '') + '[แจ้งเตือน] พบถังดับเพลิงชำรุด ' + eq.id + ' — ' + locationText_(eq),
    emailShell_('⚠️ พบถังดับเพลิงชำรุด', '#C62828', table),
    r.photoBlob ? [r.photoBlob] : null);
}

/**
 * ส่งอีเมลชำรุดทันทีหลังบันทึก คืนสถานะ: 'SENT' | 'PENDING' (ส่งไม่ได้ ระบบจะลองใหม่) | 'NO_RECIPIENTS' (ยังไม่ตั้ง ALERT_EMAILS)
 * ผลตรวจถูกบันทึกแล้วเสมอ — ความล้มเหลวของอีเมลไม่ทำให้การบันทึกล้ม
 */
function sendDamagedAlert_(uuid, r) {
  try {
    if (notifyDamaged_(r)) {
      markAlertSent_(uuid);
      return ALERT.SENT;
    }
    return getConfig_().alertEmails.length ? ALERT.PENDING : 'NO_RECIPIENTS';
  } catch (e) {
    console.error('notifyDamaged_ failed: ' + e);
    return ALERT.PENDING;
  }
}

function markAlertSent_(uuid) {
  const sh = sheet_(APP.SHEETS.INSPECTIONS);
  const row = findInspectionRow_(sh, uuid);
  if (row) sh.getRange(row, INS_COL.ALERT).setValue(ALERT.SENT);
}

/** Trigger ทุกชั่วโมง: ส่งอีเมลชำรุดที่ค้างอยู่ (ส่งไม่สำเร็จ หรือยังไม่มีผู้รับตอนนั้น) ครั้งละไม่เกิน 20 รายการ */
function retryPendingAlerts(e) {
  requireOwnerOrTrigger_(e);
  if (!getConfig_().alertEmails.length) return 'ยังไม่ได้ตั้ง ALERT_EMAILS';
  const sh = sheet_(APP.SHEETS.INSPECTIONS);
  const last = sh.getLastRow();
  if (last < 2) return 'ไม่มีรายการค้าง';
  const flags = sh.getRange(2, INS_COL.ALERT, last - 1, 1).getValues();
  const eqMap = {};
  loadEquipment_(true).forEach(function (x) { eqMap[x.id] = x; });
  let tried = 0;
  let sent = 0;
  for (let i = 0; i < flags.length && tried < 20; i++) {
    if (str_(flags[i][0]) !== ALERT.PENDING) continue;
    tried++;
    const row = sh.getRange(i + 2, 1, 1, INSPECTION_HEADERS.length).getValues()[0];
    const eq = eqMap[normalizeId_(row[2])];
    if (!eq) { console.warn('retryPendingAlerts: ไม่พบถัง ' + row[2]); continue; }
    let blob = null;
    const photoId = str_(row[12]);
    if (photoId) { try { blob = DriveApp.getFileById(photoId).getBlob(); } catch (err) { console.warn('อ่านรูปไม่ได้: ' + err); } }
    try {
      const ok = notifyDamaged_({
        equipment: eq, inspector: str_(row[4]), time: isDate_(row[1]) ? row[1] : new Date(row[1]),
        failed: str_(row[7]).split(', ').filter(String), remarks: str_(row[9]),
        method: str_(row[5]) === METHOD.MANUAL ? METHOD.MANUAL : METHOD.QR, photoBlob: blob, retry: true,
      });
      if (!ok) break; // โควตาหมดหรือไม่มีผู้รับ — รอรอบหน้า
      sh.getRange(i + 2, INS_COL.ALERT).setValue(ALERT.SENT);
      sent++;
    } catch (err) {
      console.error('retryPendingAlerts failed: ' + err);
      break;
    }
  }
  return 'ส่งซ้ำสำเร็จ ' + sent + ' จาก ' + tried + ' รายการ';
}

/** แจ้ง Admin เมื่อบัญชีถูกล็อกเพราะใส่ PIN ผิด (จำกัด 1 ฉบับ/ชั่วโมง กันโควตาอีเมลหมดจากการถูกโจมตีซ้ำ) */
function notifyLockout_(user) {
  try {
    const cache = CacheService.getScriptCache();
    if (cache.get('lockmail')) return;
    cache.put('lockmail', '1', 3600);
    const inner = '<p>บัญชี <b>' + escapeHtml_(user.name) + '</b> (' + escapeHtml_(user.id) + ') ถูกล็อก ' +
      Math.round(APP.LOCK_SECONDS / 60) + ' นาที เพราะใส่ PIN ผิดเกิน ' + APP.MAX_PIN_FAILS + ' ครั้ง ณ ' +
      escapeHtml_(fmtThaiDateTime_(new Date())) + '</p>' +
      '<p>หากเจ้าของบัญชีไม่ได้เป็นคนทำ อาจมีผู้อื่นพยายามเดา PIN หากต้องการปลดล็อกทันที ให้ใช้เมนู <b>ตั้ง PIN ใหม่ / ปลดล็อก</b> ใน Google Sheet</p>';
    sendMail_('[แจ้งเตือน] บัญชีผู้ใช้ถูกล็อก: ' + user.name, emailShell_('🔒 บัญชีผู้ใช้ถูกล็อก', '#EF6C00', inner));
  } catch (e) {
    console.error('notifyLockout_ failed: ' + e);
  }
}

function expiryText_(it) {
  return it.expiryDetails.map(function (d) {
    const label = d.kind === 'service' ? 'บำรุงรักษา' : 'หมดอายุ/ทดสอบแรงดัน';
    const when = d.daysLeft < 0 ? 'เลยกำหนด ' + (-d.daysLeft) + ' วัน' : (d.daysLeft === 0 ? 'ครบกำหนดวันนี้' : 'อีก ' + d.daysLeft + ' วัน');
    return label + ' ' + fmtThaiDate_(d.date) + ' (' + when + ')';
  }).join('<br>');
}

/** Trigger รายวัน — เรียกจากเมนูเพื่อทดสอบได้ */
function dailyAlert(e) {
  requireOwnerOrTrigger_(e);
  const data = getDashboardData_(true);
  const damaged = data.items.filter(function (it) { return it.status === STATUS.DAMAGED; });
  const expired = data.items.filter(function (it) { return it.expiry === EXPIRY.EXPIRED; });
  const soon = data.items.filter(function (it) { return it.expiry === EXPIRY.SOON; });
  const backupWarn = backupWarningHtml_();
  if (!damaged.length && !expired.length && !soon.length && !backupWarn) {
    console.log('dailyAlert: ไม่มีรายการที่ต้องแจ้งเตือน');
    return 'ไม่มีรายการที่ต้องแจ้งเตือนวันนี้ (ไม่ได้ส่งอีเมล)';
  }

  function section(title, color, list, extra) {
    if (!list.length) return '';
    return '<h3 style="color:' + color + ';margin:18px 0 6px">' + escapeHtml_(title) + ' (' + list.length + ')</h3>' +
      '<table style="border-collapse:collapse;width:100%;font-size:13px">' +
      '<tr style="background:#f4f4f6"><th style="text-align:left;padding:6px">รหัส</th><th style="text-align:left;padding:6px">ตำแหน่ง</th><th style="text-align:left;padding:6px">รายละเอียด</th></tr>' +
      list.map(function (it) {
        return '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>' + escapeHtml_(it.id) + '</b></td>' +
          '<td style="padding:6px;border-bottom:1px solid #eee">' + escapeHtml_(locationText_(it)) + '</td>' +
          '<td style="padding:6px;border-bottom:1px solid #eee">' + extra(it) + '</td></tr>';
      }).join('') + '</table>';
  }

  const s = data.summary;
  const inner =
    '<p>ภาพรวม ณ ' + escapeHtml_(fmtThaiDateTime_(new Date())) + ': ถังทั้งหมด <b>' + s.total + '</b> ถัง · ' +
    'ตรวจแล้วเดือนนี้ <b>' + s.inspected + '</b> ถัง (' + s.progressPct + '%)</p>' +
    section('🔴 ถังชำรุด', '#C62828', damaged, function (it) {
      return escapeHtml_(it.last && it.last.failedItems ? 'ไม่ผ่าน: ' + it.last.failedItems : '') +
        (it.last ? '<br><span style="color:#777">ตรวจเมื่อ ' + escapeHtml_(fmtThaiDate_(it.last.time.slice(0, 10))) + ' โดย ' + escapeHtml_(it.last.by) + '</span>' : '');
    }) +
    section('⛔ หมดอายุ / เลยกำหนด', '#8E0000', expired, expiryText_) +
    section('🟠 ใกล้หมดอายุ (≤ ' + data.warnDays + ' วัน)', '#EF6C00', soon, expiryText_) +
    backupWarn;

  const subject = '[สรุปประจำวัน] ถังดับเพลิง: ชำรุด ' + damaged.length + ' · หมดอายุ ' + expired.length + ' · ใกล้หมดอายุ ' + soon.length;
  const sent = sendMail_(subject, emailShell_('สรุปสถานะถังดับเพลิงประจำวัน', '#C62828', inner));
  return sent ? 'ส่งอีเมลสรุปแล้ว: ' + subject : 'ไม่ได้ส่งอีเมล (ตรวจสอบ ALERT_EMAILS ในชีต Config)';
}

function menuTestDailyAlert() {
  requireOwner_();
  const msg = dailyAlert();
  SpreadsheetApp.getUi().alert(msg);
}
