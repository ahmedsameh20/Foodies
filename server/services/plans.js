const { HttpError } = require('../utils');

// Statuses that grant access to the product. 'cancelled' and 'expired' are read-only: the restaurant can still
// sign in to renew, but its public page stops taking orders.
const ACTIVE_STATUSES = ['trialing', 'active', 'past_due'];

function parseFeatures(s) { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }

function formatPlan(p) {
  return {
    code: p.code, name: p.name, description: p.description,
    priceCents: p.price_cents, currency: p.currency, billingInterval: p.billing_interval || 'month', trialDays: p.trial_days || 0,
    limits: { menuItems: p.max_menu_items, branches: p.max_branches, staff: p.max_staff, ordersPerMonth: p.max_orders_per_month ?? null },
    features: { analytics: !!p.analytics, advancedReports: !!p.advanced_reports },
    highlights: parseFeatures(p.features),
  };
}

// Plan + subscription for a tenant. Always keyed by the server-resolved restaurant id.
function getSubscription(db, restaurantId) {
  const row = db.prepare(
    `SELECT s.id AS subscription_id, s.status, s.provider, s.provider_ref, s.current_period_end, s.price_cents AS sub_price_cents,
            s.currency AS sub_currency, s.billing_interval AS sub_interval, s.start_date, s.end_date, s.trial_end, s.cancelled_at, p.*
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.restaurant_id = ?`).get(restaurantId);
  if (!row) return null;
  return {
    row, plan: formatPlan(row), status: row.status, active: ACTIVE_STATUSES.includes(row.status),
  };
}

const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

// Orders the restaurant has actually received this calendar month (paid card orders and cash orders).
function countMonthlyOrders(db, restaurantId, now = new Date()) {
  return db.prepare(
    `SELECT COUNT(*) c FROM orders WHERE restaurant_id = ? AND created_at >= ? AND (payment_method != 'card' OR paid_at IS NOT NULL)`)
    .get(restaurantId, monthStart(now)).c;
}

function getUsage(db, restaurantId) {
  const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE restaurant_id = ?`).get(restaurantId).c;
  return {
    menuItems: count('products'),
    branches: count('branches'),
    staff: db.prepare("SELECT COUNT(*) c FROM users WHERE restaurant_id = ? AND role = 'staff'").get(restaurantId).c,
    ordersPerMonth: countMonthlyOrders(db, restaurantId),
  };
}

function requireActiveSubscription(sub) {
  if (!sub || !sub.active) {
    throw new HttpError(402, 'subscription_inactive',
      'Your subscription is not active. Open the Subscription page to renew or choose a plan.', { upgrade: true });
  }
}

const LABELS = { menuItems: 'menu items', branches: 'branches', staff: 'staff accounts', ordersPerMonth: 'orders per month' };

// Enforce a numeric limit (null = unlimited). `adding` is how many rows are about to be created.
function enforceLimit(db, restaurantId, key, adding = 1) {
  const sub = getSubscription(db, restaurantId);
  requireActiveSubscription(sub);
  const limit = sub.plan.limits[key];
  if (limit === null || limit === undefined) return;
  const used = getUsage(db, restaurantId)[key];
  if (used + adding > limit) {
    throw new HttpError(402, 'plan_limit_reached',
      `Your ${sub.plan.name} plan allows up to ${limit} ${LABELS[key] || key}. Upgrade your plan to add more.`,
      { limit, used, plan: sub.plan.code, resource: key, upgrade: true });
  }
}

function enforceFeature(db, restaurantId, feature) {
  const sub = getSubscription(db, restaurantId);
  requireActiveSubscription(sub);
  if (!sub.plan.features[feature]) {
    throw new HttpError(402, 'feature_not_in_plan',
      `This feature is not included in the ${sub.plan.name} plan. Upgrade to unlock it.`,
      { feature, plan: sub.plan.code, upgrade: true });
  }
  return sub;
}

// Express middleware factory
const requireFeature = (feature) => (req, _res, next) => {
  try { enforceFeature(req.db, req.restaurant.id, feature); next(); } catch (e) { next(e); }
};

module.exports = {
  formatPlan, getSubscription, getUsage, enforceLimit, enforceFeature, countMonthlyOrders, monthStart,
  requireFeature, requireActiveSubscription, ACTIVE_STATUSES, LABELS,
};
