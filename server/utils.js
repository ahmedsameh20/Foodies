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
function fail(field, message) {
  throw bad(`${field}: ${message}`, { field });
}
function str(value, field, { min = 1, max = 200, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    fail(field, 'is required');
  }
  if (typeof value !== 'string') fail(field, 'must be text');
  const v = value.trim();
  if (!v && optional) return null;
  if (v.length < min) fail(field, min === 1 ? 'is required' : `must be at least ${min} characters`);
  if (v.length > max) fail(field, `must be at most ${max} characters`);
  return v;
}
function int(value, field, { min = 0, max = 1e9, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    fail(field, 'is required');
  }
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n)) fail(field, 'must be a whole number');
  if (n < min || n > max) fail(field, `must be between ${min} and ${max}`);
  return n;
}
function bool(value, field, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    fail(field, 'is required');
  }
  if (typeof value !== 'boolean') fail(field, 'must be true or false');
  return value;
}
function email(value, field = 'email') {
  const v = str(value, field, { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) fail(field, 'is not a valid email address');
  return v;
}
function password(value, field = 'password') {
  if (typeof value !== 'string') fail(field, 'is required');
  if (value.length < 8) fail(field, 'must be at least 8 characters');
  if (Buffer.byteLength(value) > 72) fail(field, 'is too long (max 72 bytes)');
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) fail(field, 'must contain letters and numbers');
  return value;
}
function phone(value, field = 'phone', opts = {}) {
  const v = str(value, field, { max: 30, ...opts });
  if (v !== null && !/^[+\d][\d\s()-]{5,}$/.test(v)) fail(field, 'is not a valid phone number');
  return v;
}
// Only same-origin asset paths or https URLs: blocks javascript:/data: URLs.
function imageUrl(value, field = 'imageUrl') {
  const v = str(value, field, { max: 500, optional: true });
  if (v === null) return null;
  if (/^\/(Images|uploads)\/[^\s"'<>]+$/.test(v) && !v.includes('..')) return v;
  if (/^https:\/\/[^\s"'<>]+$/.test(v)) return v;
  fail(field, 'must be an https URL or an uploaded image path');
}
function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}
const RESERVED_SLUGS = new Set(['admin', 'api', 'login', 'register', 'new', 'restaurants']);

const ok = (res, data, status = 200) => res.status(status).json({ data });

module.exports = {
  HttpError, bad, notFound, forbidden, str, int, bool, email, password, phone,
  imageUrl, slugify, RESERVED_SLUGS, ok,
};
