const express = require('express');
const fs = require('node:fs');
const config = require('../config');
const logger = require('../logger');
const { tx } = require('../db');
const { requireRole } = require('../middleware/auth');
const { STATUSES, formatOrder, loadItems, changeStatus } = require('../services/orders');
const payments = require('../services/payments');
const payouts = require('../services/payouts');
const ledger = require('../services/ledger');
const subscriptions = require('../services/subscriptions');
const { planByCode } = subscriptions;
const { audit, allSettings, setSetting } = require('../services/platform');
const paymentAccounts = require('../services/paymentAccounts');
const finance = require('../services/finance');
const settlements = require('../services/settlements');
const { paymentConfigStatus } = require('../payments/provider');
const { runReport, toCsv, REPORT_TYPES } = require('../services/reports');
const { parseHours, validTimezone } = require('../services/hours');
const {
  HttpError, notFound, str, int, bool, slugify, RESERVED_SLUGS, phone, email, imageUrl, ok,
} = require('../utils');

// ---------- owner onboarding: create the restaurant profile for a freshly registered owner ----------
const onboarding = express.Router();

function uniqueSlug(db, base) {
  let slug = slugify(base) || 'restaurant';
  if (RESERVED_SLUGS.has(slug)) slug += '-restaurant';
  let candidate = slug;
  for (let i = 2; db.prepare('SELECT 1 FROM restaurants WHERE slug = ?').get(candidate); i++) {
    candidate = `${slug}-${i}`;
  }
  return candidate;
}

onboarding.post('/restaurant', requireRole('owner'), (req, res) => {
  if (req.user.restaurant_id) throw new HttpError(409, 'already_onboarded', 'You already have a restaurant');
  const b = req.body || {};
  const tz = b.timezone || 'Asia/Riyadh';
  if (!validTimezone(tz)) throw new HttpError(400, 'validation_error', 'timezone: unknown timezone (e.g. Asia/Riyadh)', { field: 'timezone' });
  const data = {
    name: str(b.name, 'name', { max: 100 }),
    description: str(b.description, 'description', { max: 1000, optional: true }) || '',
    phone: phone(b.phone, 'phone', { optional: true }),
    whatsapp: phone(b.whatsapp, 'whatsapp', { optional: true }),
    email: b.email ? email(b.email) : null,
    address: str(b.address, 'address', { max: 300, optional: true }),
    city: str(b.city, 'city', { max: 100, optional: true }),
    logo: imageUrl(b.logoUrl, 'logoUrl'),
    hours: b.openingHours ? JSON.stringify(parseHours(b.openingHours)) : null,
  };
  const restaurant = tx(req.db, () => {
    const slug = uniqueSlug(req.db, b.slug ? String(b.slug) : data.name);
    // New restaurants wait for platform approval before they appear publicly or take orders. The platform
    // currency is fixed (CURRENCY), so a restaurant cannot choose its own.
    const info = req.db.prepare(
      `INSERT INTO restaurants (slug, name, description, logo_url, phone, whatsapp, email, address, city, currency, timezone, opening_hours, owner_id, approval_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending')`)
      .run(slug, data.name, data.description, data.logo, data.phone, data.whatsapp, data.email, data.address, data.city, config.currency, tz, data.hours, req.user.id);
    const rid = Number(info.lastInsertRowid);
    const wanted = b.planCode ? planByCode(req.db, str(b.planCode, 'planCode', { max: 30 })) : null;
    if (b.planCode && (!wanted || !wanted.is_active)) throw new HttpError(400, 'validation_error', 'planCode: that plan is not available', { field: 'planCode' });
    const plan = wanted || planByCode(req.db, config.defaultPlan) || req.db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY sort_order LIMIT 1').get();
    subscriptions.startSubscription(req.db, rid, plan);
    req.db.prepare('INSERT INTO restaurant_payment_accounts (restaurant_id, payment_provider) VALUES (?,?)').run(rid, config.paymentProvider);
    req.db.prepare('UPDATE users SET restaurant_id = ? WHERE id = ?').run(rid, req.user.id);
    return req.db.prepare('SELECT id, slug, name, approval_status FROM restaurants WHERE id = ?').get(rid);
  });
  logger.info('restaurant.created', { restaurantId: restaurant.id, ownerId: req.user.id });
  ok(res, { restaurant }, 201);
});

// ---------- platform admin ----------
const admin = express.Router();
admin.use(requireRole('super_admin')); // backend authorization: role is read from the database for every request

// Who am I + what the panel needs to decide between "dashboard" and "enrol in 2FA". Exempt from the 2FA gate below.
admin.get('/me', (req, res) => ok(res, {
  user: { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role, totpEnabled: !!req.user.totp_enabled },
  mfaEnrollmentRequired: config.requireAdmin2fa && !req.user.totp_enabled, paymentProvider: config.paymentProvider, currency: config.currency,
}));
admin.use((req, _res, next) => {
  if (config.requireAdmin2fa && !req.user.totp_enabled) {
    return next(new HttpError(403, 'mfa_enrollment_required', 'Two-factor authentication must be enabled for administrator accounts before using the admin API.'));
  }
  next();
});

const page = (req) => {
  const size = Math.min(Math.max(Number(req.query.pageSize) || 25, 1), 100);
  const p = Math.max(Number(req.query.page) || 1, 1);
  return { limit: size, offset: (p - 1) * size, page: p, size };
};
const like = (q) => `%${String(q || '').trim().slice(0, 60).replace(/[%_]/g, (c) => `\\${c}`)}%`;
const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) throw notFound();
  return id;
};
const dateRange = (q) => {
  const f = /^\d{4}-\d{2}-\d{2}$/;
  const from = f.test(q.from || '') ? `${q.from}T00:00:00.000Z` : '1970-01-01T00:00:00.000Z';
  const to = f.test(q.to || '') ? new Date(Date.parse(`${q.to}T00:00:00.000Z`) + 86400000).toISOString() : '2999-01-01T00:00:00.000Z';
  return [from, to];
};

admin.get('/stats', (req, res) => {
  const db = req.db;
  const n = (sql, ...a) => db.prepare(sql).get(...a).c;
  const today = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const valid = "status NOT IN ('cancelled','rejected','awaiting_payment')";
  ok(res, {
    restaurants: n('SELECT COUNT(*) c FROM restaurants'),
    pendingApprovals: n("SELECT COUNT(*) c FROM restaurants WHERE approval_status = 'pending'"),
    activeRestaurants: n("SELECT COUNT(*) c FROM restaurants WHERE is_active = 1 AND approval_status = 'approved'"),
    customers: n("SELECT COUNT(*) c FROM users WHERE role = 'customer'"),
    orders: n("SELECT COUNT(*) c FROM orders WHERE status != 'awaiting_payment'"),
    ordersToday: n("SELECT COUNT(*) c FROM orders WHERE status != 'awaiting_payment' AND created_at >= ?", today),
    gmvCents: n(`SELECT COALESCE(SUM(total_cents),0) c FROM orders WHERE ${valid}`),
    onlineCents: n(`SELECT COALESCE(SUM(total_cents),0) c FROM orders WHERE ${valid} AND payment_method = 'card'`),
    codCents: n(`SELECT COALESCE(SUM(total_cents),0) c FROM orders WHERE ${valid} AND payment_method = 'cod'`),
    commissionCents: n("SELECT COALESCE(SUM(platform_commission_cents + platform_fee_cents),0) c FROM ledger_entries"),
    codCommissionDueCents: n("SELECT COALESCE(-SUM(restaurant_amount_cents),0) c FROM ledger_entries WHERE entry_type = 'cod_commission' AND settled_at IS NULL"),
    pendingPayouts: n("SELECT COUNT(*) c FROM payouts WHERE status IN ('pending','processing')"),
    failedPayouts: n("SELECT COUNT(*) c FROM payouts WHERE status = 'failed'"),
    failedPayments: n("SELECT COUNT(*) c FROM payments WHERE status = 'failed'"),
    openReports: n("SELECT COUNT(*) c FROM reports WHERE status IN ('open','in_progress')"),
    paymentProvider: config.paymentProvider, payoutMode: config.payoutMode, currency: config.currency,
  });
});

// ----- users -----
admin.get('/users', (req, res) => {
  const { limit, offset } = page(req);
  const role = ['customer', 'owner', 'staff', 'super_admin'].includes(req.query.role) ? req.query.role : null;
  const status = req.query.status === 'disabled' ? 0 : req.query.status === 'active' ? 1 : null;
  const q = like(req.query.q);
  const where = "(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\') AND (? IS NULL OR u.role = ?) AND (? IS NULL OR u.is_active = ?)";
  const args = [q, q, role, role, status, status];
  const total = req.db.prepare(`SELECT COUNT(*) c FROM users u WHERE ${where}`).get(...args).c;
  const rows = req.db.prepare(
    `SELECT u.id, u.name, u.email, u.phone, u.role, u.is_active, u.created_at, u.restaurant_id,
            (SELECT COUNT(*) FROM orders o WHERE o.customer_id = u.id AND o.status != 'awaiting_payment') AS orders
     FROM users u WHERE ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  ok(res, { total, users: rows.map((u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, status: u.is_active ? 'active' : 'disabled', restaurantId: u.restaurant_id, orders: u.orders, createdAt: u.created_at })) });
});

admin.get('/users/:id/orders', (req, res) => {
  const id = idParam(req);
  if (!req.db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw notFound('User');
  const rows = req.db.prepare(
    `SELECT o.*, r.name restaurant_name, r.slug restaurant_slug FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
     WHERE o.customer_id = ? AND o.status != 'awaiting_payment' ORDER BY o.created_at DESC LIMIT 100`).all(id);
  ok(res, { orders: rows.map((o) => formatOrder(o)) });
});

admin.patch('/users/:id', (req, res) => {
  const id = idParam(req);
  const active = bool(req.body?.isActive, 'isActive');
  if (id === req.user.id) throw new HttpError(409, 'not_allowed', 'You cannot change your own status');
  const target = req.db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
  if (!target) throw notFound('User');
  // disabling revokes every live session immediately
  req.db.prepare('UPDATE users SET is_active = ?, token_version = token_version + 1 WHERE id = ?').run(active ? 1 : 0, id);
  audit(req.db, req, active ? 'user.enabled' : 'user.disabled', 'user', id, { role: target.role });
  ok(res, { id, status: active ? 'active' : 'disabled' });
});

// ----- restaurants -----
const fmtAdminRestaurant = (r) => ({
  id: r.id, slug: r.slug, name: r.name, city: r.city, phone: r.phone, whatsapp: r.whatsapp, isActive: !!r.is_active, isDemo: !!r.is_demo,
  approvalStatus: r.approval_status, rejectionReason: r.rejection_reason, createdAt: r.created_at,
  commissionBpOverride: r.commission_bp_override, commissionFixedOverride: r.commission_fixed_override, planCode: r.plan_code, planName: r.plan_name, subscriptionStatus: r.sub_status,
  orders: r.orders, menuItems: r.items, ownerEmail: r.owner_email,
});
const RESTAURANT_SELECT = `SELECT r.*, p.name AS plan_name, p.code AS plan_code, s.status AS sub_status,
    (SELECT COUNT(*) FROM orders o WHERE o.restaurant_id = r.id AND o.status != 'awaiting_payment') AS orders,
    (SELECT COUNT(*) FROM products x WHERE x.restaurant_id = r.id) AS items,
    (SELECT email FROM users u WHERE u.restaurant_id = r.id AND u.role = 'owner' LIMIT 1) AS owner_email
  FROM restaurants r LEFT JOIN subscriptions s ON s.restaurant_id = r.id LEFT JOIN plans p ON p.id = s.plan_id`;

admin.get('/restaurants', (req, res) => {
  const { limit, offset } = page(req);
  const q = like(req.query.q);
  const approval = ['pending', 'approved', 'rejected'].includes(req.query.approval) ? req.query.approval : null;
  const where = "(r.name LIKE ? ESCAPE '\\' OR r.city LIKE ? ESCAPE '\\' OR r.slug LIKE ? ESCAPE '\\') AND (? IS NULL OR r.approval_status = ?)";
  const args = [q, q, q, approval, approval];
  const total = req.db.prepare(`SELECT COUNT(*) c FROM restaurants r WHERE ${where}`).get(...args).c;
  const rows = req.db.prepare(`${RESTAURANT_SELECT} WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  ok(res, { total, restaurants: rows.map(fmtAdminRestaurant) });
});

admin.get('/restaurants/:id', (req, res) => {
  const id = idParam(req);
  const r = req.db.prepare(`${RESTAURANT_SELECT} WHERE r.id = ?`).get(id);
  if (!r) throw notFound('Restaurant');
  const acct = req.db.prepare('SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(id);
  const sold = req.db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) gmv, COALESCE(SUM(commission_cents + platform_fee_cents),0) commission FROM orders WHERE restaurant_id = ? AND status NOT IN ('cancelled','rejected','awaiting_payment')").get(id);
  ok(res, {
    restaurant: { ...fmtAdminRestaurant(r), description: r.description, address: r.address, email: r.email, currency: r.currency, taxRateBp: r.tax_rate_bp, deliveryFeeCents: r.delivery_fee_cents, acceptingOrders: !!r.accepting_orders },
    paymentAccount: acct ? {
      provider: acct.payment_provider, connectedAccountId: acct.connected_account_id, onboardingStatus: acct.onboarding_status,
      verificationStatus: acct.verification_status, payoutAccountStatus: acct.payout_account_status, payoutEnabled: !!acct.payout_enabled,
      status: paymentAccounts.accountStatus(acct), maskedBank: acct.masked_bank, settlementCurrency: acct.settlement_currency,
      lastVerifiedAt: acct.last_verified_at, rejectionReason: acct.rejection_reason, applicationSubmittedAt: acct.application_submitted_at,
      application: acct.application_submitted_at ? { legalName: acct.legal_name, registrationNumber: acct.registration_number, contactName: acct.contact_name, contactPhone: acct.contact_phone, contactEmail: acct.contact_email } : null,
    } : null,
    earnings: { ...ledger.restaurantBalance(req.db, id), orders: sold.n, gmvCents: sold.gmv, commissionCents: sold.commission },
    subscription: subscriptions.subscriptionView(req.db, id),
    invoices: req.db.prepare('SELECT * FROM saas_invoices WHERE restaurant_id = ? ORDER BY id DESC LIMIT 10').all(id).map(subscriptions.invoiceView),
    recentOrders: req.db.prepare('SELECT o.* FROM orders o WHERE o.restaurant_id = ? AND (o.payment_method != \'card\' OR o.paid_at IS NOT NULL) ORDER BY o.created_at DESC, o.id DESC LIMIT 10').all(id).map((o) => formatOrder(o)),
    payouts: req.db.prepare('SELECT * FROM payouts WHERE restaurant_id = ? ORDER BY period_start DESC LIMIT 10').all(id)
      .map((p) => ({ id: p.id, amountCents: p.amount_cents, currency: p.currency, status: p.status, periodStart: p.period_start, periodEnd: p.period_end, reference: p.provider_payout_id })),
    reportLast30Days: req.db.prepare("SELECT COUNT(*) orders, COALESCE(SUM(total_cents),0) AS \"revenueCents\" FROM orders WHERE restaurant_id = ? AND status NOT IN ('cancelled','rejected','awaiting_payment') AND (payment_method != 'card' OR paid_at IS NOT NULL) AND created_at >= ?")
      .get(id, new Date(Date.now() - 30 * 86400000).toISOString()),
    staff: req.db.prepare("SELECT id, name, email, is_active FROM users WHERE restaurant_id = ? ORDER BY role, name").all(id).map((u) => ({ id: u.id, name: u.name, email: u.email, isActive: !!u.is_active })),
  });
});

admin.patch('/restaurants/:id', (req, res) => {
  const id = idParam(req);
  const cur = req.db.prepare('SELECT * FROM restaurants WHERE id = ?').get(id);
  if (!cur) throw notFound('Restaurant');
  const b = req.body || {};
  const next = {
    name: b.name !== undefined ? str(b.name, 'name', { max: 100 }) : cur.name,
    description: b.description !== undefined ? (str(b.description, 'description', { max: 1000, optional: true }) || '') : cur.description,
    phone: b.phone !== undefined ? phone(b.phone, 'phone', { optional: true }) : cur.phone,
    whatsapp: b.whatsapp !== undefined ? phone(b.whatsapp, 'whatsapp', { optional: true }) : cur.whatsapp,
    city: b.city !== undefined ? str(b.city, 'city', { max: 100, optional: true }) : cur.city,
    address: b.address !== undefined ? str(b.address, 'address', { max: 300, optional: true }) : cur.address,
    commission: b.commissionBpOverride !== undefined ? (b.commissionBpOverride === null ? null : int(b.commissionBpOverride, 'commissionBpOverride', { max: 10000 })) : cur.commission_bp_override,
    commissionFixed: b.commissionFixedOverride !== undefined ? (b.commissionFixedOverride === null ? null : int(b.commissionFixedOverride, 'commissionFixedOverride', { max: 1e7 })) : cur.commission_fixed_override,
  };
  req.db.prepare('UPDATE restaurants SET name=?, description=?, phone=?, whatsapp=?, city=?, address=?, commission_bp_override=?, commission_fixed_override=? WHERE id=?')
    .run(next.name, next.description, next.phone, next.whatsapp, next.city, next.address, next.commission, next.commissionFixed, id);
  audit(req.db, req, 'restaurant.edited', 'restaurant', id, { fields: Object.keys(b), commissionBpOverride: next.commission, commissionFixedOverride: next.commissionFixed });
  ok(res, { restaurant: fmtAdminRestaurant(req.db.prepare(`${RESTAURANT_SELECT} WHERE r.id = ?`).get(id)) });
});

function restaurantAction(action, fn) {
  admin.post(`/restaurants/:id/${action}`, (req, res) => {
    const id = idParam(req);
    const r = req.db.prepare('SELECT * FROM restaurants WHERE id = ?').get(id);
    if (!r) throw notFound('Restaurant');
    fn(req, r);
    audit(req.db, req, `restaurant.${action}`, 'restaurant', id, { reason: req.body?.reason });
    ok(res, { restaurant: fmtAdminRestaurant(req.db.prepare(`${RESTAURANT_SELECT} WHERE r.id = ?`).get(id)) });
  });
}
restaurantAction('approve', (req, r) => req.db.prepare("UPDATE restaurants SET approval_status = 'approved', rejection_reason = NULL WHERE id = ?").run(r.id));
restaurantAction('reject', (req, r) => {
  const reason = str(req.body?.reason, 'reason', { max: 300 });
  req.db.prepare("UPDATE restaurants SET approval_status = 'rejected', rejection_reason = ? WHERE id = ?").run(reason, r.id);
});
restaurantAction('suspend', (req, r) => {
  str(req.body?.reason, 'reason', { max: 300 });
  tx(req.db, () => {
    req.db.prepare('UPDATE restaurants SET is_active = 0 WHERE id = ?').run(r.id);
    req.db.prepare("UPDATE subscriptions SET status = 'suspended' WHERE restaurant_id = ?").run(r.id);
  });
});
restaurantAction('reactivate', (req, r) => tx(req.db, () => {
  req.db.prepare('UPDATE restaurants SET is_active = 1 WHERE id = ?').run(r.id);
  subscriptions.restoreAfterSuspension(req.db, r.id);
}));

// Link the restaurant to its provider-side sub-merchant (destination) once provider KYC has completed.
admin.put('/restaurants/:id/payment-account', async (req, res) => {
  const id = idParam(req);
  if (!req.db.prepare('SELECT 1 FROM restaurants WHERE id = ?').get(id)) throw notFound('Restaurant');
  const b = req.body || {};
  for (const k of Object.keys(b)) {
    if (/iban|card|cvv|cvc|password|secret|swift|routing|account.?number/i.test(k)) throw new HttpError(400, 'validation_error', 'Bank, card and credential details must never be sent to this platform', { field: k });
  }
  const oneOf = (v, f, list) => { if (!list.includes(v)) throw new HttpError(400, 'validation_error', `${f}: must be one of ${list.join(', ')}`, { field: f }); return v; };
  const connected = b.connectedAccountId === null || b.connectedAccountId === '' ? null : str(b.connectedAccountId, 'connectedAccountId', { max: 100 });
  if (connected && !/^[A-Za-z0-9_-]{3,100}$/.test(connected)) throw new HttpError(400, 'validation_error', 'connectedAccountId: invalid format', { field: 'connectedAccountId' });
  const verification = oneOf(b.verificationStatus ?? 'unverified', 'verificationStatus', ['unverified', 'pending', 'verified', 'rejected']);
  const payoutAccountStatus = oneOf(b.payoutAccountStatus ?? 'inactive', 'payoutAccountStatus', ['inactive', 'active', 'restricted']);
  const payoutEnabled = b.payoutEnabled === undefined ? false : bool(b.payoutEnabled, 'payoutEnabled');
  if (payoutEnabled && !connected) throw new HttpError(400, 'validation_error', 'connectedAccountId: required to enable payouts', { field: 'connectedAccountId' });
  const maskedBank = b.maskedBank ? str(b.maskedBank, 'maskedBank', { max: 20 }) : null;
  if (maskedBank && !/^[*•xX\- ]*\d{2,6}$/.test(maskedBank)) throw new HttpError(400, 'validation_error', 'maskedBank: only a masked display value such as ****1234 is accepted', { field: 'maskedBank' });
  const settlementCurrency = b.settlementCurrency ? str(b.settlementCurrency, 'settlementCurrency', { max: 3 }).toUpperCase() : null;
  if (settlementCurrency && !/^[A-Z]{3}$/.test(settlementCurrency)) throw new HttpError(400, 'validation_error', 'settlementCurrency: ISO code', { field: 'settlementCurrency' });
  // "Verified" and "payouts enabled" may only be recorded when the PROVIDER itself confirmed the destination in this call.
  const claimsVerified = verification === 'verified' || payoutEnabled || payoutAccountStatus === 'active';
  let providerConfirmed = false;
  let destination = null;
  if (connected && req.provider.enabled) {
    try { destination = await req.provider.getConnectedAccount(connected); providerConfirmed = true; } catch (e) {
      throw new HttpError(422, 'destination_not_found', `The payment provider does not recognise this account (${e.message})`);
    }
    // a sandbox destination can never be linked on a production deployment (and vice versa)
    if (destination.liveMode !== undefined && destination.liveMode !== (config.paymentEnv === 'production')) {
      throw new HttpError(422, 'environment_mismatch', `This destination is a ${destination.liveMode ? 'live' : 'sandbox'} account but PAYMENT_ENV is ${config.paymentEnv}`);
    }
  }
  if (claimsVerified && !providerConfirmed) {
    throw new HttpError(409, 'provider_confirmation_required', 'An account can only be marked verified / payout-enabled after the payment provider confirms it. Configure the provider and link a valid account id.');
  }
  const rejection = b.rejectionReason ? str(b.rejectionReason, 'rejectionReason', { max: 300 }) : null;
  const onboarding = oneOf(b.onboardingStatus ?? 'not_started', 'onboardingStatus', ['not_started', 'in_progress', 'completed', 'rejected']);
  if ((onboarding === 'rejected' || verification === 'rejected') && !rejection) throw new HttpError(400, 'validation_error', 'rejectionReason: required when rejecting', { field: 'rejectionReason' });
  const disabled = b.disabled === undefined ? null : bool(b.disabled, 'disabled');
  if (connected && req.db.prepare('SELECT 1 FROM restaurant_payment_accounts WHERE payment_provider = ? AND connected_account_id = ? AND restaurant_id != ?').get(config.paymentProvider, connected, id)) {
    throw new HttpError(409, 'destination_in_use', 'This provider account is already linked to another restaurant');
  }
  tx(req.db, () => {
    req.db.prepare(
      `INSERT INTO restaurant_payment_accounts (restaurant_id, payment_provider, connected_account_id, onboarding_status, verification_status, payout_account_status, payout_enabled,
          masked_bank, settlement_currency, rejection_reason, last_verified_at, disabled_at, provider_wallet_id, provider_business_id, provider_live_mode)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(restaurant_id) DO UPDATE SET payment_provider = excluded.payment_provider, connected_account_id = excluded.connected_account_id,
         onboarding_status = excluded.onboarding_status, verification_status = excluded.verification_status,
         payout_account_status = excluded.payout_account_status, payout_enabled = excluded.payout_enabled,
         masked_bank = excluded.masked_bank, settlement_currency = excluded.settlement_currency, rejection_reason = excluded.rejection_reason,
         last_verified_at = excluded.last_verified_at, disabled_at = excluded.disabled_at,
         provider_wallet_id = excluded.provider_wallet_id, provider_business_id = excluded.provider_business_id, provider_live_mode = excluded.provider_live_mode,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .run(id, config.paymentProvider, connected, onboarding, verification, payoutAccountStatus, payoutEnabled ? 1 : 0, maskedBank, settlementCurrency, rejection,
        providerConfirmed ? new Date().toISOString() : null, disabled ? new Date().toISOString() : null,
        destination?.walletId || null, destination?.businessId || null, destination ? (destination.liveMode ? 1 : 0) : null);
    payouts.promoteEligible(req.db, id);
  });
  audit(req.db, req, 'payment_account.updated', 'restaurant', id, { connected: !!connected, payoutEnabled, verification, providerConfirmed, status: paymentAccounts.accountStatus(req.db.prepare('SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(id)) });
  ok(res, { updated: true, status: paymentAccounts.accountStatus(req.db.prepare('SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(id)) });
});

// Restaurants that asked to start payout onboarding and are waiting for the platform to complete it with the provider.
admin.get('/payment-applications', (req, res) => {
  const rows = req.db.prepare(
    `SELECT a.*, r.name restaurant_name, r.slug FROM restaurant_payment_accounts a JOIN restaurants r ON r.id = a.restaurant_id
     WHERE a.application_submitted_at IS NOT NULL ORDER BY a.application_submitted_at DESC LIMIT 200`).all();
  ok(res, { applications: rows.map((a) => ({
    restaurantId: a.restaurant_id, restaurant: a.restaurant_name, slug: a.slug, status: paymentAccounts.accountStatus(a), submittedAt: a.application_submitted_at,
    legalName: a.legal_name, registrationNumber: a.registration_number, contactName: a.contact_name, contactPhone: a.contact_phone, contactEmail: a.contact_email,
    connected: !!a.connected_account_id,
  })) });
});

// ----- orders -----
admin.get('/orders', (req, res) => {
  const { limit, offset } = page(req);
  const [from, to] = dateRange(req.query);
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  const restaurantId = Number(req.query.restaurantId) > 0 ? Number(req.query.restaurantId) : null;
  const q = like(req.query.q);
  const where = `o.created_at >= ? AND o.created_at < ? AND (? IS NULL OR o.status = ?) AND (? IS NULL OR o.restaurant_id = ?)
     AND (CAST(o.order_number AS TEXT) LIKE ? ESCAPE '\\' OR o.customer_name LIKE ? ESCAPE '\\' OR r.name LIKE ? ESCAPE '\\' OR o.customer_phone LIKE ? ESCAPE '\\')`;
  const args = [from, to, status, status, restaurantId, restaurantId, q, q, q, q];
  const total = req.db.prepare(`SELECT COUNT(*) c FROM orders o JOIN restaurants r ON r.id = o.restaurant_id WHERE ${where}`).get(...args).c;
  const rows = req.db.prepare(
    `SELECT o.*, r.name restaurant_name, r.slug restaurant_slug FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
     WHERE ${where} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  ok(res, { total, orders: rows.map((o) => formatOrder(o)) });
});

admin.get('/orders/:id', (req, res) => {
  const id = idParam(req);
  const o = req.db.prepare('SELECT o.*, r.name restaurant_name, r.slug restaurant_slug FROM orders o JOIN restaurants r ON r.id = o.restaurant_id WHERE o.id = ?').get(id);
  if (!o) throw notFound('Order');
  ok(res, {
    order: { ...formatOrder(o, loadItems(req.db, id, o.restaurant_id)), commissionCents: o.commission_cents, commissionBp: o.commission_bp, restaurantAmountCents: o.restaurant_amount_cents },
    history: req.db.prepare('SELECT status, created_at FROM order_status_history WHERE order_id = ? ORDER BY id').all(id),
    payment: req.db.prepare('SELECT id, provider, provider_transaction_id, payment_method, payment_source, status, amount_cents, refunded_cents, failure_reason FROM payments WHERE order_id = ?').get(id) || null,
    refunds: req.db.prepare('SELECT id, amount_cents, status, reason, provider_refund_id, created_at FROM refunds WHERE order_id = ? ORDER BY id').all(id),
  });
});

admin.post('/orders/:id/cancel', async (req, res) => {
  const id = idParam(req);
  const o = req.db.prepare('SELECT id, restaurant_id FROM orders WHERE id = ?').get(id);
  if (!o) throw notFound('Order');
  const reason = str(req.body?.reason, 'reason', { max: 200 });
  const result = changeStatus(req.db, { restaurantId: o.restaurant_id, orderId: id, status: 'cancelled', actor: req.user, reason });
  await payments.afterStatusChange(req.db, req.provider, result, reason);
  audit(req.db, req, 'order.cancelled', 'order', id, { reason });
  ok(res, { order: formatOrder(req.db.prepare('SELECT * FROM orders WHERE id = ?').get(id)) });
});

// ----- payments & refunds -----
admin.get('/payments', (req, res) => {
  const { limit, offset } = page(req);
  const [from, to] = dateRange(req.query);
  const status = ['initiated', 'pending', 'succeeded', 'failed', 'cancelled', 'cod_pending', 'cash_collected', 'refunded', 'partially_refunded'].includes(req.query.status) ? req.query.status : null;
  const method = ['card', 'cod'].includes(req.query.method) ? req.query.method : null;
  const q = like(req.query.q);
  const where = `p.created_at >= ? AND p.created_at < ? AND (? IS NULL OR p.status = ?) AND (? IS NULL OR p.payment_method = ?)
     AND (COALESCE(p.provider_transaction_id,'') LIKE ? ESCAPE '\\' OR CAST(o.order_number AS TEXT) LIKE ? ESCAPE '\\' OR r.name LIKE ? ESCAPE '\\')`;
  const args = [from, to, status, status, method, method, q, q, q];
  const total = req.db.prepare(`SELECT COUNT(*) c FROM payments p JOIN orders o ON o.id = p.order_id JOIN restaurants r ON r.id = p.restaurant_id WHERE ${where}`).get(...args).c;
  const rows = req.db.prepare(
    `SELECT p.*, o.order_number, r.name restaurant_name FROM payments p JOIN orders o ON o.id = p.order_id JOIN restaurants r ON r.id = p.restaurant_id
     WHERE ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  ok(res, {
    total,
    payments: rows.map((p) => ({
      id: p.id, orderId: p.order_id, orderNumber: p.order_number, restaurant: p.restaurant_name, provider: p.provider, providerRef: p.provider_transaction_id,
      method: p.payment_method, source: p.payment_source, status: p.status, amountCents: p.amount_cents, refundedCents: p.refunded_cents,
      currency: p.currency, failureReason: p.failure_reason, createdAt: p.created_at,
    })),
  });
});

// Re-check a payment with the provider (e.g. a webhook never arrived).
admin.post('/payments/:id/reconcile', async (req, res) => {
  const id = idParam(req);
  if (!req.db.prepare('SELECT 1 FROM payments WHERE id = ?').get(id)) throw notFound('Payment');
  const r = await payments.reconcilePayment(req.db, req.provider, id);
  audit(req.db, req, 'payment.reconciled', 'payment', id, { result: r.status });
  ok(res, r);
});

admin.post('/payments/:id/refund', async (req, res) => {
  const id = idParam(req);
  const key = req.get('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new HttpError(400, 'validation_error', 'Idempotency-Key header (8-100 URL-safe characters) is required for refunds', { field: 'Idempotency-Key' });
  const amountCents = req.body?.amountCents === undefined ? null : int(req.body.amountCents, 'amountCents', { min: 1, max: 1e9 });
  const reason = str(req.body?.reason, 'reason', { max: 300 });
  const { refund, replayed } = await payments.refundPayment(req.db, req.provider, { paymentId: id, amountCents, reason, idempotencyKey: key, actor: req.user });
  if (replayed) res.set('Idempotent-Replay', 'true');
  ok(res, { refund: { id: refund.id, amountCents: refund.amount_cents, status: refund.status, reason: refund.reason, providerRefundId: refund.provider_refund_id, failureReason: refund.failure_reason } }, replayed ? 200 : 201);
});

admin.get('/refunds', (req, res) => {
  const status = ['pending', 'succeeded', 'failed'].includes(req.query.status) ? req.query.status : null;
  const rows = req.db.prepare(
    `SELECT f.*, o.order_number, r.name restaurant_name FROM refunds f JOIN orders o ON o.id = f.order_id JOIN restaurants r ON r.id = f.restaurant_id
     WHERE (? IS NULL OR f.status = ?) ORDER BY f.id DESC LIMIT 200`).all(status, status);
  ok(res, { refunds: rows.map((f) => ({ id: f.id, paymentId: f.payment_id, orderNumber: f.order_number, restaurant: f.restaurant_name, amountCents: f.amount_cents, currency: f.currency, status: f.status, reason: f.reason, providerRefundId: f.provider_refund_id, failureReason: f.failure_reason, createdAt: f.created_at })) });
});

// ----- payouts -----
admin.get('/balances', (req, res) => {
  const rows = req.db.prepare("SELECT id, name, currency FROM restaurants WHERE approval_status = 'approved' ORDER BY name LIMIT 500").all();
  ok(res, { balances: rows.map((r) => ({ restaurantId: r.id, restaurant: r.name, currency: r.currency, ...ledger.restaurantBalance(req.db, r.id) })), payoutMode: config.payoutMode });
});

const PAYOUT_STATUSES = ['pending', 'eligible', 'requested', 'processing', 'paid', 'failed', 'cancelled', 'reversed', 'manual_payout'];
const payoutView = (db, p) => {
  const t = db.prepare(`SELECT COALESCE(SUM(CASE WHEN entry_type != 'cod_commission' AND gross_amount_cents > 0 THEN gross_amount_cents END),0) gross,
      COALESCE(SUM(platform_commission_cents + platform_fee_cents),0) commission,
      COALESCE(-SUM(CASE WHEN entry_type = 'refund' THEN gross_amount_cents END),0) refunds FROM ledger_entries WHERE payout_id = ?`).get(p.id);
  const acct = db.prepare('SELECT connected_account_id, masked_bank FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(p.restaurant_id);
  return {
    id: p.id, restaurantId: p.restaurant_id, restaurant: p.restaurant_name, amountCents: p.amount_cents, currency: p.currency, settlementCurrency: p.settlement_currency,
    provider: p.provider, reference: p.provider_payout_id, providerAccountId: acct?.connected_account_id || null, destination: acct?.masked_bank || null,
    periodStart: p.period_start, periodEnd: p.period_end, status: p.status, confirmationSource: p.confirmation_source, failureReason: p.failure_reason,
    grossCents: t.gross, commissionCents: t.commission, refundsCents: t.refunds, netCents: p.amount_cents,
    createdAt: p.created_at, paidAt: p.paid_at, requestedAt: p.requested_at,
  };
};
admin.get('/payouts', (req, res) => {
  const status = PAYOUT_STATUSES.includes(req.query.status) ? req.query.status : null;
  const restaurantId = Number(req.query.restaurantId) > 0 ? Number(req.query.restaurantId) : null;
  const rows = req.db.prepare(
    `SELECT p.*, r.name restaurant_name FROM payouts p JOIN restaurants r ON r.id = p.restaurant_id
     WHERE (? IS NULL OR p.status = ?) AND (? IS NULL OR p.restaurant_id = ?) ORDER BY p.period_start DESC, p.id DESC LIMIT 300`).all(status, status, restaurantId, restaurantId);
  ok(res, { payouts: rows.map((p) => payoutView(req.db, p)), capabilities: { createPayout: req.provider.capabilities?.createPayout || 'NOT_VERIFIED' } });
});

admin.get('/payouts/:id', (req, res) => {
  const id = idParam(req);
  const p = req.db.prepare('SELECT p.*, r.name restaurant_name FROM payouts p JOIN restaurants r ON r.id = p.restaurant_id WHERE p.id = ?').get(id);
  if (!p) throw notFound('Payout');
  ok(res, { payout: payoutView(req.db, p), events: req.db.prepare('SELECT from_status, to_status, source, details, created_at FROM payout_events WHERE payout_id = ? ORDER BY id').all(id) });
});

// Ask the PROVIDER to pay an eligible statement (answers 501 when the adapter cannot do it, e.g. Tap: NOT VERIFIED).
admin.post('/payouts/:id/request', async (req, res) => {
  const p = await payouts.requestPayout(req.db, req.provider, idParam(req), req.user);
  ok(res, { payout: { id: p.id, status: p.status, reference: p.provider_payout_id } });
});

admin.post('/payouts/generate', (req, res) => {
  // weekStart (a Monday, YYYY-MM-DD) selects which week to generate; default is the most recent complete week.
  let now = new Date();
  if (req.body?.weekStart) {
    const d = new Date(`${req.body.weekStart}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.getUTCDay() !== 1) throw new HttpError(400, 'validation_error', 'weekStart: must be a Monday (YYYY-MM-DD)', { field: 'weekStart' });
    now = new Date(d.getTime() + 8 * 86400000); // any moment in the following week yields "the week before"
  }
  ok(res, payouts.generateWeeklyPayouts(req.db, { now, actor: req.user }));
});

admin.patch('/payouts/:id', (req, res) => {
  const id = idParam(req);
  const status = req.body?.status;
  if (!['manual_payout', 'paid', 'failed', 'cancelled', 'pending'].includes(status)) throw new HttpError(400, 'validation_error', 'status: must be manual_payout, paid, failed, cancelled or pending (provider states are set by the provider)', { field: 'status' });
  const p = payouts.updatePayoutStatus(req.db, id, status, {
    reference: req.body?.reference ? str(req.body.reference, 'reference', { max: 120 }) : null,
    failureReason: req.body?.failureReason ? str(req.body.failureReason, 'failureReason', { max: 300 }) : null,
    actor: req.user,
  });
  ok(res, { payout: { id: p.id, status: p.status, reference: p.provider_payout_id, confirmationSource: p.confirmation_source, paidAt: p.paid_at } });
});

admin.post('/restaurants/:id/cod-settlement', (req, res) => {
  const id = idParam(req);
  if (!req.db.prepare('SELECT 1 FROM restaurants WHERE id = ?').get(id)) throw notFound('Restaurant');
  const n = payouts.settleCodCommission(req.db, id, { actor: req.user, note: req.body?.note ? str(req.body.note, 'note', { max: 200 }) : null });
  ok(res, { settledEntries: n });
});

// ----- reports -----
admin.get('/reports/:type', (req, res) => {
  if (!REPORT_TYPES.includes(req.params.type)) throw notFound('Report');
  const report = runReport(req.db, req.params.type, req.query);
  if (req.query.format === 'csv') {
    audit(req.db, req, 'report.exported', 'report', req.params.type, { from: req.query.from, to: req.query.to });
    return res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${req.params.type}-report.csv"`).send(toCsv(report));
  }
  ok(res, report);
});

// ----- support reports -----
admin.get('/support-reports', (req, res) => {
  const status = ['open', 'in_progress', 'resolved', 'closed'].includes(req.query.status) ? req.query.status : null;
  const category = ['restaurant', 'order', 'payment', 'food', 'account', 'other'].includes(req.query.category) ? req.query.category : null;
  const rows = req.db.prepare(
    `SELECT t.*, u.name user_name, u.email user_email, r.name restaurant_name FROM reports t JOIN users u ON u.id = t.user_id LEFT JOIN restaurants r ON r.id = t.restaurant_id
     WHERE (? IS NULL OR t.status = ?) AND (? IS NULL OR t.category = ?)
     ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.created_at DESC LIMIT 200`).all(status, status, category, category);
  ok(res, { reports: rows.map((t) => ({ id: t.id, user: t.user_name, userEmail: t.user_email, restaurant: t.restaurant_name, orderId: t.order_id, category: t.category, subject: t.subject, description: t.description, status: t.status, priority: t.priority, adminResponse: t.admin_response, createdAt: t.created_at, resolvedAt: t.resolved_at })) });
});

admin.patch('/support-reports/:id', (req, res) => {
  const id = idParam(req);
  const cur = req.db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!cur) throw notFound('Report');
  const b = req.body || {};
  const status = b.status === undefined ? cur.status : b.status;
  const priority = b.priority === undefined ? cur.priority : b.priority;
  if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) throw new HttpError(400, 'validation_error', 'status: invalid', { field: 'status' });
  if (!['low', 'normal', 'high', 'urgent'].includes(priority)) throw new HttpError(400, 'validation_error', 'priority: invalid', { field: 'priority' });
  const response = b.adminResponse === undefined ? cur.admin_response : str(b.adminResponse, 'adminResponse', { max: 2000, optional: true });
  req.db.prepare(
    `UPDATE reports SET status = ?, priority = ?, admin_response = ?,
       resolved_at = CASE WHEN ? IN ('resolved','closed') THEN COALESCE(resolved_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE NULL END WHERE id = ?`)
    .run(status, priority, response, status, id);
  audit(req.db, req, 'support_report.updated', 'report', id, { status, priority });
  ok(res, { id, status, priority });
});

// ----- settings & audit -----
admin.get('/settings', (req, res) => ok(res, { settings: allSettings(req.db), payoutSchedule: 'weekly (every Monday 00:00 UTC, previous Monday-Sunday)', refundRules: 'Full or partial, up to the amount paid; commission and restaurant share are reversed in proportion. Paid orders that are cancelled are refunded automatically.', settlementRules: config.payoutMode === 'provider_settled' ? 'The payment provider routes each restaurant share to its account at charge time; statements reconcile that settlement.' : 'The platform holds funds and pays restaurants; commission on cash orders is netted off.', payoutMode: config.payoutMode, paymentProvider: config.paymentProvider, currency: config.currency, paymentFeeBorneBy: config.paymentFeeBorneBy }));

admin.put('/settings', (req, res) => {
  const b = req.body || {};
  const map = { commissionBp: 'commission_bp', commissionFixedCents: 'commission_fixed_cents', minPayoutCents: 'min_payout_cents', serviceFeeBp: 'service_fee_bp', serviceFeeFixedCents: 'service_fee_fixed_cents' };
  const changed = {};
  tx(req.db, () => {
    for (const [k, col] of Object.entries(map)) {
      if (b[k] === undefined) continue;
      const v = int(b[k], k, { max: col.endsWith('_bp') ? 10000 : 1e6 });
      setSetting(req.db, col, v, req.user.id);
      changed[k] = v;
    }
  });
  audit(req.db, req, 'settings.updated', 'settings', null, changed);
  ok(res, { settings: allSettings(req.db) });
});

admin.get('/audit', (req, res) => {
  const rows = req.db.prepare('SELECT a.*, u.email actor_email FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT ?').all(Math.min(Math.max(Number(req.query.limit) || 100, 1), 500));
  ok(res, { entries: rows.map((a) => ({ id: a.id, actor: a.actor_email, role: a.actor_role, action: a.action, targetType: a.target_type, targetId: a.target_id, details: a.details ? JSON.parse(a.details) : null, ip: a.ip, createdAt: a.created_at })) });
});

// ----- dashboard: every number is computed from the database; an empty platform shows zeros -----
const VALID = "status NOT IN ('cancelled','rejected','awaiting_payment') AND (payment_method != 'card' OR paid_at IS NOT NULL)";

function daySeries(db, days, sql, ...args) {
  const since = new Date(Date.now() - (days - 1) * 86400000);
  since.setUTCHours(0, 0, 0, 0);
  const rows = db.prepare(sql).all(since.toISOString(), ...args);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * 86400000).toISOString().slice(0, 10);
    out.push({ day: d, ...(byDay.get(d) || {}) });
  }
  return out;
}

admin.get('/dashboard', (req, res) => {
  const db = req.db;
  const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 180);
  const n = (sql, ...a) => db.prepare(sql).get(...a);
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const rest = n(`SELECT COUNT(*) total,
      SUM(CASE WHEN approval_status = 'approved' AND is_active = 1 THEN 1 ELSE 0 END) active,
      SUM(CASE WHEN approval_status = 'pending' THEN 1 ELSE 0 END) pending,
      SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) suspended FROM restaurants`);
  const orders = n(`SELECT COUNT(*) total, COALESCE(SUM(total_cents),0) gross, COALESCE(SUM(commission_cents + platform_fee_cents),0) platform,
      COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END),0) today, COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END),0) AS month
      FROM orders WHERE ${VALID}`, todayStart, monthStart);
  const earnings = n("SELECT COALESCE(SUM(restaurant_amount_cents),0) s FROM ledger_entries WHERE entry_type != 'cod_commission'").s;
  const payouts = n(`SELECT COALESCE(SUM(CASE WHEN status IN ('pending','processing') THEN amount_cents END),0) AS "pendingCents",
      COALESCE(SUM(CASE WHEN status IN ('pending','processing') THEN 1 END),0) AS "pendingCount",
      COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents END),0) AS "paidCents", COALESCE(SUM(CASE WHEN status = 'paid' THEN 1 END),0) AS "paidCount" FROM payouts`);
  const subs = db.prepare('SELECT status, COUNT(*) c FROM subscriptions GROUP BY status').all();
  const saasRevenue = n("SELECT COALESCE(SUM(amount_cents),0) s FROM saas_invoices WHERE status = 'paid'").s;
  ok(res, {
    currency: config.currency,
    stats: {
      totalRestaurants: rest.total, activeRestaurants: rest.active || 0, pendingRestaurants: rest.pending || 0, suspendedRestaurants: rest.suspended || 0,
      totalCustomers: n("SELECT COUNT(*) c FROM users WHERE role = 'customer'").c,
      totalOrders: orders.total, todaysOrders: orders.today, monthlyOrders: orders.month,
      grossRevenueCents: orders.gross,                     // customer order value
      platformCommissionCents: orders.platform,            // commission + service fees on orders (ledger 1)
      restaurantEarningsCents: earnings,                   // restaurants' share of online sales
      subscriptionRevenueCents: saasRevenue,               // restaurants' SaaS subscriptions (ledger 2, never mixed with the above)
      pendingPayoutsCents: payouts.pendingCents, pendingPayouts: payouts.pendingCount,
      completedPayoutsCents: payouts.paidCents, completedPayouts: payouts.paidCount,
      openReports: n("SELECT COUNT(*) c FROM reports WHERE status IN ('open','in_progress')").c,
      subscriptionsByStatus: Object.fromEntries(subs.map((s) => [s.status, s.c])),
    },
    series: {
      days,
      orders: daySeries(db, days, `SELECT substr(created_at,1,10) AS day, COUNT(*) orders, COALESCE(SUM(total_cents),0) AS "revenueCents",
        COALESCE(SUM(commission_cents + platform_fee_cents),0) AS "commissionCents" FROM orders WHERE ${VALID} AND created_at >= ? GROUP BY day`),
      restaurants: daySeries(db, days, 'SELECT substr(created_at,1,10) AS day, COUNT(*) added FROM restaurants WHERE created_at >= ? GROUP BY day'),
      customers: daySeries(db, days, "SELECT substr(created_at,1,10) AS day, COUNT(*) added FROM users WHERE role = 'customer' AND created_at >= ? GROUP BY day"),
      payouts: daySeries(db, days, "SELECT substr(COALESCE(paid_at, created_at),1,10) AS day, COALESCE(SUM(amount_cents),0) AS \"amountCents\" FROM payouts WHERE status = 'paid' AND COALESCE(paid_at, created_at) >= ? GROUP BY day"),
    },
  });
});

// ----- customers (platform-wide) -----
admin.get('/customers', (req, res) => {
  const { limit, offset } = page(req);
  const q = like(req.query.q);
  const where = "u.role = 'customer' AND (u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')";
  const total = req.db.prepare(`SELECT COUNT(*) c FROM users u WHERE ${where}`).get(q, q).c;
  const rows = req.db.prepare(
    `SELECT u.id, u.name, u.email, u.phone, u.is_active, u.created_at,
       (SELECT COUNT(*) FROM orders o WHERE o.customer_id = u.id AND ${VALID.replace(/status/g, 'o.status').replace(/payment_method/g, 'o.payment_method').replace(/paid_at/g, 'o.paid_at')}) AS orders,
       (SELECT COALESCE(SUM(o.total_cents),0) FROM orders o WHERE o.customer_id = u.id AND ${VALID.replace(/status/g, 'o.status').replace(/payment_method/g, 'o.payment_method').replace(/paid_at/g, 'o.paid_at')}) AS spent,
       (SELECT COUNT(DISTINCT restaurant_id) FROM restaurant_customers rc WHERE rc.user_id = u.id) AS restaurants
     FROM users u WHERE ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`).all(q, q, limit, offset);
  ok(res, { total, customers: rows.map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, status: c.is_active ? 'active' : 'disabled', orders: c.orders, spentCents: c.spent, restaurants: c.restaurants, createdAt: c.created_at })) });
});

// ----- subscriptions & SaaS invoices (restaurant -> platform; separate from order payments) -----
admin.get('/subscriptions', (req, res) => {
  const { limit, offset } = page(req);
  const status = ['trialing', 'active', 'past_due', 'cancelled', 'expired', 'suspended'].includes(req.query.status) ? req.query.status : null;
  const planCode = typeof req.query.plan === 'string' && req.query.plan ? req.query.plan : null;
  const q = like(req.query.q);
  const where = "(r.name LIKE ? ESCAPE '\\' OR r.slug LIKE ? ESCAPE '\\') AND (? IS NULL OR s.status = ?) AND (? IS NULL OR p.code = ?)";
  const args = [q, q, status, status, planCode, planCode];
  const base = 'FROM subscriptions s JOIN restaurants r ON r.id = s.restaurant_id JOIN plans p ON p.id = s.plan_id';
  const total = req.db.prepare(`SELECT COUNT(*) c ${base} WHERE ${where}`).get(...args).c;
  const rows = req.db.prepare(
    `SELECT s.*, r.id AS rid, r.name AS restaurant_name, r.slug, p.code AS plan_code, p.name AS plan_name,
       (SELECT COUNT(*) FROM saas_invoices i WHERE i.restaurant_id = r.id AND i.status = 'open') AS open_invoices
     ${base} WHERE ${where} ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  ok(res, {
    total,
    subscriptions: rows.map((s) => ({
      id: s.id, restaurantId: s.rid, restaurant: s.restaurant_name, slug: s.slug, planCode: s.plan_code, plan: s.plan_name, status: s.status,
      priceCents: s.price_cents, currency: s.currency, billingInterval: s.billing_interval, startDate: s.start_date, endDate: s.end_date,
      trialEnd: s.trial_end, cancelledAt: s.cancelled_at, openInvoices: s.open_invoices,
    })),
  });
});

admin.put('/restaurants/:id/subscription', (req, res) => {
  const id = idParam(req);
  if (!req.db.prepare('SELECT 1 FROM restaurants WHERE id = ?').get(id)) throw notFound('Restaurant');
  const b = req.body || {};
  const plan = req.db.prepare('SELECT * FROM plans WHERE code = ?').get(str(b.planCode, 'planCode', { max: 30 }));
  if (!plan) throw notFound('Plan');
  const status = b.status === undefined ? 'active' : b.status;
  if (!['trialing', 'active', 'past_due', 'cancelled', 'expired', 'suspended'].includes(status)) throw new HttpError(400, 'validation_error', 'status: invalid', { field: 'status' });
  let endDate = null;
  if (b.endDate) {
    endDate = new Date(b.endDate);
    if (Number.isNaN(endDate.getTime())) throw new HttpError(400, 'validation_error', 'endDate: invalid date', { field: 'endDate' });
    endDate = endDate.toISOString();
  }
  subscriptions.assignPlan(req.db, id, plan, { status, endDate });
  audit(req.db, req, 'subscription.assigned', 'restaurant', id, { plan: plan.code, status, endDate });
  ok(res, { subscription: subscriptions.subscriptionView(req.db, id) });
});

admin.get('/invoices', (req, res) => {
  const status = ['open', 'paid', 'void', 'failed'].includes(req.query.status) ? req.query.status : null;
  const rows = req.db.prepare(
    `SELECT i.*, r.name restaurant_name, p.name plan_name FROM saas_invoices i JOIN restaurants r ON r.id = i.restaurant_id JOIN plans p ON p.id = i.plan_id
     WHERE (? IS NULL OR i.status = ?) ORDER BY i.id DESC LIMIT 300`).all(status, status);
  ok(res, { invoices: rows.map((i) => ({ ...subscriptions.invoiceView(i), restaurant: i.restaurant_name, plan: i.plan_name, restaurantId: i.restaurant_id })) });
});

// Manual settlement of a subscription invoice (bank transfer etc.). A reference is mandatory for traceability.
admin.post('/invoices/:id/mark-paid', (req, res) => {
  const id = idParam(req);
  const reference = str(req.body?.reference, 'reference', { max: 120 });
  const r = subscriptions.markInvoicePaid(req.db, id, { provider: 'manual', reference });
  audit(req.db, req, 'invoice.marked_paid', 'invoice', id, { reference });
  ok(res, { invoice: subscriptions.invoiceView(r.invoice), changed: r.changed });
});
admin.post('/invoices/:id/void', (req, res) => {
  const id = idParam(req);
  const inv = req.db.prepare('SELECT status FROM saas_invoices WHERE id = ?').get(id);
  if (!inv) throw notFound('Invoice');
  if (inv.status !== 'open') throw new HttpError(409, 'invalid_transition', `A ${inv.status} invoice cannot be voided`);
  req.db.prepare("UPDATE saas_invoices SET status = 'void' WHERE id = ?").run(id);
  audit(req.db, req, 'invoice.voided', 'invoice', id, {});
  ok(res, { id, status: 'void' });
});

// ----- plans: fully configurable SaaS plans -----
const fmtPlanAdmin = (p) => ({
  code: p.code, name: p.name, description: p.description, priceCents: p.price_cents, currency: p.currency,
  billingInterval: p.billing_interval, trialDays: p.trial_days,
  maxMenuItems: p.max_menu_items, maxBranches: p.max_branches, maxStaff: p.max_staff, maxOrdersPerMonth: p.max_orders_per_month ?? null,
  analytics: !!p.analytics, advancedReports: !!p.advanced_reports, isActive: !!p.is_active, sortOrder: p.sort_order,
  features: (() => { try { return JSON.parse(p.features || '[]'); } catch { return []; } })(),
  restaurants: p.restaurants ?? undefined,
});
admin.get('/plans', (req, res) => ok(res, {
  plans: req.db.prepare('SELECT p.*, (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id = p.id) AS restaurants FROM plans p ORDER BY sort_order, id').all().map(fmtPlanAdmin),
}));

function planFields(b, cur = null) {
  const lim = (v, f, c) => (v === undefined ? c : (v === null || v === '' ? null : int(v, f, { max: 1e9 })));
  const features = b.features === undefined ? (cur ? JSON.parse(cur.features || '[]') : [])
    : (Array.isArray(b.features) && b.features.length <= 20 ? b.features.map((f, i) => str(f, `features[${i}]`, { max: 120 })) : (() => { throw new HttpError(400, 'validation_error', 'features: provide up to 20 short strings', { field: 'features' }); })());
  const interval = b.billingInterval === undefined ? (cur?.billing_interval || 'month') : b.billingInterval;
  if (!['month', 'year'].includes(interval)) throw new HttpError(400, 'validation_error', 'billingInterval: month or year', { field: 'billingInterval' });
  return {
    name: b.name !== undefined ? str(b.name, 'name', { max: 50 }) : cur?.name,
    description: b.description !== undefined ? (str(b.description, 'description', { max: 300, optional: true }) || '') : (cur?.description ?? ''),
    price: b.priceCents !== undefined ? int(b.priceCents, 'priceCents', { max: 1e8 }) : (cur?.price_cents ?? 0),
    currency: b.currency !== undefined ? str(b.currency, 'currency', { min: 3, max: 3 }).toUpperCase() : (cur?.currency || config.currency),
    interval,
    trial: b.trialDays !== undefined ? int(b.trialDays, 'trialDays', { max: 365 }) : (cur?.trial_days ?? 0),
    items: lim(b.maxMenuItems, 'maxMenuItems', cur?.max_menu_items ?? null),
    branches: lim(b.maxBranches, 'maxBranches', cur?.max_branches ?? null),
    staff: lim(b.maxStaff, 'maxStaff', cur?.max_staff ?? null),
    orders: lim(b.maxOrdersPerMonth, 'maxOrdersPerMonth', cur?.max_orders_per_month ?? null),
    analytics: b.analytics !== undefined ? (bool(b.analytics, 'analytics') ? 1 : 0) : (cur?.analytics ?? 0),
    advanced: b.advancedReports !== undefined ? (bool(b.advancedReports, 'advancedReports') ? 1 : 0) : (cur?.advanced_reports ?? 0),
    active: b.isActive !== undefined ? (bool(b.isActive, 'isActive') ? 1 : 0) : (cur?.is_active ?? 1),
    sort: b.sortOrder !== undefined ? int(b.sortOrder, 'sortOrder', { max: 1000 }) : (cur?.sort_order ?? 100),
    features: JSON.stringify(features),
  };
}

admin.post('/plans', (req, res) => {
  const code = str(req.body?.code, 'code', { max: 30 }).toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,29}$/.test(code)) throw new HttpError(400, 'validation_error', 'code: lowercase letters, digits, - or _ (2-30 chars)', { field: 'code' });
  if (req.db.prepare('SELECT 1 FROM plans WHERE code = ?').get(code)) throw new HttpError(409, 'duplicate', 'A plan with that code already exists');
  const f = planFields(req.body || {});
  if (!f.name) throw new HttpError(400, 'validation_error', 'name: is required', { field: 'name' });
  req.db.prepare(
    `INSERT INTO plans (code, name, description, price_cents, currency, billing_interval, trial_days, max_menu_items, max_branches, max_staff,
       max_orders_per_month, analytics, advanced_reports, is_active, sort_order, features) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(code, f.name, f.description, f.price, f.currency, f.interval, f.trial, f.items, f.branches, f.staff, f.orders, f.analytics, f.advanced, f.active, f.sort, f.features);
  audit(req.db, req, 'plan.created', 'plan', code, { name: f.name, priceCents: f.price });
  ok(res, { plan: fmtPlanAdmin(req.db.prepare('SELECT * FROM plans WHERE code = ?').get(code)) }, 201);
});

admin.put('/plans/:code', (req, res) => {
  const cur = req.db.prepare('SELECT * FROM plans WHERE code = ?').get(String(req.params.code));
  if (!cur) throw notFound('Plan');
  const f = planFields(req.body || {}, cur);
  req.db.prepare(
    `UPDATE plans SET name=?, description=?, price_cents=?, currency=?, billing_interval=?, trial_days=?, max_menu_items=?, max_branches=?, max_staff=?,
       max_orders_per_month=?, analytics=?, advanced_reports=?, is_active=?, sort_order=?, features=? WHERE code=?`)
    .run(f.name, f.description, f.price, f.currency, f.interval, f.trial, f.items, f.branches, f.staff, f.orders, f.analytics, f.advanced, f.active, f.sort, f.features, cur.code);
  audit(req.db, req, 'plan.edited', 'plan', cur.code, { fields: Object.keys(req.body || {}) });
  ok(res, { plan: fmtPlanAdmin(req.db.prepare('SELECT * FROM plans WHERE code = ?').get(cur.code)) });
});

// ----- payment settings (read-only: secrets live in the environment and are never shown) -----
function paymentHealth(req) {
  const cfg = paymentConfigStatus();
  const caps = req.provider.capabilities || {};
  const recentWebhooks = req.db.prepare("SELECT status, COUNT(*) n FROM webhook_events WHERE received_at >= ? GROUP BY status").all(new Date(Date.now() - 86400000).toISOString());
  const failed = recentWebhooks.find((x) => x.status === 'failed')?.n || 0;
  const lastOk = req.db.prepare("SELECT received_at FROM webhook_events WHERE status = 'processed' ORDER BY id DESC LIMIT 1").get()?.received_at || null;
  const lvl = (k) => caps[k] || 'NOT_VERIFIED';
  return {
    provider: config.paymentProvider, environment: config.paymentEnv, configuration: cfg.state, missing: cfg.missing, currency: config.currency,
    providerConnected: req.provider.enabled ? 'CONFIGURED' : 'NOT_CONFIGURED',   // a credential check against the provider is only possible in the sandbox run
    webhook: { url: `${config.appUrl}/webhooks/${config.paymentProvider === 'none' ? '<provider>' : config.paymentProvider}`, status: !req.provider.enabled ? 'NOT_CONFIGURED' : failed ? 'ERROR' : lastOk ? 'HEALTHY' : 'NO_EVENTS_YET', failedLast24h: failed, lastProcessedAt: lastOk },
    marketplace: req.provider.enabled && lvl('splitPayments') !== 'NOT_SUPPORTED' ? lvl('splitPayments') : 'NOT_AVAILABLE',
    restaurantPayouts: { automated: lvl('createPayout'), providerSettled: config.payoutMode === 'provider_settled', manualFallback: 'AVAILABLE' },
    subscriptionBilling: { hostedCheckout: req.provider.enabled ? lvl('createCheckout') : 'NOT_AVAILABLE', recurringTokenisation: lvl('createSubscription') },
    paymentMethods: { cardsViaHostedCheckout: req.provider.enabled ? 'depends on the merchant account (not verified)' : 'NOT_AVAILABLE', mada: lvl('mada'), applePay: lvl('applePay'), googlePay: lvl('googlePay'), cash: 'AVAILABLE' },
    usdSettlement: lvl('usdSettlement'),
    // evidence, not marketing: the payment sources Tap actually reported on completed payments
    observedPaymentSources: req.db.prepare("SELECT payment_source source, COUNT(*) n FROM payments WHERE payment_source IS NOT NULL AND status IN ('succeeded','refunded','partially_refunded') GROUP BY payment_source ORDER BY n DESC LIMIT 20").all(),
    settlementModel: config.payoutMode === 'provider_settled' ? 'TAP_SETTLEMENT (Tap pays the restaurant bank; no payout API)' : 'PLATFORM_PAYOUT (manual)',
    accountStatusApi: caps.getAccountStatus || 'NOT_VERIFIED', payoutWebhooks: caps.payoutWebhooks || 'NOT_VERIFIED',
    autoRenewal: config.saasAutoRenewal ? 'ENABLED_UNVERIFIED' : 'OFF',
    sandbox: config.paymentEnv === 'sandbox' && req.provider.enabled ? 'CONFIGURED_NOT_TESTED' : 'NOT_CONNECTED',
    production: config.paymentEnv === 'production' && cfg.state === 'CONFIGURED' ? 'CONFIGURED' : 'NOT_CONFIGURED',
    capabilities: caps,
  };
}
admin.get('/payment-settings', (req, res) => ok(res, { payments: paymentHealth(req) }));

// Pull what Tap says it settled (read-only) and match it to restaurants by wallet id.
admin.post('/settlements/sync', async (req, res) => ok(res, { sync: await settlements.syncSettlements(req.db, req.provider, { actor: req.user }) }));

// Admin finance table: earnings (platform ledger) next to the provider identifiers and what Tap reports as settled.
// Destination / payment / settlement ids are admin-only; amounts are integer cents except Tap-reported settlement text.
admin.get('/finance/restaurants', (req, res) => {
  const rows = req.db.prepare("SELECT id, name, currency FROM restaurants WHERE approval_status = 'approved' ORDER BY name LIMIT 500").all();
  ok(res, { settlementModel: config.payoutMode === 'provider_settled' ? 'TAP_SETTLEMENT' : 'PLATFORM_PAYOUT', restaurants: rows.map((r) => {
    const acct = req.db.prepare('SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(r.id);
    const st = paymentAccounts.accountStatus(acct);
    const f = finance.restaurantFinance(req.db, r);
    const lastPay = req.db.prepare("SELECT provider_transaction_id id FROM payments WHERE restaurant_id = ? AND payment_method = 'card' AND provider_transaction_id IS NOT NULL ORDER BY id DESC LIMIT 1").get(r.id);
    const lastSet = req.db.prepare('SELECT provider_payout_id id, status, currency, amount_text FROM provider_settlements WHERE restaurant_id = ? ORDER BY COALESCE(payout_date, first_seen_at) DESC, id DESC LIMIT 1').get(r.id);
    return {
      restaurantId: r.id, restaurant: r.name, currency: r.currency,
      grossSalesCents: f.totalSalesCents, commissionCents: f.platformFeesCents, refundsCents: f.refundsCents, netEarningsCents: f.netEarningsCents,
      destinationId: acct?.connected_account_id || null, accountStatus: st,
      settlementStatus: settlements.settlementState(req.db, r.id, st), settlementCurrency: acct?.settlement_currency || lastSet?.currency || null,
      lastTapPaymentId: lastPay?.id || null, lastTapSettlementId: lastSet?.id || null, lastTapSettlementAmount: lastSet?.amount_text || null,
    };
  }) });
});

// ----- reconciliation: platform database vs payment provider -----
admin.post('/reconciliation/run', async (req, res) => {
  const days = Math.min(Math.max(Number(req.body?.days) || 7, 1), 90);
  ok(res, { reconciliation: await finance.reconcile(req.db, req.provider, { days, actor: req.user }) });
});

// ----- refund a paid SaaS invoice (restaurant -> platform ledger) -----
admin.post('/invoices/:id/refund', async (req, res) => {
  const id = idParam(req);
  const key = req.get('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new HttpError(400, 'validation_error', 'Idempotency-Key header (8-100 URL-safe characters) is required for refunds', { field: 'Idempotency-Key' });
  const amountCents = req.body?.amountCents === undefined ? null : int(req.body.amountCents, 'amountCents', { min: 1, max: 1e9 });
  const { refund, replayed } = await subscriptions.refundInvoice(req.db, req.provider, { invoiceId: id, amountCents, reason: str(req.body?.reason, 'reason', { max: 300 }), idempotencyKey: key, actor: req.user });
  if (replayed) res.set('Idempotent-Replay', 'true');
  ok(res, { refund: { id: refund.id, amountCents: refund.amount_cents, status: refund.status, providerRefundId: refund.provider_refund_id } }, replayed ? 200 : 201);
});

// ----- system health -----
admin.get('/system', (req, res) => {
  const db = req.db;
  const n = (sql, ...a) => db.prepare(sql).get(...a).c;
  let dbBytes = null;
  try {
    if (db.dialect === 'postgres') dbBytes = Number(db.prepare('SELECT pg_database_size(current_database()) AS b').get().b);
    else if (config.databasePath !== ':memory:') dbBytes = fs.statSync(config.databasePath).size;
  } catch { /* size unavailable */ }
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  ok(res, {
    status: 'ok',
    node: process.version, uptimeSeconds: Math.round(process.uptime()), environment: config.isProd ? 'production' : 'development',
    appUrl: config.appUrl, tenantBaseDomain: config.tenantBaseDomain || null,
    database: {
      engine: db.dialect === 'postgres' ? 'postgresql' : 'sqlite', multiInstanceSafe: db.dialect === 'postgres', sizeBytes: dbBytes, migrations: db.prepare('SELECT name, applied_at FROM schema_migrations ORDER BY name').all(),
      recommendation: db.dialect === 'postgres' ? 'PostgreSQL: several app instances may share this database (write transactions are serialised by an advisory lock).' : 'SQLite is suitable for a single instance. Use PostgreSQL (DATABASE_URL=postgres://...) for several app instances, managed backups and scale (see docs/DATABASE.md).',
    },
    payments: { provider: config.paymentProvider, enabled: req.provider.enabled, payoutMode: config.payoutMode, currency: config.currency, ...paymentHealth(req) },
    security: { admin2faRequired: config.requireAdmin2fa, adminsWithout2fa: n("SELECT COUNT(*) c FROM users WHERE role = 'super_admin' AND totp_enabled = 0"), secureCookies: config.isProd },
    email: { configured: Boolean(config.mail.host) },
    jobs: { weeklyPayoutScheduler: config.weeklyPayoutScheduler },
    queues: {
      unpaidCardOrders: n("SELECT COUNT(*) c FROM orders WHERE status = 'awaiting_payment'"),
      pendingRefunds: n("SELECT COUNT(*) c FROM refunds WHERE status = 'pending'"),
      failedRefunds: n("SELECT COUNT(*) c FROM refunds WHERE status = 'failed'"),
      failedWebhooks24h: n("SELECT COUNT(*) c FROM webhook_events WHERE status = 'failed' AND received_at >= ?", dayAgo),
      openInvoices: n("SELECT COUNT(*) c FROM saas_invoices WHERE status = 'open'"),
      failedPayouts: n("SELECT COUNT(*) c FROM payouts WHERE status IN ('failed','reversed')"),
      manualPayouts: n("SELECT COUNT(*) c FROM payouts WHERE status = 'manual_payout'"),
      paymentApplications: n("SELECT COUNT(*) c FROM restaurant_payment_accounts WHERE application_submitted_at IS NOT NULL AND connected_account_id IS NULL"),
    },
    counts: {
      users: n('SELECT COUNT(*) c FROM users'), restaurants: n('SELECT COUNT(*) c FROM restaurants'), orders: n('SELECT COUNT(*) c FROM orders'),
      auditEntries: n('SELECT COUNT(*) c FROM audit_logs'),
    },
  });
});

// ----- restaurant: delete (only when there is no financial history) -----
admin.delete('/restaurants/:id', (req, res) => {
  const id = idParam(req);
  const r = req.db.prepare('SELECT id, name FROM restaurants WHERE id = ?').get(id);
  if (!r) throw notFound('Restaurant');
  const hist = req.db.prepare('SELECT (SELECT COUNT(*) FROM orders WHERE restaurant_id = ?) o, (SELECT COUNT(*) FROM saas_invoices WHERE restaurant_id = ? AND status = \'paid\') i').get(id, id);
  if (hist.o || hist.i) {
    throw new HttpError(409, 'has_history', 'This restaurant has orders or paid invoices, which must be kept for accounting. Suspend it instead.', { orders: hist.o, paidInvoices: hist.i });
  }
  tx(req.db, () => {
    req.db.prepare("DELETE FROM users WHERE restaurant_id = ? AND role = 'staff'").run(id);
    req.db.prepare("UPDATE users SET restaurant_id = NULL WHERE restaurant_id = ? AND role = 'owner'").run(id); // the owner account is kept
    req.db.prepare('DELETE FROM restaurants WHERE id = ?').run(id);
  });
  audit(req.db, req, 'restaurant.deleted', 'restaurant', id, { name: r.name });
  ok(res, { deleted: true });
});

module.exports = { onboarding, admin };
