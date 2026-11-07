/**
 * Report.gs — รายงานประจำเดือน (PDF ใน Google Drive + แนบอีเมลให้ Admin)
 * สร้างผ่าน Google Docs เพื่อให้ฟอนต์ภาษาไทยแสดงผลถูกต้องใน PDF
 */

/** Trigger ทุกวันที่ 1 ของเดือน: สร้างรายงานของเดือนก่อนหน้า */
function monthlyReport(e) {
  requireOwnerOrTrigger_(e);
  const nowYm = ym_(new Date()).split('-').map(Number);
  let y = nowYm[0];
  let m = nowYm[1] - 1;
  if (m < 1) { m = 12; y -= 1; }
  return generateMonthlyReport_(y, m, true);
}

function menuReportForMonth() {
  requireOwner_();
  const ui = SpreadsheetApp.getUi();
  const prev = (function () {
    const p = ym_(new Date()).split('-').map(Number);
    return p[1] === 1 ? (p[0] + 542) + '-12' : (p[0] + 543) + '-' + String(p[1] - 1).padStart(2, '0');
  })();
  const ans = promptText_(ui, 'สร้างรายงานย้อนหลัง', 'ระบุเดือนที่ต้องการ (ปี-เดือน) เช่น ' + prev + ' (พ.ศ.) หรือแบบ ค.ศ.');
  if (ans === null) return;
  const ym = parseYearMonth_(ans);
  if (!ym) return ui.alert('รูปแบบไม่ถูกต้อง ตัวอย่าง: ' + prev);
  const sendAns = ui.alert('ส่งอีเมล?', 'ต้องการแนบรายงานส่งอีเมลให้ผู้รับใน ALERT_EMAILS ด้วยหรือไม่?', ui.ButtonSet.YES_NO);
  const res = generateMonthlyReport_(ym.year, ym.month, sendAns === ui.Button.YES);
  ui.alert('สร้างรายงานเรียบร้อย', res.name + '\n\n' + res.url, ui.ButtonSet.OK);
}

/** รับ '2569-10', '2026-10', '10/2569' → { year (ค.ศ.), month } */
function parseYearMonth_(s) {
  s = str_(s);
  let y, m, mt;
  if ((mt = s.match(/^(\d{4})[-/.](\d{1,2})$/))) { y = +mt[1]; m = +mt[2]; }
  else if ((mt = s.match(/^(\d{1,2})[-/.](\d{4})$/))) { m = +mt[1]; y = +mt[2]; }
  else return null;
  if (y > 2400) y -= 543;
  if (m < 1 || m > 12 || y < 2000 || y > 2200) return null;
  return { year: y, month: m };
}

function getReportFolder_() {
  const id = getConfig_().reportFolderId;
  if (!id) throw appError_('SETUP', 'ยังไม่ได้ตั้งค่าโฟลเดอร์รายงาน กรุณากดเมนู "ติดตั้งระบบ"');
  return DriveApp.getFolderById(id);
}

/** สรุปข้อมูลรายงาน (แยกจากการสร้างเอกสาร เพื่อให้ทดสอบได้) */
function buildMonthlyReportData_(equipment, inspections, year, month, warnDays) {
  const start = monthStart_(year, month);
  const next = month === 12 ? monthStart_(year + 1, 1) : monthStart_(year, month + 1);
  const end = new Date(next.getTime() - 1);
  const monthIns = inspections.filter(function (i) { return i.time >= start && i.time <= end; });
  const items = buildSnapshot_(equipment, inspections, end, warnDays);
  const s = summarize_(items);
  return {
    year: year, month: month,
    summary: s,
    inspectionCount: monthIns.length,
    passCount: monthIns.filter(function (i) { return i.result === 'PASS'; }).length,
    failCount: monthIns.filter(function (i) { return i.result === 'FAIL'; }).length,
    damaged: items.filter(function (it) { return it.status === STATUS.DAMAGED; }),
    expired: items.filter(function (it) { return it.expiry === EXPIRY.EXPIRED; }),
    soon: items.filter(function (it) { return it.expiry === EXPIRY.SOON; }),
    notInspected: items.filter(function (it) { return !it.inspectedThisMonth; }),
    inspectors: buildInspectorStats_(monthIns),
  };
}

function generateMonthlyReport_(year, month, sendEmail) {
  const cfg = getConfig_();
  const data = buildMonthlyReportData_(loadEquipment_(false), loadInspections_(), year, month, cfg.warnDays);
  const thYear = year + 543;
  const title = 'รายงานการตรวจถังดับเพลิง ประจำเดือน' + THAI_MONTHS[month - 1] + ' ' + thYear;
  const fileName = 'รายงานตรวจถังดับเพลิง_' + thYear + '-' + String(month).padStart(2, '0');

  const doc = DocumentApp.create(fileName);
  const body = doc.getBody();
  body.setMarginTop(42).setMarginBottom(42).setMarginLeft(48).setMarginRight(48);

  body.appendParagraph(cfg.orgName).setHeading(DocumentApp.ParagraphHeading.SUBTITLE);
  body.appendParagraph(title).setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph('สร้างเมื่อ ' + fmtThaiDateTime_(new Date()) + ' · สถานะคำนวณ ณ สิ้นเดือน' + THAI_MONTHS[month - 1]);

  const s = data.summary;
  heading_(body, '1. สรุปภาพรวม');
  table_(body, ['หัวข้อ', 'จำนวน'], [
    ['ถังดับเพลิงที่ใช้งานอยู่', s.total + ' ถัง'],
    ['ตรวจแล้วในเดือนนี้', s.inspected + ' ถัง (' + s.progressPct + '%)'],
    ['ยังไม่ได้ตรวจ', (s.total - s.inspected) + ' ถัง'],
    ['จำนวนครั้งการตรวจทั้งหมด', data.inspectionCount + ' ครั้ง (ผ่าน ' + data.passCount + ' / ไม่ผ่าน ' + data.failCount + ')'],
    ['สถานะปกติ ณ สิ้นเดือน', s.normal + ' ถัง'],
    ['สถานะชำรุด ณ สิ้นเดือน', s.damaged + ' ถัง'],
    ['หมดอายุ / เลยกำหนด', s.expired + ' ถัง'],
    ['ใกล้หมดอายุ (≤ ' + cfg.warnDays + ' วัน)', s.soon + ' ถัง'],
  ]);

  heading_(body, '2. ถังที่ชำรุด ณ สิ้นเดือน');
  table_(body, ['รหัส', 'ตำแหน่ง', 'ข้อที่ไม่ผ่าน', 'ตรวจล่าสุด'], data.damaged.map(function (it) {
    return [it.id, locationText_(it), it.last ? it.last.failedItems : '-',
      it.last ? fmtThaiDate_(it.last.time.slice(0, 10)) + ' (' + it.last.by + ')' : '-'];
  }));

  heading_(body, '3. ถังหมดอายุ / ใกล้หมดอายุ');
  table_(body, ['รหัส', 'ตำแหน่ง', 'สถานะ', 'รายละเอียด'], data.expired.concat(data.soon).map(function (it) {
    return [it.id, locationText_(it), it.expiry === EXPIRY.EXPIRED ? 'หมดอายุ' : 'ใกล้หมดอายุ',
      expiryText_(it).replace(/<br>/g, '\n')];
  }));

  heading_(body, '4. สรุปรายผู้ตรวจ');
  table_(body, ['ผู้ตรวจ', 'ครั้ง', 'จำนวนถัง', 'ไม่ผ่าน', 'พิมพ์รหัสเอง'], data.inspectors.map(function (x) {
    return [x.name, String(x.count), String(x.tanks), String(x.fail), x.manual + ' (' + x.manualPct + '%)'];
  }));

  heading_(body, '5. ถังที่ยังไม่ได้ตรวจในเดือนนี้');
  table_(body, ['รหัส', 'ตำแหน่ง', 'ชนิด'], data.notInspected.map(function (it) {
    return [it.id, locationText_(it), it.type];
  }));

  body.appendParagraph('');
  body.appendParagraph('ลงชื่อ ........................................ ผู้ตรวจสอบ        ลงชื่อ ........................................ ผู้รับรอง');
  body.editAsText().setFontFamily('Sarabun');
  doc.saveAndClose();

  const folder = getReportFolder_();
  const old = folder.getFilesByName(fileName + '.pdf');
  while (old.hasNext()) old.next().setTrashed(true);
  const docFile = DriveApp.getFileById(doc.getId());
  const pdf = folder.createFile(docFile.getAs(MimeType.PDF).setName(fileName + '.pdf'));
  docFile.setTrashed(true);

  if (sendEmail) {
    const inner = '<p>รายงานการตรวจถังดับเพลิงประจำเดือน<b>' + escapeHtml_(THAI_MONTHS[month - 1] + ' ' + thYear) + '</b> แนบมากับอีเมลนี้</p>' +
      '<ul><li>ตรวจแล้ว ' + s.inspected + '/' + s.total + ' ถัง (' + s.progressPct + '%)</li>' +
      '<li>ชำรุด ณ สิ้นเดือน ' + s.damaged + ' ถัง</li><li>หมดอายุ ' + s.expired + ' ถัง · ใกล้หมดอายุ ' + s.soon + ' ถัง</li></ul>' +
      '<p><a href="' + escapeHtml_(pdf.getUrl()) + '">เปิดไฟล์ใน Google Drive</a></p>';
    sendMail_('[รายงานประจำเดือน] ' + title, emailShell_(title, '#C62828', inner), [pdf.getBlob()]);
  }
  return { name: pdf.getName(), url: pdf.getUrl() };
}

function heading_(body, text) {
  body.appendParagraph(text).setHeading(DocumentApp.ParagraphHeading.HEADING2);
}

function table_(body, header, rows) {
  if (!rows.length) {
    body.appendParagraph('— ไม่มี —').editAsText().setItalic(true);
    return;
  }
  const cells = [header].concat(rows).map(function (r) { return r.map(function (c) { return String(c === null || c === undefined ? '' : c); }); });
  const t = body.appendTable(cells);
  t.setBorderColor('#cccccc');
  const head = t.getRow(0);
  for (let i = 0; i < head.getNumCells(); i++) {
    head.getCell(i).setBackgroundColor('#C62828').editAsText().setBold(true).setForegroundColor('#ffffff');
  }
  for (let r = 0; r < t.getNumRows(); r++) {
    const row = t.getRow(r);
    for (let c = 0; c < row.getNumCells(); c++) row.getCell(c).setPaddingTop(3).setPaddingBottom(3).editAsText().setFontSize(10);
  }
}
