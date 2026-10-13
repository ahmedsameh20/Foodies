const express = require('express');
const config = require('../config');
const { accountStatus } = require('../services/paymentAccounts');
const { requireRole, requireAuth } = require('../middleware/auth');
const { getSubscription, formatPlan } = require('../services/plans');
const { createOrder, changeStatus, formatOrder, loadItems, quoteCart } = require('../services/orders');
const coupons = require('../services/coupons');
const payments = require('../services/payments');
const { withIdempotency } = require('../services/idempotency');
const { isOpenNow } = require('../services/hours');
const { serviceFee, getSetting } = require('../services/platform');
const catalog = require('../services/catalog');
const discounts = require('../services/discounts');
const inventory = require('../services/inventory');
const { publicBranch } = require('../services/branches');
const { HttpError, notFound, str, int, phone, ok } = require('../utils');

const router = express.Router();

// Only public-safe columns are ever returned: no owner email, subscription or settings internals.
const publicRestaurant = (r) => ({
  id: r.id, slug: r.slug, name: r.name, description: r.description, logoUrl: r.logo_url, coverUrl: r.cover_url,
  nameAr: r.name_ar || '', nameEn: r.name_en || '', descriptionAr: r.description_ar || '', descriptionEn: r.description_en || '',
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
    map: { tileUrl: config.map.tileUrl, attribution: config.map.attribution, addressSearch: !!config.geocoder.url },
  });
});

router.get('/plans', (req, res) => {
  const plans = req.db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY sort_order').all();
  ok(res, { plans: plans.map(formatPlan) });
});

router.get('/restaurants', (req, res) => {
  const q = typeof req.query.q === 'string' ? `%${req.query.q.trim().slice(0, 50)}%` : '%';
  const rows = req.db.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM products p WHERE p.restaurant_id = r.id AND p.is_available = 1 AND (p.track_stock = 0
         OR (p.stock_quantity > 0 AND NOT EXISTS (SELECT 1 FROM branches b WHERE b.restaurant_id = r.id AND b.is_active = 1))
         OR EXISTS (SELECT 1 FROM branch_stock s JOIN branches b ON b.id = s.branch_id WHERE s.product_id = p.id AND s.restaurant_id = r.id AND b.is_active = 1 AND s.is_available = 1 AND s.quantity > 0))) AS item_count
     FROM restaurants r JOIN subscriptions s ON s.restaurant_id = r.id
     WHERE ${LISTED} AND s.status IN ('trialing','active','past_due')
       AND (r.name LIKE ? OR r.city LIKE ? OR r.description LIKE ? OR r.name_ar LIKE ? OR r.name_en LIKE ?)
     ORDER BY r.name LIMIT 100`).all(q, q, q, q, q);
  ok(res, { restaurants: rows.map((r) => ({ ...publicRestaurant(r), itemCount: r.item_count })) });
});

router.get('/restaurants/:slug', (req, res) => {
  const db = req.db;
  const r = loadPublicRestaurant(db, req.params.slug);
  const sub = getSubscription(db, r.id);
  const categories = db.prepare('SELECT id, name, name_ar, name_en, image_url FROM categories WHERE restaurant_id = ? ORDER BY sort_order, name').all(r.id);
  // Branches: stock is per branch. The customer's chosen branch (?branchId=) decides which quantities are shown; a restaurant with a single
  // branch uses it automatically. Without a choice (several branches) an item counts as available when ANY branch can serve it.
  const branches = inventory.activeBranches(db, r.id);
  let branch = null;
  if (req.query.branchId !== undefined) {
    const wanted = Number(req.query.branchId);
    branch = branches.find((b) => b.id === wanted) || null;
    if (!branch && branches.length) throw new HttpError(422, 'invalid_branch', 'That branch is not available for this restaurant', { branchId: wanted });
  } else if (branches.length === 1) [branch] = branches;
  const stockOf = (kind) => {
    if (!branches.length) return null;
    if (branch) return inventory.stockRows(db, r.id, branch.id, kind);
    const best = new Map(); // id -> the row of the branch with the most stock
    for (const b of branches) for (const [id, row] of inventory.stockRows(db, r.id, b.id, kind)) if (!best.has(id) || row.quantity > best.get(id).quantity) best.set(id, row);
    return best;
  };
  const dishStock = stockOf('dish');
  const extraStock = stockOf('extra');
  // a signed-in customer sees the prices THEY would pay (an offer they have already used up is not applied to them)
  const rules = discounts.loadActiveRules(db, r.id, new Date(), { customerId: req.user && req.user.role === 'customer' ? req.user.id : null });
  const products = db.prepare('SELECT * FROM products WHERE restaurant_id = ? ORDER BY name').all(r.id)
    .map((p) => { const priced = discounts.applyToProduct(p, rules); return dishStock ? inventory.atBranch(priced, dishStock.get(p.id)) : priced; });
  const groups = db.prepare('SELECT * FROM option_groups WHERE restaurant_id = ? ORDER BY sort_order, id').all(r.id);
  const options = db.prepare('SELECT * FROM options WHERE restaurant_id = ? ORDER BY sort_order, id').all(r.id);
  // general (order-level) extras the owner has switched on; one that ran out of stock stays listed, flagged as sold out
  const generalExtras = db.prepare(`SELECT * FROM restaurant_extras WHERE restaurant_id = ? AND is_available = 1 ORDER BY ${catalog.EXTRA_ORDER}`).all(r.id)
    .map((x) => (extraStock ? inventory.atBranch(x, extraStock.get(x.id)) : x));
  const acct = db.prepare('SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(r.id);
  const cardReady = req.provider.enabled && (config.payoutMode !== 'provider_settled' || accountStatus(acct) === 'VERIFIED');
  const open = isOpenNow(r.opening_hours, r.timezone);
  ok(res, {
    restaurant: {
      ...publicRestaurant(r),
      acceptingOrders: !!r.accepting_orders && !!sub?.active && open,
      paymentMethods: { card: !!cardReady, cod: true },
    },
    branches: branches.map(publicBranch),
    selectedBranchId: branch ? branch.id : null,
    categories: categories.map((c) => ({ id: c.id, name: c.name, nameAr: c.name_ar || '', nameEn: c.name_en || '', imageUrl: c.image_url || null })),
    // priceCents is what the customer pays; originalPriceCents is only different (and shown struck through) while a discount is active.
    // The server recomputes every amount from its own data when the order is placed - these figures are for display.
    products: products.map((p) => catalog.formatProduct(p, {
      optionGroups: groups.filter((g) => g.product_id === p.id).map((g) => catalog.formatGroup(g, options.filter((o) => o.group_id === g.id))),
    })),
    extras: generalExtras.map(catalog.formatExtra),
    whatsappUrl: whatsappUrl(r.whatsapp || config.whatsappNumber, `Hello ${r.name}, I have a question.`),
  });
});

// Customer-visible limits for one cart line. Prices are NEVER read from the request: only ids, quantities and text.
//   items[]: { productId, quantity, options: [{ optionId, quantity }], optionIds: [id] (legacy, quantity 1 each), instructions }
//   extras[]: { extraId, quantity }   general extras, independent of any dish
function parseOrderInput(b, { quote = false } = {}) {
  b = b || {};
  // an order is made of dishes and / or general extras (water, fries ... need no dish); it must contain at least one line
  const rawItems = b.items === undefined || b.items === null ? [] : b.items;
  const rawExtras = b.extras === undefined || b.extras === null ? [] : b.extras;
  if (!Array.isArray(rawItems) || !Array.isArray(rawExtras)) throw new HttpError(400, 'validation_error', 'items: must be a list', { field: 'items', reason: 'invalid' });
  if (rawItems.length + rawExtras.length === 0) throw new HttpError(400, 'validation_error', 'items: add at least one item', { field: 'items', reason: 'items_required' });
  if (rawItems.length > 50 || rawExtras.length > 50) throw new HttpError(400, 'validation_error', 'items: too many lines', { field: 'items', reason: 'too_many' });
  const wantedExtras = new Map(); // extraId -> quantity (duplicates are added together; the maximum is checked against the database row)
  rawExtras.forEach((x, j) => {
    const id = int(x?.extraId, `extras[${j}].extraId`, { min: 1 });
    wantedExtras.set(id, (wantedExtras.get(id) || 0) + int(x?.quantity ?? 1, `extras[${j}].quantity`, { min: 1, max: 50 }));
  });
  const items = rawItems.map((l, i) => {
    const sel = new Map(); // optionId -> quantity (duplicates are added together, then checked against the extra's maximum)
    const add = (id, qty) => sel.set(id, (sel.get(id) || 0) + qty);
    const legacy = l?.optionIds === undefined ? [] : l.optionIds;
    const rich = l?.options === undefined ? [] : l.options;
    if (!Array.isArray(legacy) || legacy.length > 30) throw new HttpError(400, 'validation_error', `items[${i}].optionIds: must be a list`, { field: 'items', reason: 'invalid' });
    if (!Array.isArray(rich) || rich.length > 30) throw new HttpError(400, 'validation_error', `items[${i}].options: must be a list`, { field: 'items', reason: 'invalid' });
    legacy.forEach((o, j) => add(int(o, `items[${i}].optionIds[${j}]`, { min: 1 }), 1));
    rich.forEach((o, j) => add(int(o?.optionId, `items[${i}].options[${j}].optionId`, { min: 1 }), int(o?.quantity ?? 1, `items[${i}].options[${j}].quantity`, { min: 1, max: 20 })));
    // free text for the restaurant: plain text only, never priced
    let instructions = l?.instructions === undefined || l.instructions === null ? null : str(l.instructions, `items[${i}].instructions`, { max: 300, optional: true });
    if (instructions) instructions = instructions.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim() || null;
    return {
      productId: int(l?.productId, `items[${i}].productId`, { min: 1 }),
      quantity: int(l?.quantity, `items[${i}].quantity`, { min: 1, max: 50 }),
      options: [...sel].map(([optionId, quantity]) => ({ optionId, quantity })),
      instructions,
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
    items, extras: [...wantedExtras].map(([extraId, quantity]) => ({ extraId, quantity })), orderType: b.orderType, paymentMethod,
    // the branch that prepares the order; optional when the restaurant has one branch or a delivery location is given
    branchId: b.branchId === undefined || b.branchId === null || b.branchId === '' ? null : int(b.branchId, 'branchId', { min: 1 }),
    // a coupon code typed by the customer; the discount itself is always calculated by the server
    couponCode: b.couponCode === undefined || b.couponCode === null || String(b.couponCode).trim() === '' ? null : str(b.couponCode, 'couponCode', { max: 40 }),
    customerName: quote ? null : str(b.customerName, 'customerName', { max: 100 }),
    customerPhone: quote ? null : phone(b.customerPhone, 'customerPhone'),
    deliveryAddress: b.orderType === 'delivery' && !quote ? str(b.deliveryAddress, 'deliveryAddress', { min: 5, max: 300 }) : null,
    latitude: coord(b.latitude, 'latitude', 90), longitude: coord(b.longitude, 'longitude', 180),
    notes: str(b.notes, 'notes', { max: 500, optional: true }),
  };
}

// Price the cart without placing it (optionally with a coupon code): the exact breakdown the order would get. Nothing is stored.
router.post('/restaurants/:slug/quote', requireRole('customer'), (req, res) => {
  const restaurant = loadPublicRestaurant(req.db, req.params.slug);
  const input = parseOrderInput(req.body, { quote: true });
  ok(res, { quote: quoteCart(req.db, restaurant, { ...input, customerId: req.user.id }) });
});

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

const ORDER_JOIN = `SELECT o.*, r.name AS restaurant_name, r.name_ar AS restaurant_name_ar, r.name_en AS restaurant_name_en, r.slug AS restaurant_slug, r.whatsapp AS restaurant_whatsapp, b.name AS branch_name
     FROM orders o JOIN restaurants r ON r.id = o.restaurant_id LEFT JOIN branches b ON b.id = o.branch_id`;

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
