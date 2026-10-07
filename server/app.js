const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const config = require('./config');
const logger = require('./logger');
const { authenticate } = require('./middleware/auth');
const { HttpError } = require('./utils');
const rateLimit = require('express-rate-limit');
const { createProvider } = require('./payments/provider');
const payments = require('./services/payments');
const authRoutes = require('./routes/auth');
const { router: publicRoutes, me, support } = require('./routes/public');
const manageRoutes = require('./routes/manage');
const { onboarding, admin } = require('./routes/admin');

function createApp(db, { provider = createProvider() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.isProd ? [] : null, // would break plain-http local dev in Safari
      },
    },
    strictTransportSecurity: config.isProd ? undefined : false,
  }));

  // One structured line per request: no bodies, no query strings, no headers.
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    req.id = crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    res.on('finish', () => {
      if (req.path === '/api/health' || req.path === '/health' || /\.(css|js|png|jpe?g|webp|svg|ico|woff2?)$/.test(req.path)) return;
      logger.info('http', { id: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Number((process.hrtime.bigint() - started) / 1000000n), userId: req.user?.id });
    });
    next();
  });

  const pub = path.join(config.ROOT, 'public');

  // ---- tenant addressing -------------------------------------------------------------------------------
  // A restaurant is reachable at /restaurant/<slug>, /r/<slug>, https://<slug>.<TENANT_BASE_DOMAIN>/ or its own
  // custom domain. The tenant is always derived on the server and only ever selects PUBLIC data; private data
  // is scoped by the signed-in user's own restaurant, never by the host or path.
  const RESERVED_SUBDOMAINS = new Set(['www', 'app', 'admin', 'api', 'static', 'assets', 'mail']);
  const platformHost = new URL(config.appUrl).hostname;
  function tenantSlugFromHost(host) {
    if (!host || host === platformHost || host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':')) return null;
    const base = config.tenantBaseDomain;
    if (base && host.endsWith(`.${base}`)) {
      const sub = host.slice(0, -(base.length + 1));
      if (/^[a-z0-9-]{1,48}$/.test(sub) && !RESERVED_SUBDOMAINS.has(sub)) {
        return db.prepare("SELECT slug FROM restaurants WHERE slug = ? AND is_active = 1 AND approval_status = 'approved'").get(sub)?.slug || null;
      }
      return null;
    }
    return db.prepare("SELECT slug FROM restaurants WHERE custom_domain = ? AND is_active = 1 AND approval_status = 'approved'").get(host)?.slug || null;
  }
  const restaurantPage = fs.readFileSync(path.join(pub, 'restaurant.html'), 'utf8');
  const sendRestaurantPage = (res, slug) => {
    // the slug is validated against [a-z0-9-] before it is written into the page
    const safe = /^[a-z0-9-]{1,48}$/.test(slug || '') ? slug : '';
    res.type('html').send(restaurantPage.replace('<!--TENANT-->', safe ? `<meta name="tenant-slug" content="${safe}">` : ''));
  };
  app.use((req, _res, next) => { req.tenantSlug = tenantSlugFromHost(req.hostname); next(); });
  app.get('/', (req, res, next) => (req.tenantSlug ? sendRestaurantPage(res, req.tenantSlug) : next()));

  // ---- platform admin pages: authorised on the BACKEND before any HTML is sent ----------------------------
  const ADMIN_SECTIONS = ['dashboard', 'restaurants', 'users', 'customers', 'orders', 'payments', 'refunds', 'payouts', 'subscriptions', 'plans', 'reconciliation', 'reports', 'support', 'settings', 'audit', 'system', 'security'];
  const pageUser = (req, res, next) => {
    req.db = db;
    authenticate(req, res, (err) => { if (err) req.user = null; next(); });
  };
  app.get('/admin/login', pageUser, (req, res) => (req.user?.role === 'super_admin' ? res.redirect('/admin/dashboard') : res.sendFile(path.join(pub, 'admin-login.html'))));
  app.get(['/admin', '/admin/'], (_req, res) => res.redirect('/admin/dashboard'));
  app.get('/admin.html', (_req, res) => res.redirect(301, '/admin/dashboard'));
  app.get('/admin/:section', pageUser, (req, res, next) => {
    if (!ADMIN_SECTIONS.includes(req.params.section)) return next();
    if (!req.user) return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (req.user.role !== 'super_admin') {
      logger.warn('admin.page_forbidden', { userId: req.user.id, role: req.user.role, ip: req.ip });
      return res.status(403).sendFile(path.join(pub, '403.html'));
    }
    res.set('Cache-Control', 'no-store').sendFile(path.join(pub, 'admin.html'));
  });
  app.get('/admin/:section/:id', pageUser, (req, res, next) => (ADMIN_SECTIONS.includes(req.params.section) ? res.redirect(`/admin/${req.params.section}`) : next()));
  const images = path.join(config.ROOT, 'Images');
  app.use('/Images', express.static(images, { index: false }));
  app.use('/uploads', express.static(config.uploadDir, { index: false }));
  if (config.serveLegacy) {
    // The original static site (sample content), available in development only unless SERVE_LEGACY=1.
    app.use('/legacy/Images', express.static(images, { index: false }));
    app.use('/legacy', express.static(path.join(config.ROOT, 'legacy'), { index: 'home.html' }));
  }
  app.use(express.static(pub, { extensions: ['html'] }));

  // Pretty public URL: /restaurant/<slug> serves the ordering page, which loads data from the API.
  app.get(['/restaurant/:slug', '/r/:slug'], (_req, res) => sendRestaurantPage(res, null));

  // Broad per-IP ceilings protect every endpoint; money-creating calls get a tighter one.
  const limiter = (windowMs, limit, message) => (config.rateLimitEnabled
    ? rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, handler: (rq, _rs, next) => { logger.warn('http.rate_limited', { path: rq.path, ip: rq.ip }); next(new HttpError(429, 'rate_limited', message)); } })
    : (_rq, _rs, next) => next());
  const apiLimiter = limiter(60 * 1000, 300, 'Too many requests. Please slow down.');
  const orderLimiter = limiter(60 * 1000, 20, 'Too many orders in a short time. Please wait a moment.');

  // Payment provider webhooks: no session, no CSRF; authenticity comes from the provider signature + API re-check.
  app.post('/webhooks/:provider', limiter(60 * 1000, 600, 'Too many requests'), express.json({ limit: '200kb' }), async (req, res, next) => {
    try {
      if (req.params.provider !== provider.name) throw new HttpError(404, 'not_found', 'Not found');
      const result = await payments.handleWebhook(db, provider, { headers: req.headers, body: req.body });
      res.status(200).json({ received: true, ...result });
    } catch (e) { next(e); }
  });

  // Liveness/readiness for load balancers and uptime monitors: no auth, no secrets, no configuration values.
  app.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok', database: 'ok', uptimeSeconds: Math.round(process.uptime()) });
    } catch (e) {
      logger.error('health.db_failed', { error: e });
      res.status(503).json({ status: 'unhealthy', database: 'unavailable' });
    }
  });

  const api = express.Router();
  api.use(apiLimiter);
  api.post('/public/restaurants/:slug/orders', orderLimiter);
  api.use(express.json({ limit: '100kb' }));
  api.use((req, _res, next) => { req.db = db; req.provider = provider; next(); });
  api.get('/health', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ data: { status: 'ok', database: 'ok', payments: provider.enabled ? provider.name : 'disabled' } });
    } catch (e) {
      logger.error('health.db_failed', { error: e });
      res.status(503).json({ error: { code: 'unhealthy', message: 'Database unavailable' } });
    }
  });
  api.use(authenticate);
  api.use('/auth', authRoutes);
  api.use('/public', publicRoutes);
  api.use('/me', me);
  api.use('/support', support);
  api.use('/onboarding', onboarding);
  api.use('/manage', manageRoutes);
  // Short aliases for the restaurant's own data (GET /api/orders, /api/products, ...). They run the very same
  // tenant-scoped handlers: the restaurant comes from the signed-in user, never from the URL or body.
  for (const name of ['orders', 'products', 'categories', 'customers', 'payments', 'payouts', 'earnings', 'staff', 'branches', 'subscription']) {
    api.use(`/${name}`, (req, res, next) => { req.url = `/${name}${req.url === '/' ? '' : req.url}`; manageRoutes(req, res, next); });
  }
  api.use('/admin', admin);
  api.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'Endpoint not found')));
  app.use('/api', api);

  app.use((req, res) => res.status(404).sendFile(path.join(pub, '404.html')));

  // Consistent error envelope: { error: { code, message, details? } }
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) {
      if (err.status >= 500) logger.error('http.error', { id: req.id, path: req.path, code: err.code });
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'Request body is not valid JSON' } });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Request body is too large' } });
    if (/SQLITE_CONSTRAINT/.test(err.code || '') || /constraint failed/i.test(err.message || '')) {
      logger.warn('db.constraint', { id: req.id, path: req.path, message: err.message });
      return res.status(409).json({ error: { code: 'conflict', message: 'The request conflicts with existing data' } });
    }
    logger.error('http.unhandled', { id: req.id, path: req.path, error: err });
    res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong on our side', requestId: req.id } });
  });

  return app;
}

module.exports = { createApp };
