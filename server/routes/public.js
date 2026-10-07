const express = require('express');
const config = require('../config');
const { accountStatus } = require('../services/paymentAccounts');
const { requireRole, requireAuth } = require('../middleware/auth');
const { getSubscription, formatPlan } = require('../services/plans');
const { createOrder, changeStatus, formatOrder, loadItems } = require('../services/orders');
const payments = require('../services/payments');
const { withIdempotency } = require('../services/idempotency');
const { isOpenNow } = require('../services/hours');
const { serviceFee, getSetting } = require('../services/platform');
const { HttpError, notFound, str, int, phone, ok } = require('../utils');

const router = express.Router();

// Only public-safe columns are ever returned: no owner email, subscription or settings internals.
const publicRestaurant = (r) => ({
  id: r.id, slug: r.slug, name: r.name, description: r.description, logoUrl: r.logo_url, coverUrl: r.cover_url,
  phone: r.phone, whatsapp: r.whatsapp, address: r.address, city: r.city, currency: r.currency,
  latitude: r.latitude, longitude: r.longitude,
  taxRateBp: r.tax_rate_bp, deliveryFeeCents: r.delivery_fee_cents, minOrderCents: r.min_order_cents,
  openingHours: r.opening_hours ? JSON.parse(r.opening_hours) : null, timezone: r.timezone,
  isOpenNow: isOpenNow(r.opening_hours, r.timezone), isDemo: !!r.is_demo,
});

const LISTED = "r.is_active = 1 AND r.approval_status = 'approved'";

function loadPublicRestaurant(db, slug) {
  const r = db.prepare(`SELECT r.* FROM restaurants r WHERE r.slug = ? AND ${LISTED}`).get(slug);
  if (!r) throw notFound('Restaurant');
  return r;
}

// wa.me click-to-chat needs the international number as digits only: "+966 50 111 2222" / "00966501112222" -> 966501112222
const whatsappDigits = (n) => String(n || '').replace(/[^\d]/g, '').replace(/^00/, '');
const whatsappUrl = (number, text) => {
  const d = whatsappDigits(number);
  return d.length >= 8 ? `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ''}` : null;
};

// Public configuration the frontend needs (never any secret).
router.get('/config', (req, res) => {
  ok(res, {
    currency: config.currency,
    whatsappUrl: whatsappUrl(config.whatsappNumber, 'Hello, I need help with my order.'),
    paymentMethods: { card: req.provider.enabled, cod: true },
    serviceFee: serviceFee(req.db),
    commissionBp: getSetting(req.db, 'commission_bp'),
  });
});

router.get('/plans', (req, res) => {
  const plans = req.db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY sort_order').all();
  ok(res, { plans: plans.map(formatPlan) });
});

router.get('/restaurants', (req, res) => {
  const q = typeof req.query.q === 'string' ? `%${req.query.q.trim().slice(0, 50)}%` : '%';
  const rows = req.db.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM products p WHERE p.restaurant_id = r.id AND p.is_available = 1) AS item_count
     FROM restaurants r JOIN subscriptions s ON s.restaurant_id = r.id
     WHERE ${LISTED} AND s.status IN ('trialing','active','past_due')
       AND (r.name LIKE ? OR r.city LIKE ? OR r.description LIKE ?)
     ORDER BY r.name LIMIT 100`).all(q, q, q);
  ok(res, { restaurants: rows.map((r) => ({ ...publicRestaurant(r), itemCount: r.item_count })) });
});

router.get('/restaurants/:slug', (req, res) => {
  const db = req.db;
  const r = loadPublicRestaurant(db, req.params.slug);
  const sub = getSubscription(db, r.id);
  const categories = db.prepare('SELECT id, name FROM categories WHERE restaurant_id = ? ORDER BY sort_order, name').all(r.id);
  const products = db.prepare(
    `SELECT id, category_id, name, description, price_cents, image_url, is_available
     FROM products WHERE restaurant_id = ? ORDER BY name`).all(r.id);
  const groups = db.prepare('SELECT id, product_id, name, min_select, max_select FROM option_groups WHERE restaurant_id = ? ORDER BY sort_order, id').all(r.id);
  const options = db.prepare('SELECT id, group_id, name, price_cents, is_available FROM options WHERE restaurant_id = ? ORDER BY sort_order, id').all(r.id);
  const acct = db.prepare('SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(r.id);
  const cardReady = req.provider.enabled && (config.payoutMode !== 'provider_settled' || accountStatus(acct) === 'VERIFIED');
  const open = isOpenNow(r.opening_hours, r.timezone);
  ok(res, {
    restaurant: {
      ...publicRestaurant(r),
      acceptingOrders: !!r.accepting_orders && !!sub?.active && open,
      paymentMethods: { card: !!cardReady, cod: true },
    },
    categories,
    products: products.map((p) => ({
      id: p.id, categoryId: p.category_id, name: p.name, description: p.description,
      priceCents: p.price_cents, imageUrl: p.image_url, isAvailable: !!p.is_available,
      optionGroups: groups.filter((g) => g.product_id === p.id).map((g) => ({
        id: g.id, name: g.name, minSelect: g.min_select, maxSelect: g.max_select,
        options: options.filter((o) => o.group_id === g.id).map((o) => ({ id: o.id, name: o.name, priceCents: o.price_cents, isAvailable: !!o.is_available })),
      })),
    })),
    whatsappUrl: whatsappUrl(r.whatsapp || config.whatsappNumber, `Hello ${r.name}, I have a question.`),
  });
});

function parseOrderInput(b) {
  b = b || {};
  if (!Array.isArray(b.items) || b.items.length === 0) throw new HttpError(400, 'validation_error', 'items: add at least one item', { field: 'items' });
  if (b.items.length > 50) throw new HttpError(400, 'validation_error', 'items: too many lines', { field: 'items' });
  const items = b.items.map((l, i) => {
    const optionIds = l?.optionIds === undefined ? [] : l.optionIds;
    if (!Array.isArray(optionIds) || optionIds.length > 30) throw new HttpError(400, 'validation_error', `items[${i}].optionIds: must be a list`, { field: 'items' });
    return {
      productId: int(l?.productId, `items[${i}].productId`, { min: 1 }),
      quantity: int(l?.quantity, `items[${i}].quantity`, { min: 1, max: 50 }),
      optionIds: optionIds.map((o, j) => int(o, `items[${i}].optionIds[${j}]`, { min: 1 })),
    };
  });
  if (!['delivery', 'pickup'].includes(b.orderType)) throw new HttpError(400, 'validation_error', 'orderType: must be delivery or pickup', { field: 'orderType' });
  const paymentMethod = b.paymentMethod ?? 'cod';
  if (!['card', 'cod'].includes(paymentMethod)) throw new HttpError(400, 'validation_error', 'paymentMethod: must be card or cod', { field: 'paymentMethod' });
  const coord = (v, f, max) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > max) throw new HttpError(400, 'validation_error', `${f}: invalid coordinate`, { field: f });
    return v;
  };
  return {
    items, orderType: b.orderType, paymentMethod,
    customerName: str(b.customerName, 'customerName', { max: 100 }),
    customerPhone: phone(b.customerPhone, 'customerPhone'),
    deliveryAddress: b.orderType === 'delivery' ? str(b.deliveryAddress, 'deliveryAddress', { min: 5, max: 300 }) : null,
    latitude: coord(b.latitude, 'latitude', 90), longitude: coord(b.longitude, 'longitude', 180),
    notes: str(b.notes, 'notes', { max: 500, optional: true }),
  };
}

// Place an order. The restaurant is identified by the slug in the URL; the customer by the session.
// Card orders return a provider-hosted checkout URL; the order only becomes visible to the restaurant after
// the provider's payment is verified server-side.
router.post('/restaurants/:slug/orders', requireRole('customer'), async (req, res) => {
  const restaurant = loadPublicRestaurant(req.db, req.params.slug);
  const input = parseOrderInput(req.body);
  const result = await withIdempotency(req.db,
    { userId: req.user.id, scope: `order:${restaurant.id}`, key: req.get('Idempotency-Key'), body: req.body },
    async () => {
      const created = createOrder(req.db, { restaurant, customer: req.user, input, provider: req.provider });
      let paymentUrl = null;
      if (input.paymentMethod === 'card') {
        const customer = req.db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.user.id);
        ({ redirectUrl: paymentUrl } = await payments.startCardPayment(req.db, req.provider, { order: created.order, paymentId: created.paymentId, restaurant, customer }));
      }
      const fresh = req.db.prepare('SELECT * FROM orders WHERE id = ?').get(created.order.id);
      return { status: 201, body: { data: { order: formatOrder(fresh, created.items), paymentUrl } } };
    });
  if (result.replayed) res.set('Idempotent-Replay', 'true');
  res.status(result.status).json(result.body);
});

// ---- the signed-in customer's own orders (scoped by customer_id from the session) ----
const me = express.Router();
me.use(requireRole('customer'));

const ORDER_JOIN = `SELECT o.*, r.name AS restaurant_name, r.slug AS restaurant_slug, r.whatsapp AS restaurant_whatsapp
     FROM orders o JOIN restaurants r ON r.id = o.restaurant_id`;

me.get('/orders', (req, res) => {
  const rows = req.db.prepare(`${ORDER_JOIN} WHERE o.customer_id = ? ORDER BY o.created_at DESC, o.id DESC LIMIT 200`).all(req.user.id);
  ok(res, { orders: rows.map((o) => formatOrder(o)) });
});

function ownOrder(db, id, userId) {
  const o = db.prepare(`${ORDER_JOIN} WHERE o.id = ? AND o.customer_id = ?`).get(Number(id) || 0, userId);
  if (!o) throw notFound('Order');
  return o;
}

me.get('/orders/:id', (req, res) => {
  const o = ownOrder(req.db, req.params.id, req.user.id);
  const history = req.db.prepare('SELECT status, created_at FROM order_status_history WHERE order_id = ? AND restaurant_id = ? ORDER BY id').all(o.id, o.restaurant_id);
  const pay = req.db.prepare('SELECT status, payment_method, refunded_cents FROM payments WHERE order_id = ?').get(o.id);
  ok(res, {
    order: formatOrder(o, loadItems(req.db, o.id, o.restaurant_id)), history,
    payment: pay ? { status: pay.status, method: pay.payment_method, refundedCents: pay.refunded_cents } : null,
    supportUrl: whatsappUrl(config.whatsappNumber, `Hello, I need help with order #${o.order_number} (${o.restaurant_name}).`),
  });
});

// "I have paid" / return from the checkout page: asks the PROVIDER for the truth; the browser's word is never used.
me.post('/orders/:id/refresh-payment', async (req, res) => {
  const o = ownOrder(req.db, req.params.id, req.user.id);
  const pay = req.db.prepare('SELECT id, status, payment_method FROM payments WHERE order_id = ?').get(o.id);
  if (pay && pay.payment_method === 'card' && ['initiated', 'pending'].includes(pay.status)) {
    try { await payments.reconcilePayment(req.db, req.provider, pay.id); } catch { /* provider briefly unavailable: status unchanged */ }
  }
  const fresh = ownOrder(req.db, req.params.id, req.user.id);
  ok(res, { order: formatOrder(fresh) });
});

me.post('/orders/:id/cancel', async (req, res) => {
  const o = ownOrder(req.db, req.params.id, req.user.id);
  const result = changeStatus(req.db, { restaurantId: o.restaurant_id, orderId: o.id, status: 'cancelled', actor: req.user, customerOnly: true, reason: 'Cancelled by customer' });
  await payments.afterStatusChange(req.db, req.provider, result, 'Cancelled by customer');
  ok(res, { order: formatOrder(ownOrder(req.db, req.params.id, req.user.id)) });
});

// ---- support reports (any signed-in user) ----
const support = express.Router();
support.use(requireAuth);
const CATEGORIES = ['restaurant', 'order', 'payment', 'food', 'account', 'other'];

support.post('/reports', (req, res) => {
  const b = req.body || {};
  if (!CATEGORIES.includes(b.category)) throw new HttpError(400, 'validation_error', 'category: choose a valid category', { field: 'category' });
  let orderId = null; let restaurantId = null;
  if (b.orderId !== undefined && b.orderId !== null && b.orderId !== '') {
    orderId = int(b.orderId, 'orderId', { min: 1 });
    // a user can only attach their own orders (IDOR guard)
    const o = req.user.role === 'customer'
      ? req.db.prepare('SELECT id, restaurant_id FROM orders WHERE id = ? AND customer_id = ?').get(orderId, req.user.id)
      : req.db.prepare('SELECT id, restaurant_id FROM orders WHERE id = ? AND restaurant_id = ?').get(orderId, req.user.restaurant_id || 0);
    if (!o) throw new HttpError(400, 'validation_error', 'orderId: order not found', { field: 'orderId' });
    restaurantId = o.restaurant_id;
  }
  const priority = b.category === 'payment' ? 'high' : 'normal';
  const info = req.db.prepare('INSERT INTO reports (user_id, restaurant_id, order_id, category, subject, description, priority) VALUES (?,?,?,?,?,?,?)')
    .run(req.user.id, restaurantId, orderId, b.category, str(b.subject, 'subject', { max: 150 }), str(b.description, 'description', { min: 10, max: 3000 }), priority);
  ok(res, { reportId: Number(info.lastInsertRowid) }, 201);
});

support.get('/reports', (req, res) => {
  const rows = req.db.prepare('SELECT id, order_id, category, subject, status, admin_response, created_at, resolved_at FROM reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  ok(res, { reports: rows.map((r) => ({ id: r.id, orderId: r.order_id, category: r.category, subject: r.subject, status: r.status, adminResponse: r.admin_response, createdAt: r.created_at, resolvedAt: r.resolved_at })) });
});

module.exports = { router, me, support, publicRestaurant, whatsappUrl };
