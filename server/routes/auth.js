const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const logger = require('../logger');
const { tx } = require('../db');
const {
  signToken, setSessionCookie, clearSessionCookie, requireAuth, publicUser,
} = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const totp = require('../services/totp');
const { sendMail } = require('../services/mailer');
const { HttpError, str, email, password, phone, ok } = require('../utils');

const router = express.Router();
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', config.bcryptRounds);

const limiter = (max) => (config.rateLimitEnabled
  ? rateLimit({
    windowMs: 15 * 60 * 1000, limit: max, standardHeaders: true, legacyHeaders: false,
    handler: (req, _res, next) => {
      logger.warn('auth.rate_limited', { path: req.path, ip: req.ip });
      next(new HttpError(429, 'rate_limited', 'Too many attempts. Try again in a few minutes.'));
    },
  })
  : (_req, _res, next) => next());
const authLimiter = limiter(30);
const mailLimiter = limiter(10);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createUser(db, { role, name, mail, pass, tel }) {
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(mail)) {
    throw new HttpError(409, 'email_taken', 'An account with this email already exists');
  }
  const hash = bcrypt.hashSync(pass, config.bcryptRounds);
  const info = db.prepare(
    'INSERT INTO users (email, password_hash, name, phone, role) VALUES (?,?,?,?,?)').run(mail, hash, name, tel, role);
  return db.prepare('SELECT id, email, name, phone, role, restaurant_id, token_version, email_verified_at FROM users WHERE id = ?').get(info.lastInsertRowid);
}

// Single-use, expiring token; only its SHA-256 is stored.
function issueToken(db, userId, type, ttlMinutes) {
  const raw = crypto.randomBytes(32).toString('hex');
  db.prepare("UPDATE auth_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ? AND type = ? AND used_at IS NULL").run(userId, type);
  db.prepare('INSERT INTO auth_tokens (user_id, type, token_hash, expires_at) VALUES (?,?,?,?)')
    .run(userId, type, sha256(raw), new Date(Date.now() + ttlMinutes * 60000).toISOString());
  return raw;
}

function consumeToken(db, raw, type) {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) throw new HttpError(400, 'invalid_token', 'This link is invalid or has expired');
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM auth_tokens WHERE token_hash = ? AND type = ?').get(sha256(raw), type);
    if (!row || row.used_at || row.expires_at < new Date().toISOString()) throw new HttpError(400, 'invalid_token', 'This link is invalid or has expired');
    db.prepare("UPDATE auth_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(row.id);
    return row;
  });
}

async function sendVerification(db, user) {
  const raw = issueToken(db, user.id, 'email_verify', 60 * 24);
  const link = `${config.appUrl}/verify-email.html?token=${raw}`;
  await sendMail({ to: user.email, subject: 'Confirm your email address', text: `Hello ${user.name},\n\nConfirm your email address:\n${link}\n\nThis link is valid for 24 hours. If you did not create an account, ignore this message.`, devLink: link });
}

function register(role) {
  return async (req, res) => {
    const b = req.body || {};
    const user = createUser(req.db, {
      role,
      name: str(b.name, 'name', { max: 100 }),
      mail: email(b.email),
      pass: password(b.password),
      tel: b.phone ? phone(b.phone) : null,
    });
    const token = signToken(user);
    setSessionCookie(res, token);
    logger.info('auth.registered', { userId: user.id, role });
    sendVerification(req.db, user).catch((e) => logger.error('auth.verification_mail_failed', { error: e }));
    ok(res, { token, user: publicUser(user) }, 201);
  };
}

// Public registration can only ever create customers or restaurant owners.
// Staff are created by an owner; admins only through `npm run admin:create`.
router.post('/register', authLimiter, register('customer'));
router.post('/register-owner', authLimiter, register('owner'));

router.post('/login', authLimiter, (req, res) => {
  const b = req.body || {};
  const mail = email(b.email);
  if (typeof b.password !== 'string') throw new HttpError(400, 'validation_error', 'password: is required', { field: 'password' });
  const row = req.db.prepare('SELECT * FROM users WHERE email = ?').get(mail);
  // Same message and comparable timing for unknown email and wrong password.
  const valid = bcrypt.compareSync(b.password, row ? row.password_hash : DUMMY_HASH) && !!row;
  if (!valid) {
    logger.warn('auth.login_failed', { ip: req.ip });
    throw new HttpError(401, 'invalid_credentials', 'Incorrect email or password');
  }
  if (!row.is_active) throw new HttpError(403, 'account_disabled', 'This account has been disabled');
  if (row.totp_enabled) {
    // password accepted, second factor still required: no session yet, only a 5-minute challenge token
    const mfaToken = jwt.sign({ sub: row.id, purpose: 'mfa' }, config.authSecret, { expiresIn: '5m' });
    return ok(res, { mfaRequired: true, mfaToken });
  }
  const token = signToken(row);
  setSessionCookie(res, token);
  logger.info('auth.login', { userId: row.id, role: row.role });
  ok(res, { token, user: publicUser(row) });
});

// Signing out revokes every session of this account (token_version bump), not just this browser.
router.post('/logout', (req, res) => {
  if (req.user) {
    req.db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.user.id);
    logger.info('auth.logout', { userId: req.user.id });
  }
  clearSessionCookie(res);
  ok(res, { loggedOut: true });
});

// Second step of sign-in for accounts with 2FA: a TOTP code or a one-time backup code.
router.post('/mfa', authLimiter, (req, res) => {
  let payload;
  try { payload = jwt.verify(String(req.body?.mfaToken || ''), config.authSecret, { algorithms: ['HS256'] }); } catch { payload = null; }
  if (!payload || payload.purpose !== 'mfa') throw new HttpError(401, 'invalid_token', 'Your sign-in session expired. Please sign in again.');
  const row = req.db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
  if (!row || !row.is_active || !row.totp_enabled || !row.totp_secret_enc) throw new HttpError(401, 'invalid_token', 'Please sign in again.');
  if (!consumeSecondFactor(req.db, row, String(req.body?.code || ''))) {
    logger.warn('auth.mfa_failed', { userId: row.id, ip: req.ip });
    throw new HttpError(401, 'invalid_code', 'That code is not valid');
  }
  const token = signToken(row);
  setSessionCookie(res, token);
  logger.info('auth.login', { userId: row.id, role: row.role, mfa: true });
  ok(res, { token, user: publicUser(row) });
});

// A valid TOTP code (each 30 s step usable once) or an unused backup code. Returns true when accepted.
function consumeSecondFactor(db, row, code) {
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) {
    const step = totp.verify(totp.decrypt(row.totp_secret_enc), trimmed, { lastStep: row.totp_last_step });
    if (step === null) return false;
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, row.id);
    return true;
  }
  const hash = totp.hashCode(trimmed);
  const bc = db.prepare('SELECT id FROM backup_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').get(row.id, hash);
  if (!bc) return false;
  db.prepare("UPDATE backup_codes SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(bc.id);
  return true;
}

// ---- 2FA management (platform admins) ----
const adminOnly = (req, _res, next) => (req.user.role === 'super_admin' ? next() : next(new HttpError(403, 'forbidden', 'Two-factor authentication is for platform administrators')));
router.post('/2fa/setup', requireAuth, adminOnly, authLimiter, (req, res) => {
  const row = req.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (row.totp_enabled) throw new HttpError(409, 'already_enabled', 'Two-factor authentication is already enabled');
  const secret = totp.generateSecret();
  req.db.prepare('UPDATE users SET totp_secret_enc = ?, totp_last_step = NULL WHERE id = ?').run(totp.encrypt(secret), row.id);
  ok(res, { secret, otpauthUri: totp.otpauthUri(row.email, secret) });
});

router.post('/2fa/enable', requireAuth, adminOnly, authLimiter, (req, res) => {
  const row = req.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (row.totp_enabled) throw new HttpError(409, 'already_enabled', 'Two-factor authentication is already enabled');
  if (!row.totp_secret_enc) throw new HttpError(409, 'setup_required', 'Start the setup first');
  const step = totp.verify(totp.decrypt(row.totp_secret_enc), String(req.body?.code || ''));
  if (step === null) throw new HttpError(400, 'invalid_code', 'That code is not valid. Check your authenticator app and try again.');
  const codes = totp.generateBackupCodes();
  tx(req.db, () => {
    req.db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ?, token_version = token_version + 1 WHERE id = ?').run(step, row.id);
    req.db.prepare('DELETE FROM backup_codes WHERE user_id = ?').run(row.id);
    const ins = req.db.prepare('INSERT INTO backup_codes (user_id, code_hash) VALUES (?,?)');
    for (const c of codes) ins.run(row.id, totp.hashCode(c));
  });
  const fresh = req.db.prepare('SELECT id, token_version FROM users WHERE id = ?').get(row.id);
  const token = signToken(fresh); // other sessions are revoked; this browser stays signed in
  setSessionCookie(res, token);
  logger.info('auth.2fa_enabled', { userId: row.id });
  ok(res, { enabled: true, backupCodes: codes, token });
});

router.post('/2fa/backup-codes', requireAuth, adminOnly, authLimiter, (req, res) => {
  const row = req.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!row.totp_enabled) throw new HttpError(409, 'not_enabled', 'Two-factor authentication is not enabled');
  if (typeof req.body?.password !== 'string' || !bcrypt.compareSync(req.body.password, row.password_hash)) throw new HttpError(403, 'invalid_credentials', 'Your password is incorrect');
  if (!consumeSecondFactor(req.db, row, String(req.body?.code || ''))) throw new HttpError(400, 'invalid_code', 'That code is not valid');
  const codes = totp.generateBackupCodes();
  tx(req.db, () => {
    req.db.prepare('DELETE FROM backup_codes WHERE user_id = ?').run(row.id);
    const ins = req.db.prepare('INSERT INTO backup_codes (user_id, code_hash) VALUES (?,?)');
    for (const c of codes) ins.run(row.id, totp.hashCode(c));
  });
  ok(res, { backupCodes: codes });
});

router.post('/2fa/disable', requireAuth, adminOnly, authLimiter, (req, res) => {
  const row = req.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!row.totp_enabled) throw new HttpError(409, 'not_enabled', 'Two-factor authentication is not enabled');
  if (typeof req.body?.password !== 'string' || !bcrypt.compareSync(req.body.password, row.password_hash)) throw new HttpError(403, 'invalid_credentials', 'Your password is incorrect');
  if (!consumeSecondFactor(req.db, row, String(req.body?.code || ''))) throw new HttpError(400, 'invalid_code', 'That code is not valid');
  tx(req.db, () => {
    req.db.prepare('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = NULL, token_version = token_version + 1 WHERE id = ?').run(row.id);
    req.db.prepare('DELETE FROM backup_codes WHERE user_id = ?').run(row.id);
  });
  logger.warn('auth.2fa_disabled', { userId: row.id });
  clearSessionCookie(res);
  ok(res, { disabled: true });
});

router.get('/me', requireAuth, (req, res) => ok(res, { user: publicUser(req.user) }));

router.post('/change-password', requireAuth, authLimiter, (req, res) => {
  const b = req.body || {};
  const row = req.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (typeof b.currentPassword !== 'string' || !bcrypt.compareSync(b.currentPassword, row.password_hash)) {
    throw new HttpError(403, 'invalid_credentials', 'Your current password is incorrect');
  }
  const next = password(b.newPassword, 'newPassword');
  req.db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(bcrypt.hashSync(next, config.bcryptRounds), row.id);
  const fresh = req.db.prepare('SELECT id, token_version FROM users WHERE id = ?').get(row.id);
  const token = signToken(fresh);
  setSessionCookie(res, token);
  logger.info('auth.password_changed', { userId: row.id });
  ok(res, { token, changed: true });
});

// Always answers the same way so the endpoint cannot be used to discover which emails have accounts.
router.post('/forgot-password', mailLimiter, async (req, res) => {
  const mail = email(req.body?.email);
  const user = req.db.prepare('SELECT id, name, email, is_active FROM users WHERE email = ?').get(mail);
  if (user && user.is_active) {
    const raw = issueToken(req.db, user.id, 'password_reset', 60);
    const link = `${config.appUrl}/reset-password.html?token=${raw}`;
    await sendMail({ to: user.email, subject: 'Reset your password', text: `Hello ${user.name},\n\nUse this link to choose a new password (valid for 1 hour):\n${link}\n\nIf you did not ask for this, ignore this message.`, devLink: link });
    logger.info('auth.reset_requested', { userId: user.id });
  }
  ok(res, { message: 'If an account exists for that email, a reset link has been sent.' });
});

router.post('/reset-password', mailLimiter, (req, res) => {
  const pass = password(req.body?.password);
  const t = consumeToken(req.db, req.body?.token, 'password_reset');
  req.db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(bcrypt.hashSync(pass, config.bcryptRounds), t.user_id);
  logger.info('auth.password_reset', { userId: t.user_id });
  ok(res, { reset: true });
});

router.post('/verify-email', mailLimiter, (req, res) => {
  const t = consumeToken(req.db, req.body?.token, 'email_verify');
  req.db.prepare("UPDATE users SET email_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND email_verified_at IS NULL").run(t.user_id);
  ok(res, { verified: true });
});

router.post('/resend-verification', requireAuth, mailLimiter, async (req, res) => {
  if (!req.user.email_verified_at) await sendVerification(req.db, req.user);
  ok(res, { sent: true });
});

module.exports = router;
