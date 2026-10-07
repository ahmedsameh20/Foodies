const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../logger');
const { HttpError, forbidden } = require('../utils');

// The token carries only the user id and a session version. Role, tenant and active state are always read
// from the database, and bumping users.token_version (logout, password change/reset) revokes every session.
function signToken(user) {
  return jwt.sign({ sub: user.id, tv: user.token_version || 0 }, config.authSecret, { expiresIn: config.jwtExpiresIn });
}

const COOKIE_MAX_AGE_MS = 12 * 3600 * 1000;
function setSessionCookie(res, token) {
  res.cookie(config.cookieName, token, {
    httpOnly: true, secure: config.isProd, sameSite: 'lax', path: '/', maxAge: COOKIE_MAX_AGE_MS,
  });
}
const clearSessionCookie = (res) => res.clearCookie(config.cookieName, { httpOnly: true, secure: config.isProd, sameSite: 'lax', path: '/' });

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

// CSRF defence for cookie-authenticated, state-changing requests: the browser must prove the request
// originated from this site (Origin / Sec-Fetch-Site). Bearer-token API clients are not CSRF-able.
function sameSiteRequest(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === new URL(config.appUrl).host || new URL(origin).host === req.headers.host; } catch { return false; }
}

// Populates req.user when a valid session is present. An invalid, expired or revoked session is NOT an error here:
// the request simply continues as anonymous (and the stale cookie is cleared), so public endpoints - above all the
// sign-in form - keep working. Protected routes answer 401 through requireAuth.
function authenticate(req, res, next) {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const cookieToken = bearer ? null : readCookie(req, config.cookieName);
  const token = bearer ? bearer[1] : cookieToken;
  if (!token) return next();
  const invalid = () => {
    req.invalidSession = true;
    if (cookieToken && res && typeof res.clearCookie === 'function') clearSessionCookie(res);
    next();
  };
  let payload;
  try {
    payload = jwt.verify(token, config.authSecret, { algorithms: ['HS256'] });
  } catch {
    return invalid();
  }
  // a short-lived 2FA challenge token is NOT a session
  if (payload.purpose) return invalid();
  const user = req.db.prepare(
    'SELECT id, email, name, phone, role, restaurant_id, is_active, token_version, email_verified_at, totp_enabled FROM users WHERE id = ?').get(payload.sub);
  if (!user || !user.is_active || (user.token_version || 0) !== (payload.tv || 0)) return invalid();
  // CSRF defence for cookie-authenticated, state-changing requests (checked only for a VALID session)
  if (cookieToken && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameSiteRequest(req)) {
    logger.warn('auth.csrf_blocked', { path: req.path, ip: req.ip });
    return next(new HttpError(403, 'csrf_blocked', 'Cross-site request blocked'));
  }
  req.user = user;
  req.authVia = bearer ? 'bearer' : 'cookie';
  next();
}

function requireAuth(req, _res, next) {
  if (!req.user) {
    return next(req.invalidSession
      ? new HttpError(401, 'invalid_token', 'Your session has expired. Please sign in again.')
      : new HttpError(401, 'unauthenticated', 'Please sign in to continue.'));
  }
  next();
}

const requireRole = (...roles) => (req, res, next) => {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (!roles.includes(req.user.role)) {
      logger.warn('auth.forbidden', { userId: req.user.id, role: req.user.role, path: req.path });
      return next(forbidden());
    }
    next();
  });
};

// Tenant resolution for /api/manage/*: the restaurant comes from the authenticated
// user's own record - never from the URL, query string or request body.
function tenantContext(req, res, next) {
  requireRole('owner', 'staff')(req, res, (err) => {
    if (err) return next(err);
    if (!req.user.restaurant_id) {
      return next(new HttpError(409, 'onboarding_required', 'Create your restaurant profile to continue.'));
    }
    const restaurant = req.db.prepare('SELECT * FROM restaurants WHERE id = ?').get(req.user.restaurant_id);
    if (!restaurant) return next(new HttpError(409, 'onboarding_required', 'Create your restaurant profile to continue.'));
    req.restaurant = restaurant;
    next();
  });
}

// Used after tenantContext on owner-only manage routes (settings, staff, earnings, reports).
const requireOwner = (req, res, next) => {
  if (req.user.role !== 'owner') return next(forbidden('Only the restaurant owner can do this'));
  next();
};

const publicUser = (u) => ({
  id: u.id, email: u.email, name: u.name, phone: u.phone || null,
  role: u.role, restaurantId: u.restaurant_id || null, emailVerified: Boolean(u.email_verified_at),
  ...(u.role === 'super_admin' ? { totpEnabled: Boolean(u.totp_enabled) } : {}),
});

module.exports = {
  signToken, setSessionCookie, clearSessionCookie, authenticate, requireAuth, requireRole, tenantContext, requireOwner, publicUser,
};
