// TOTP (RFC 6238) two-factor authentication: HMAC-SHA1, 6 digits, 30 s step, compatible with Google Authenticator,
// Microsoft Authenticator, 1Password, Authy etc. Implemented with node:crypto only (no extra dependency).
const crypto = require('node:crypto');
const config = require('../config');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0; let value = 0; const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secretB32, counter) {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1000000).padStart(6, '0');
}

const stepOf = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);
const codeAt = (secretB32, ms = Date.now()) => hotp(secretB32, stepOf(ms));

// Accepts the current step +/- 1 (clock drift). Returns the matched step, or null. A step at or before `lastStep`
// is refused, so a code that was already used (or an older one) can never be replayed.
function verify(secretB32, code, { lastStep = null, now = Date.now() } = {}) {
  if (!/^\d{6}$/.test(String(code || '').trim())) return null;
  const c = Buffer.from(String(code).trim());
  const cur = stepOf(now);
  for (const s of [cur, cur - 1, cur + 1]) {
    const expected = Buffer.from(hotp(secretB32, s));
    if (crypto.timingSafeEqual(expected, c) && (lastStep === null || lastStep === undefined || s > lastStep)) return s;
  }
  return null;
}

const otpauthUri = (email, secretB32, issuer = 'Foodies') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;

// ---- secret at rest: AES-256-GCM, key derived from AUTH_SECRET ----
const key = () => crypto.createHash('sha256').update(`totp-secret-key:${config.authSecret}`).digest();
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function decrypt(blob) {
  const [iv, tag, enc] = blob.split('.').map((x) => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ---- backup codes: shown once, stored only as SHA-256 hashes, single use ----
const hashCode = (c) => crypto.createHash('sha256').update(String(c).trim().toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');
function generateBackupCodes(n = 8) {
  return Array.from({ length: n }, () => {
    const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

module.exports = { generateSecret, codeAt, verify, otpauthUri, encrypt, decrypt, generateBackupCodes, hashCode, base32Encode, base32Decode, stepOf };
