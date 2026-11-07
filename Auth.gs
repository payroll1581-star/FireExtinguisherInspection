/**
 * Auth.gs — ผู้ใช้, PIN (hash + salt + pepper), session token (HMAC) และการตรวจสิทธิ์
 *
 * - PIN เก็บเป็น SHA-256 วนซ้ำ (pepper ใน Script Properties + salt ต่อผู้ใช้) ไม่เก็บตัวเลขจริง
 * - Token เป็นแบบ stateless ลงลายเซ็น HMAC-SHA256 อายุ 12 ชั่วโมง
 *   (CacheService เก็บได้สูงสุด 6 ชั่วโมง จึงไม่ใช้เก็บ session)
 * - Token ผูกกับ hash ของ PIN ปัจจุบัน → ตั้ง PIN ใหม่แล้ว token เดิมใช้ไม่ได้ทันที
 * - ทุก API ตรวจ token และ role จากชีต Users ทุกครั้ง (ไม่เชื่อค่าจากฝั่ง client)
 */

/* ============================== Secrets ============================== */

function getSecret_(name) {
  const props = PropertiesService.getScriptProperties();
  let v = props.getProperty(name);
  if (!v) {
    v = randomSecret_();
    props.setProperty(name, v);
  }
  return v;
}

function randomSecret_() {
  return (Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function ensureSecrets_() {
  getSecret_('TOKEN_SECRET');
  getSecret_('PIN_PEPPER');
}

/* ============================== PIN hashing ============================== */

function hashPin_(pin, salt, pepper) {
  const p = pepper || getSecret_('PIN_PEPPER');
  const alg = Utilities.DigestAlgorithm.SHA_256;
  let bytes = Utilities.computeDigest(alg, p + '|' + salt + '|' + pin, Utilities.Charset.UTF_8);
  for (let i = 0; i < APP.PIN_HASH_ROUNDS; i++) bytes = Utilities.computeDigest(alg, bytes);
  return Utilities.base64Encode(bytes);
}

function isValidPin_(pin) {
  return /^\d{4,6}$/.test(String(pin || ''));
}

/** เปรียบเทียบสตริงแบบใช้เวลาคงที่ */
function safeEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/* ============================== Users ============================== */

function getUsers_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(APP.CACHE_USERS_KEY);
  if (cached) return JSON.parse(cached);
  const users = readRows_(APP.SHEETS.USERS, USER_HEADERS.length).map(function (r) {
    return {
      id: str_(r[0]).toUpperCase(),
      name: str_(r[1]),
      role: str_(r[2]).toUpperCase() === ROLE.ADMIN ? ROLE.ADMIN : ROLE.INSPECTOR,
      salt: str_(r[3]),
      hash: str_(r[4]),
      active: bool_(r[5]),
    };
  }).filter(function (u) { return u.id && u.name; });
  cache.put(APP.CACHE_USERS_KEY, JSON.stringify(users), 60);
  return users;
}

function invalidateUsers_() {
  CacheService.getScriptCache().remove(APP.CACHE_USERS_KEY);
}

function publicUser_(u) {
  return { id: u.id, name: u.name, role: u.role };
}

/* ============================== Login ============================== */

function listUsersPublic_() {
  return getUsers_()
    .filter(function (u) { return u.active && u.hash; })
    .map(function (u) { return { id: u.id, name: u.name }; })
    .sort(function (a, b) { return a.name.localeCompare(b.name, 'th'); });
}

function login_(p) {
  const userId = str_(p.userId).toUpperCase();
  const pin = str_(p.pin);
  if (!userId) throw appError_('VALIDATION', 'กรุณาเลือกชื่อผู้ใช้');
  if (!isValidPin_(pin)) throw appError_('VALIDATION', 'PIN ต้องเป็นตัวเลข 4–6 หลัก');

  const cache = CacheService.getScriptCache();
  const lockKey = 'pinlock_' + userId;
  const failKey = 'pinfail_' + userId;
  if (cache.get(lockKey)) throw appError_('LOCKED', 'ใส่ PIN ผิดเกิน ' + APP.MAX_PIN_FAILS + ' ครั้ง บัญชีถูกล็อก 15 นาที');

  const user = getUsers_().filter(function (u) { return u.id === userId && u.active && u.hash; })[0];
  // คำนวณ hash เสมอแม้ไม่พบผู้ใช้ เพื่อไม่ให้เวลาตอบสนองบอกใบ้ว่ามีผู้ใช้นี้หรือไม่
  const computed = hashPin_(pin, user ? user.salt : 'no-user');
  const ok = !!user && safeEqual_(computed, user.hash);

  if (!ok) {
    const lock = LockService.getScriptLock();
    lock.tryLock(3000);
    try {
      const n = Number(cache.get(failKey) || 0) + 1;
      if (n >= APP.MAX_PIN_FAILS) {
        cache.put(lockKey, '1', APP.LOCK_SECONDS);
        cache.remove(failKey);
        throw appError_('LOCKED', 'ใส่ PIN ผิดเกิน ' + APP.MAX_PIN_FAILS + ' ครั้ง บัญชีถูกล็อก 15 นาที');
      }
      cache.put(failKey, String(n), APP.LOCK_SECONDS);
      throw appError_('AUTH_FAIL', 'PIN ไม่ถูกต้อง (ลองได้อีก ' + (APP.MAX_PIN_FAILS - n) + ' ครั้ง)');
    } finally {
      try { lock.releaseLock(); } catch (e) { /* ไม่ได้ถือ lock */ }
    }
  }

  cache.remove(failKey);
  const exp = Date.now() + APP.SESSION_HOURS * 3600 * 1000;
  const token = signToken_({ u: user.id, h: user.hash.slice(0, 12), e: exp }, getSecret_('TOKEN_SECRET'));
  return { token: token, exp: exp, user: publicUser_(user) };
}

/* ============================== Token ============================== */

function signToken_(payload, secret) {
  const cs = Utilities.Charset.UTF_8;
  const body = Utilities.base64EncodeWebSafe(JSON.stringify(payload), cs);
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, secret, cs));
  return body + '.' + sig;
}

/** ตรวจลายเซ็นและวันหมดอายุ คืน payload หรือ null */
function verifyTokenSignature_(token, secret, nowMs) {
  if (typeof token !== 'string' || !token || token.length > 2000) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const cs = Utilities.Charset.UTF_8;
  const expected = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(parts[0], secret, cs));
  if (!safeEqual_(expected, parts[1])) return null;
  let payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0], cs)).getDataAsString('UTF-8'));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.e !== 'number' || payload.e < nowMs) return null;
  return payload;
}

/** คืนข้อมูลผู้ใช้ปัจจุบัน (role อ่านจากชีตเสมอ) หรือ null */
function verifyToken_(token) {
  const p = verifyTokenSignature_(token, getSecret_('TOKEN_SECRET'), Date.now());
  if (!p) return null;
  const u = getUsers_().filter(function (x) { return x.id === p.u && x.active && x.hash; })[0];
  if (!u || u.hash.slice(0, 12) !== p.h) return null;
  return publicUser_(u);
}

/* ============================== Guards ============================== */

/** อนุญาตเฉพาะเจ้าของ/ผู้แก้ไข Google Sheet ที่ล็อกอินอยู่ (กันการเรียกผ่าน google.script.run จาก Web App) */
function requireOwner_() {
  let active = '';
  let effective = '';
  try { active = Session.getActiveUser().getEmail(); } catch (e) { /* ไม่ทราบตัวตน */ }
  try { effective = Session.getEffectiveUser().getEmail(); } catch (e) { /* ไม่ทราบตัวตน */ }
  if (!active || active !== effective) {
    throw new Error('ฟังก์ชันนี้ใช้ได้เฉพาะเจ้าของระบบจากเมนูใน Google Sheet หรือ Apps Script Editor');
  }
}

/** สำหรับฟังก์ชันที่ถูกเรียกจาก time-driven trigger: ตรวจว่า triggerUid มีอยู่จริงในโปรเจกต์ */
function requireOwnerOrTrigger_(e) {
  if (e && e.triggerUid) {
    const uid = String(e.triggerUid);
    const ok = ScriptApp.getProjectTriggers().some(function (t) { return t.getUniqueId() === uid; });
    if (ok) return;
  }
  requireOwner_();
}

/* ============================== Menu: users ============================== */

function menuAddUser() {
  requireOwner_();
  const ui = SpreadsheetApp.getUi();
  const name = promptText_(ui, 'เพิ่มผู้ใช้ (1/3)', 'ชื่อ-นามสกุลของผู้ใช้');
  if (name === null) return;
  if (!name) return ui.alert('กรุณาระบุชื่อ');

  const roleAns = ui.alert('เพิ่มผู้ใช้ (2/3)',
    'ให้ "' + name + '" เป็นผู้ดูแลระบบ (Admin) หรือไม่?\n\nYes = Admin (เห็นประวัติทั้งหมด รูปชำรุด พิมพ์ QR)\nNo = ผู้ตรวจ (Inspector)',
    ui.ButtonSet.YES_NO_CANCEL);
  if (roleAns === ui.Button.CANCEL || roleAns === ui.Button.CLOSE) return;
  const role = roleAns === ui.Button.YES ? ROLE.ADMIN : ROLE.INSPECTOR;

  const pin = promptText_(ui, 'เพิ่มผู้ใช้ (3/3)', 'ตั้ง PIN ตัวเลข 4–6 หลัก (แนะนำ 6 หลัก)');
  if (pin === null) return;
  if (!isValidPin_(pin)) return ui.alert('PIN ต้องเป็นตัวเลข 4–6 หลัก');

  const id = addUser_(name, role, pin);
  ui.alert('เพิ่มผู้ใช้เรียบร้อย',
    'รหัสผู้ใช้: ' + id + '\nชื่อ: ' + name + '\nบทบาท: ' + role + '\n\nแจ้ง PIN ให้ผู้ใช้ทราบโดยตรง (ระบบไม่เก็บ PIN ตัวจริงไว้)',
    ui.ButtonSet.OK);
}

function menuResetPin() {
  requireOwner_();
  const ui = SpreadsheetApp.getUi();
  const users = getUsers_();
  if (!users.length) return ui.alert('ยังไม่มีผู้ใช้ กรุณาเพิ่มผู้ใช้ก่อน');
  const list = users.map(function (u) { return u.id + ' — ' + u.name + (u.active ? '' : ' (ปิดใช้งาน)'); }).join('\n');
  const id = promptText_(ui, 'ตั้ง PIN ใหม่ (1/2)', 'พิมพ์รหัสผู้ใช้:\n\n' + list);
  if (id === null) return;
  const user = users.filter(function (u) { return u.id === id.toUpperCase(); })[0];
  if (!user) return ui.alert('ไม่พบรหัสผู้ใช้ ' + id);
  const pin = promptText_(ui, 'ตั้ง PIN ใหม่ (2/2)', 'PIN ใหม่ของ ' + user.name + ' (ตัวเลข 4–6 หลัก)');
  if (pin === null) return;
  if (!isValidPin_(pin)) return ui.alert('PIN ต้องเป็นตัวเลข 4–6 หลัก');
  setUserPin_(user.id, pin);
  CacheService.getScriptCache().remove('pinlock_' + user.id);
  ui.alert('ตั้ง PIN ใหม่ให้ ' + user.name + ' เรียบร้อย (ปลดล็อกบัญชีแล้ว และ session เดิมของผู้ใช้นี้ถูกยกเลิก)');
}

function promptText_(ui, title, message) {
  const res = ui.prompt(title, message, ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return null;
  return res.getResponseText().trim();
}

function addUser_(name, role, pin, forcedId) {
  const sh = sheet_(APP.SHEETS.USERS);
  const id = forcedId || nextUserId_();
  const salt = Utilities.getUuid();
  sh.appendRow([id, safeCell_(cleanText_(name, 100)), role, salt, hashPin_(pin, salt), true, new Date()]);
  invalidateUsers_();
  return id;
}

function setUserPin_(userId, pin) {
  const sh = sheet_(APP.SHEETS.USERS);
  const rows = readRows_(APP.SHEETS.USERS, 1);
  for (let i = 0; i < rows.length; i++) {
    if (str_(rows[i][0]).toUpperCase() === userId) {
      const salt = Utilities.getUuid();
      sh.getRange(i + 2, 4, 1, 2).setValues([[salt, hashPin_(pin, salt)]]);
      invalidateUsers_();
      return true;
    }
  }
  return false;
}

function nextUserId_() {
  let max = 0;
  readRows_(APP.SHEETS.USERS, 1).forEach(function (r) {
    const m = str_(r[0]).match(/^U(\d+)$/i);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return 'U' + String(max + 1).padStart(3, '0');
}
