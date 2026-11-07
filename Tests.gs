/**
 * Tests.gs — ทดสอบ logic หลัก (ไม่แตะข้อมูลจริงในชีต)
 * รันจากเมนู "✅ ทดสอบระบบ" หรือเลือกฟังก์ชัน runTests ใน Apps Script Editor
 */

function runTests() {
  requireOwner_();
  const r = runAllTests_();
  const lines = r.results.map(function (x) { return (x.ok ? '✅ ' : '❌ ') + x.name + (x.ok ? '' : ' — ' + x.error); });
  const msg = 'ผ่าน ' + r.passed + ' / ' + (r.passed + r.failed) + ' ข้อ\n\n' + lines.join('\n');
  console.log(msg);
  const ui = getUiOrNull_();
  if (ui) ui.alert('ผลการทดสอบระบบ', msg, ui.ButtonSet.OK);
  return r;
}

function runAllTests_() {
  const results = [];
  function test(name, fn) {
    try { fn(); results.push({ name: name, ok: true }); }
    catch (e) { results.push({ name: name, ok: false, error: e && e.message ? e.message : String(e) }); }
  }
  function eq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error((label || 'ค่าไม่ตรง') + ': ได้ ' + a + ' แต่คาดว่า ' + b);
  }
  function ok(cond, label) { if (!cond) throw new Error(label || 'เงื่อนไขไม่เป็นจริง'); }

  // เวลาไทย 2026-11-15 10:00
  const NOW = new Date('2026-11-15T03:00:00Z');
  const at = function (iso) { return new Date(iso); };
  const tank = function (id, extra) {
    return Object.assign({ id: id, building: 'A', floor: '1', location: 'x', type: 'ผงเคมีแห้ง ABC', size: '15', brand: '', serviceDate: '', expiryDate: '' }, extra || {});
  };
  const ins = function (eqId, iso, result) {
    return { id: eqId + iso, time: at(iso), equipmentId: eqId, inspectorId: 'U001', inspectorName: 'ทดสอบ', method: 'QR', result: result, failedItems: '', remarks: '', repaired: false };
  };
  const statusOf = function (inspections, ref) {
    return buildSnapshot_([tank('T1')], inspections, ref || NOW, 30)[0].status;
  };

  test('ไม่เคยตรวจ → รอการตรวจ', function () { eq(statusOf([]), STATUS.PENDING); });
  test('ตรวจผ่านเดือนนี้ → ปกติ', function () { eq(statusOf([ins('T1', '2026-11-02T02:00:00Z', 'PASS')]), STATUS.NORMAL); });
  test('ตรวจผ่านเดือนก่อน → รอการตรวจ', function () { eq(statusOf([ins('T1', '2026-10-20T02:00:00Z', 'PASS')]), STATUS.PENDING); });
  test('ชำรุดเดือนก่อน ยังไม่ตรวจซ้ำ → ชำรุด (คงสถานะข้ามเดือน)', function () {
    eq(statusOf([ins('T1', '2026-09-20T02:00:00Z', 'FAIL')]), STATUS.DAMAGED);
  });
  test('ชำรุดแล้วตรวจผ่านภายหลัง → ปกติ', function () {
    eq(statusOf([ins('T1', '2026-11-01T02:00:00Z', 'FAIL'), ins('T1', '2026-11-10T02:00:00Z', 'PASS')]), STATUS.NORMAL);
  });
  test('ผ่านแล้วตรวจซ้ำพบชำรุด → ชำรุด (ใช้ผลล่าสุด)', function () {
    eq(statusOf([ins('T1', '2026-11-01T02:00:00Z', 'PASS'), ins('T1', '2026-11-10T02:00:00Z', 'FAIL')]), STATUS.DAMAGED);
  });
  test('ลำดับแถวไม่มีผล (คิวออฟไลน์ส่งช้า) ใช้เวลาตรวจจริง', function () {
    eq(statusOf([ins('T1', '2026-11-10T02:00:00Z', 'PASS'), ins('T1', '2026-11-05T02:00:00Z', 'FAIL')]), STATUS.NORMAL);
  });
  test('การตรวจหลังเวลาอ้างอิงไม่ถูกนับ (รายงานย้อนหลัง)', function () {
    eq(statusOf([ins('T1', '2026-11-20T02:00:00Z', 'FAIL')]), STATUS.PENDING);
  });
  test('ขอบเดือนตามเวลาไทย: 31 ต.ค. 23:30 น. = เดือน ต.ค.', function () {
    eq(ym_(at('2026-10-31T16:30:00Z')), '2026-10');
    eq(ym_(at('2026-10-31T17:30:00Z')), '2026-11');
  });

  const expiryOf = function (extra) { return buildSnapshot_([tank('T1', extra)], [], NOW, 30)[0]; };
  test('ไม่มีวันที่ → ไม่มีป้ายหมดอายุ', function () { eq(expiryOf({}).expiry, EXPIRY.OK); });
  test('เลยวันบำรุงรักษา → หมดอายุ', function () { eq(expiryOf({ serviceDate: '2026-11-14' }).expiry, EXPIRY.EXPIRED); });
  test('ครบกำหนดวันนี้ → ใกล้หมดอายุ', function () { eq(expiryOf({ serviceDate: '2026-11-15' }).expiry, EXPIRY.SOON); });
  test('เหลือ 30 วัน → ใกล้หมดอายุ', function () { eq(expiryOf({ expiryDate: '2026-12-15' }).expiry, EXPIRY.SOON); });
  test('เหลือ 31 วัน → ปกติ', function () { eq(expiryOf({ expiryDate: '2026-12-16' }).expiry, EXPIRY.OK); });
  test('ใช้วันที่ใกล้ที่สุดจาก 2 วันที่', function () {
    const it = expiryOf({ serviceDate: '2027-06-01', expiryDate: '2026-11-01' });
    eq(it.expiry, EXPIRY.EXPIRED);
    eq(it.minDaysLeft, -14);
  });
  test('ป้ายหมดอายุไม่เปลี่ยนสถานะหลัก', function () {
    const it = buildSnapshot_([tank('T1', { serviceDate: '2026-11-20' })], [ins('T1', '2026-11-02T02:00:00Z', 'PASS')], NOW, 30)[0];
    eq([it.status, it.expiry], [STATUS.NORMAL, EXPIRY.SOON]);
  });

  test('summarize_ นับสถานะและความคืบหน้า', function () {
    const items = buildSnapshot_([tank('T1'), tank('T2'), tank('T3'), tank('T4', { serviceDate: '2026-01-01' })],
      [ins('T1', '2026-11-02T02:00:00Z', 'PASS'), ins('T2', '2026-11-03T02:00:00Z', 'FAIL')], NOW, 30);
    const s = summarize_(items);
    eq([s.total, s.normal, s.damaged, s.pending, s.expired, s.inspected, s.progressPct], [4, 1, 1, 2, 1, 2, 50]);
  });

  test('toYmd_ รองรับ พ.ศ. และ ค.ศ.', function () {
    eq(toYmd_('2026-1-5'), '2026-01-05');
    eq(toYmd_('05/01/2569'), '2026-01-05');
    eq(toYmd_('ไม่ใช่วันที่'), '');
  });
  test('parseYearMonth_ รองรับ พ.ศ./ค.ศ.', function () {
    eq(parseYearMonth_('2569-10'), { year: 2026, month: 10 });
    eq(parseYearMonth_('10/2026'), { year: 2026, month: 10 });
    eq(parseYearMonth_('2569-13'), null);
  });
  test('fmtThaiDate_ แสดงเป็น พ.ศ.', function () { eq(fmtThaiDate_('2026-11-07'), '07/11/2569'); });

  test('รายการตรวจตามชนิดถัง (CO2 ไม่มีเกจ)', function () {
    const cl = CHECKLIST_DEFAULTS.map(function (r) {
      return { id: r[0], title: r[1], how: r[2], appliesTo: String(r[3]).split(',').map(function (s) { return s.trim(); }).filter(String) };
    });
    eq(applicableItems_(cl, 'CO2').length, 6);
    eq(applicableItems_(cl, 'ผงเคมีแห้ง ABC').length, 7);
  });

  test('hash PIN: ค่าเดิมได้ผลเดิม, salt ต่าง/PIN ผิดได้ผลต่าง', function () {
    const h1 = hashPin_('123456', 'salt-a', 'pepper-test');
    eq(hashPin_('123456', 'salt-a', 'pepper-test'), h1);
    ok(hashPin_('123456', 'salt-b', 'pepper-test') !== h1, 'salt ต่างควรได้ hash ต่าง');
    ok(hashPin_('123457', 'salt-a', 'pepper-test') !== h1, 'PIN ผิดควรได้ hash ต่าง');
    ok(h1.indexOf('123456') === -1, 'hash ต้องไม่มี PIN ปรากฏ');
  });
  test('รูปแบบ PIN 4–6 หลัก', function () {
    eq([isValidPin_('1234'), isValidPin_('123456'), isValidPin_('123'), isValidPin_('1234567'), isValidPin_('12a4')], [true, true, false, false, false]);
  });
  test('token: ลายเซ็นถูกต้อง / ถูกแก้ไข / หมดอายุ', function () {
    const secret = 'secret-test';
    const t = signToken_({ u: 'U001', h: 'abc', e: Date.now() + 60000 }, secret);
    eq(verifyTokenSignature_(t, secret, Date.now()).u, 'U001');
    eq(verifyTokenSignature_(t, 'other-secret', Date.now()), null);
    const parts = t.split('.');
    const forged = Utilities.base64EncodeWebSafe(JSON.stringify({ u: 'ADMIN', h: 'abc', e: Date.now() + 60000 }), Utilities.Charset.UTF_8) + '.' + parts[1];
    eq(verifyTokenSignature_(forged, secret, Date.now()), null);
    const expired = signToken_({ u: 'U001', h: 'abc', e: Date.now() - 1 }, secret);
    eq(verifyTokenSignature_(expired, secret, Date.now()), null);
    eq(verifyTokenSignature_('garbage', secret, Date.now()), null);
  });
  test('กัน Formula Injection', function () {
    eq(safeCell_('=IMPORTXML("http://x")'), "'=IMPORTXML(\"http://x\")");
    eq(safeCell_('+1'), "'+1");
    eq(safeCell_('ปกติ'), 'ปกติ');
  });
  test('รหัสถังจาก URL parameter ถูกกรอง', function () {
    eq(sanitizeIdParam_('fe-001'), 'FE-001');
    eq(sanitizeIdParam_('<script>'), '');
    eq(sanitizeIdParam_(''), '');
  });
  test('เวลาจากเครื่อง: ยอมรับ 7 วัน ไม่รับอนาคต', function () {
    const now = new Date('2026-11-15T03:00:00Z');
    eq(clampClientTime_('2026-11-14T03:00:00Z', now).toISOString(), '2026-11-14T03:00:00.000Z');
    eq(clampClientTime_('2026-11-16T03:00:00Z', now).getTime(), now.getTime());
    eq(clampClientTime_('2026-10-01T03:00:00Z', now).getTime(), now.getTime());
    eq(clampClientTime_('xx', now).getTime(), now.getTime());
  });
  test('รายงานประจำเดือน: นับเฉพาะการตรวจในเดือน', function () {
    const data = buildMonthlyReportData_([tank('T1'), tank('T2')], [
      ins('T1', '2026-10-10T02:00:00Z', 'PASS'),
      ins('T2', '2026-10-31T16:30:00Z', 'FAIL'), // 31 ต.ค. 23:30 น. เวลาไทย
      ins('T1', '2026-11-02T02:00:00Z', 'FAIL'),
    ], 2026, 10, 30);
    eq([data.inspectionCount, data.passCount, data.failCount, data.summary.inspected, data.damaged.length], [2, 1, 1, 2, 1]);
    eq(data.damaged[0].id, 'T2');
  });
  test('สถิติผู้ตรวจ: สัดส่วนการพิมพ์รหัสเอง', function () {
    const a = ins('T1', '2026-11-02T02:00:00Z', 'PASS');
    const b = ins('T2', '2026-11-02T03:00:00Z', 'PASS');
    b.method = 'MANUAL';
    eq(buildInspectorStats_([a, b])[0].manualPct, 50);
  });

  const passed = results.filter(function (x) { return x.ok; }).length;
  return { passed: passed, failed: results.length - passed, results: results };
}
