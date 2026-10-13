class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const bad = (message, details) => new HttpError(400, 'validation_error', message, details);
const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
const forbidden = (message = 'You do not have permission to do this') => new HttpError(403, 'forbidden', message);

// ---- tiny validation helpers; each throws a 400 HttpError with field details ----
// `reason` is a stable machine-readable code the frontend translates (Arabic / English); `extra` carries interpolation values
// (min, max ...). The English `message` stays for API clients and logs.
function fail(field, message, reason, extra) {
  throw bad(`${field}: ${message}`, { field, ...(reason ? { reason } : {}), ...(extra || {}) });
}
function str(value, field, { min = 1, max = 200, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    fail(field, 'is required', 'required');
  }
  if (typeof value !== 'string') fail(field, 'must be text', 'not_text');
  const v = value.trim();
  if (!v && optional) return null;
  if (v.length < min) fail(field, min === 1 ? 'is required' : `must be at least ${min} characters`, min === 1 ? 'required' : 'too_short', { min });
  if (v.length > max) fail(field, `must be at most ${max} characters`, 'too_long', { max });
  return v;
}
function int(value, field, { min = 0, max = 1e9, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    fail(field, 'is required', 'required');
  }
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n)) fail(field, 'must be a whole number', 'not_integer');
  if (n < min || n > max) fail(field, `must be between ${min} and ${max}`, 'out_of_range', { min, max });
  return n;
}
function bool(value, field, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    fail(field, 'is required', 'required');
  }
  if (typeof value !== 'boolean') fail(field, 'must be true or false', 'not_boolean');
  return value;
}
function email(value, field = 'email') {
  const v = str(value, field, { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) fail(field, 'is not a valid email address', 'invalid_email');
  return v;
}
function password(value, field = 'password') {
  if (typeof value !== 'string') fail(field, 'is required', 'required');
  if (value.length < 8) fail(field, 'must be at least 8 characters', 'password_short');
  if (Buffer.byteLength(value) > 72) fail(field, 'is too long (max 72 bytes)', 'password_long');
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) fail(field, 'must contain letters and numbers', 'password_weak');
  return value;
}
function phone(value, field = 'phone', opts = {}) {
  const v = str(value, field, { max: 30, ...opts });
  if (v !== null && !/^[+\d][\d\s()-]{5,}$/.test(v)) fail(field, 'is not a valid phone number', 'invalid_phone');
  return v;
}

// Mobile number of an account holder, stored in international (E.164) form: "+966500000000".
// Accepts what people actually type - spaces, dashes, dots, brackets, Arabic-Indic digits, a leading 00 - and
// normalises it. There is NO local-number guessing: the country code is mandatory so the number is unambiguous.
// This validates FORMAT only. The number is never claimed to be verified (no SMS provider is configured).
const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
function normalizeMobile(raw) {
  let v = String(raw ?? '').trim().replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d]).replace(/[\s().-]/g, '');
  if (v.startsWith('00')) v = `+${v.slice(2)}`;
  return v;
}
function mobile(value, field = 'phone', { optional = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (optional) return null;
    fail(field, 'is required', 'required');
  }
  if (typeof value !== 'string') fail(field, 'must be text', 'not_text');
  const v = normalizeMobile(value);
  if (!/^\+[1-9]\d{7,14}$/.test(v)) fail(field, 'must be a valid mobile number with country code, e.g. +966500000000', 'invalid_mobile');
  return v;
}
// Only same-origin asset paths or https URLs: blocks javascript:/data: URLs.
function imageUrl(value, field = 'imageUrl') {
  const v = str(value, field, { max: 500, optional: true });
  if (v === null) return null;
  if (/^\/(Images|uploads)\/[^\s"'<>]+$/.test(v) && !v.includes('..')) return v;
  if (/^https:\/\/[^\s"'<>]+$/.test(v)) return v;
  fail(field, 'must be an https URL or an uploaded image path', 'invalid_image_url');
}
function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}
const RESERVED_SLUGS = new Set(['admin', 'api', 'login', 'register', 'new', 'restaurants']);

const ok = (res, data, status = 200) => res.status(status).json({ data });

module.exports = {
  HttpError, bad, notFound, forbidden, fail, str, int, bool, email, password, phone, mobile, normalizeMobile,
  imageUrl, slugify, RESERVED_SLUGS, ok,
};
