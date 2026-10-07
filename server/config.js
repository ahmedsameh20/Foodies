const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Load .env if present (Node >= 20.12). Real environment variables win.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(envFile); } catch { /* ignore malformed .env */ }
}

const env = process.env;
const isProd = env.NODE_ENV === 'production';

// AUTH_SECRET is the documented name; JWT_SECRET is accepted as an alias.
let authSecret = env.AUTH_SECRET || env.JWT_SECRET;
const WEAK_SECRETS = new Set(['change-me', 'changeme', 'secret', 'dev-only-insecure-secret-change-me']);
if (!authSecret) {
  if (isProd) throw new Error('AUTH_SECRET must be set in production');
  authSecret = 'dev-only-insecure-secret-change-me';
}
if (isProd && (authSecret.length < 32 || WEAK_SECRETS.has(authSecret.toLowerCase()))) {
  throw new Error('AUTH_SECRET must be set in production to a random string of at least 32 characters');
}

const int = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const port = int(env.PORT, 3000);
const appUrl = (env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, '');
if (isProd && !/^https:\/\//.test(appUrl)) {
  throw new Error('APP_URL must be an https:// URL in production (payment redirects, webhooks and secure cookies depend on it)');
}

// "00966566148975" / "+966 56 614 8975" -> "966566148975" (the wa.me format).
const whatsappDigits = String(env.WHATSAPP_NUMBER || '').replace(/[^\d]/g, '').replace(/^00/, '');

// Tap credentials: TAP_* names are accepted as aliases of the PAYMENT_* ones (PAYMENT_* wins when both are set).
const tapSecretKey = env.PAYMENT_SECRET_KEY || env.TAP_SECRET_KEY || '';
const tapMerchantId = env.PAYMENT_MERCHANT_ID || env.TAP_MERCHANT_ID || '';
const tapWebhookSecret = env.PAYMENT_WEBHOOK_SECRET || env.TAP_WEBHOOK_SECRET || '';
// TAP_SECRET_KEY alone is enough to switch the provider on; an explicit PAYMENT_PROVIDER always wins.
const paymentProvider = (env.PAYMENT_PROVIDER || (env.TAP_SECRET_KEY ? 'tap' : 'none')).toLowerCase();
if (!['none', 'tap'].includes(paymentProvider)) throw new Error(`Unsupported PAYMENT_PROVIDER "${paymentProvider}". Use "tap" or "none".`);
// Sandbox and production credentials must never be mixed: PAYMENT_ENV states which one this deployment uses.
const paymentEnv = (env.PAYMENT_ENV || (isProd ? 'production' : 'sandbox')).toLowerCase();
if (!['sandbox', 'production'].includes(paymentEnv)) throw new Error('PAYMENT_ENV must be "sandbox" or "production"');
if (paymentProvider === 'tap' && tapSecretKey) {
  if (/^sk_live_/.test(tapSecretKey) && paymentEnv !== 'production') throw new Error('A live Tap key (sk_live_) requires PAYMENT_ENV=production');
  if (/^sk_test_/.test(tapSecretKey) && paymentEnv === 'production') throw new Error('A sandbox Tap key (sk_test_) cannot be used with PAYMENT_ENV=production');
}
if (paymentProvider === 'tap' && !tapSecretKey) throw new Error('PAYMENT_PROVIDER=tap requires PAYMENT_SECRET_KEY (or TAP_SECRET_KEY)');

// Database selection: DATABASE_URL=postgres://user:pass@host:5432/db (production, several instances) or
// DATABASE_URL=sqlite:<file> / DATABASE_PATH=<file> (development, single instance). DATABASE_SCHEMA optionally isolates a PostgreSQL schema.
let databasePath = env.DATABASE_PATH || path.join(ROOT, 'data', 'app.db');
let databaseUrl = '';
if (env.DATABASE_URL) {
  const url = env.DATABASE_URL.trim();
  if (/^postgres(ql)?:\/\//i.test(url)) {
    databaseUrl = url;
  } else {
    const m = /^sqlite:(?:\/\/)?(.+)$/i.exec(url);
    if (!m) throw new Error('DATABASE_URL must be postgres://user:password@host:5432/database or sqlite:./data/app.db');
    databasePath = path.resolve(ROOT, m[1]);
  }
}

// All money code assumes 2-decimal minor units (cents). Currencies with 3 decimals (KWD, BHD, OMR, ...) would be mis-scaled.
// Production must choose the currency on purpose (SAR for a Saudi merchant unless the provider confirmed USD in writing).
if (isProd && !env.CURRENCY) throw new Error('CURRENCY must be set explicitly in production (e.g. SAR). Never rely on a default.');
const currency = (env.CURRENCY || 'SAR').toUpperCase();
if (!/^[A-Z]{3}$/.test(currency) || ['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'LYD', 'IQD'].includes(currency)) {
  throw new Error(`CURRENCY "${currency}" is not supported: money is stored as 2-decimal integer minor units`);
}

module.exports = {
  ROOT,
  isProd,
  port,
  appUrl,
  authSecret,
  jwtExpiresIn: env.JWT_EXPIRES_IN || '12h',
  cookieName: 'foodies_session',
  databasePath,
  databaseUrl,
  dbDialect: databaseUrl ? 'postgres' : 'sqlite',
  databaseTarget: databaseUrl || databasePath,
  databaseSchema: env.DATABASE_SCHEMA || null,
  uploadDir: env.UPLOAD_DIR || path.join(ROOT, 'uploads'),
  trustProxy: int(env.TRUST_PROXY, 0),
  rateLimitEnabled: env.RATE_LIMIT !== 'off',
  bcryptRounds: int(env.BCRYPT_ROUNDS, 12),
  logLevel: env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  serveLegacy: env.SERVE_LEGACY === '1' || (!isProd && env.SERVE_LEGACY !== '0'),
  defaultPlan: env.DEFAULT_PLAN || 'free',
  // Subscriptions: days a restaurant keeps access after a renewal invoice is issued and unpaid
  saasGraceDays: int(env.SAAS_GRACE_DAYS, 7),
  // Tenant addressing: with TENANT_BASE_DOMAIN=yourplatform.com, https://<slug>.yourplatform.com serves that restaurant.
  // Path-based addressing (/r/<slug>, /restaurant/<slug>) always works.
  tenantBaseDomain: (env.TENANT_BASE_DOMAIN || '').toLowerCase().replace(/^\.+|\.+$/g, ''),
  // Platform admins must enrol in TOTP two-factor authentication. On by default in production.
  requireAdmin2fa: env.REQUIRE_ADMIN_2FA ? env.REQUIRE_ADMIN_2FA === '1' : isProd,

  // ---- marketplace money settings (initial values; admin can change commission at runtime) ----
  currency,
  commissionBp: int(env.PLATFORM_COMMISSION_BP, 1000),         // 1000 bp = 10.00 %
  commissionFixedCents: int(env.PLATFORM_COMMISSION_FIXED_CENTS, 0),
  minPayoutCents: int(env.MIN_PAYOUT_CENTS, 0),
  serviceFeeBp: int(env.SERVICE_FEE_BP, 0),                    // customer-paid platform fee, % of subtotal
  serviceFeeFixedCents: int(env.SERVICE_FEE_FIXED_CENTS, 0),
  // Provider fee estimate, used for ledger traceability; reconcile against the provider's payout report.
  paymentFeeBp: int(env.PAYMENT_FEE_BP, 0),
  paymentFeeFixedCents: int(env.PAYMENT_FEE_FIXED_CENTS, 0),
  paymentFeeBorneBy: env.PAYMENT_FEE_BORNE_BY === 'restaurant' ? 'restaurant' : 'platform',
  unpaidOrderTtlMinutes: int(env.UNPAID_ORDER_TTL_MINUTES, 30),
  // provider_settled: the provider routes each restaurant's share straight to its connected account;
  // payouts are weekly statements reconciled against the provider.
  // manual_transfer: the platform holds funds and pays restaurants; COD commission is netted off.
  payoutMode: env.PAYOUT_MODE === 'manual_transfer' ? 'manual_transfer' : 'provider_settled',
  weeklyPayoutScheduler: env.WEEKLY_PAYOUT_SCHEDULER !== 'off',

  paymentProvider,
  paymentEnv,
  // Automatic renewal with a saved card (Tap card-on-file). Implemented from Tap's documentation but NOT verified in its sandbox: OFF by default.
  saasAutoRenewal: env.SAAS_AUTO_RENEWAL === 'on',
  payment: {
    secretKey: tapSecretKey,
    publicKey: env.PAYMENT_PUBLIC_KEY || '',
    merchantId: tapMerchantId,
    apiBase: (env.PAYMENT_API_BASE || 'https://api.tap.company/v2').replace(/\/+$/, ''),
    webhookSecret: tapWebhookSecret || tapSecretKey,
  },
  whatsappNumber: whatsappDigits,

  mail: {
    host: env.SMTP_HOST || '',
    port: int(env.SMTP_PORT, 587),
    secure: env.SMTP_SECURE === '1',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || env.SMTP_PASSWORD || '',
    from: env.MAIL_FROM || '',
  },
};
