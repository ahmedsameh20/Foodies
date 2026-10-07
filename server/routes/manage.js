const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { tx } = require('../db');
const { tenantContext, requireOwner, publicUser } = require('../middleware/auth');
const { enforceLimit, requireFeature, formatPlan } = require('../services/plans');
const subscriptions = require('../services/subscriptions');
const { subscriptionView } = subscriptions;
const { ACTIVE, STATUSES, formatOrder, loadItems, changeStatus } = require('../services/orders');
const payments = require('../services/payments');
const { toDecimalString, mulDiv } = require('../services/money');
const ledger = require('../services/ledger');
const paymentAccounts = require('../services/paymentAccounts');
const finance = require('../services/finance');
const settlements = require('../services/settlements');
const { audit } = require('../services/platform');
const { parseHours, validTimezone } = require('../services/hours');
const {
  HttpError, notFound, str, int, bool, email, password, phone, imageUrl, ok,
} = require('../utils');

// Every route below runs after tenantContext, which sets req.restaurant from the signed-in user's
// own record. Every query is filtered by req.restaurant.id; ids from the URL or body are only
// ever used together with that filter.
const router = express.Router();
router.use(tenantContext);

const fmtRestaurant = (r) => ({
  id: r.id, slug: r.slug, name: r.name, description: r.description, logoUrl: r.logo_url, coverUrl: r.cover_url,
  phone: r.phone, whatsapp: r.whatsapp, email: r.email, address: r.address, city: r.city, currency: r.currency,
  latitude: r.latitude, longitude: r.longitude, timezone: r.timezone,
  openingHours: r.opening_hours ? JSON.parse(r.opening_hours) : null,
  taxRateBp: r.tax_rate_bp, deliveryFeeCents: r.delivery_fee_cents, minOrderCents: r.min_order_cents,
  acceptingOrders: !!r.accepting_orders, isActive: !!r.is_active, isDemo: !!r.is_demo,
  approvalStatus: r.approval_status, rejectionReason: r.rejection_reason,
});
const fmtProduct = (p) => ({
  id: p.id, categoryId: p.category_id, name: p.name, description: p.description,
  priceCents: p.price_cents, imageUrl: p.image_url, isAvailable: !!p.is_available,
});

const paymentAccountView = (db, restaurantId, provider) => paymentAccounts.view(db, restaurantId, provider);

// ---------------- restaurant profile & settings ----------------
router.get('/restaurant', (req, res) => {
  ok(res, {
    restaurant: fmtRestaurant(req.restaurant),
    subscription: subscriptionView(req.db, req.restaurant.id),
    paymentAccount: paymentAccountView(req.db, req.restaurant.id, req.provider),
    role: req.user.role,
  });
});

router.put('/restaurant', requireOwner, (req, res) => {
  const b = req.body || {};
  const cur = req.restaurant;
  const coord = (v, f, max, curV) => {
    if (v === undefined) return curV;
    if (v === null || v === '') return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > max) throw new HttpError(400, 'validation_error', `${f}: invalid coordinate`, { field: f });
    return v;
  };
  if (b.timezone !== undefined && !validTimezone(b.timezone)) throw new HttpError(400, 'validation_error', 'timezone: unknown timezone (e.g. Asia/Riyadh)', { field: 'timezone' });
  const hours = b.openingHours !== undefined ? parseHours(b.openingHours) : undefined;
  const next = {
    name: b.name !== undefined ? str(b.name, 'name', { max: 100 }) : cur.name,
    description: b.description !== undefined ? (str(b.description, 'description', { max: 1000, optional: true }) || '') : cur.description,
    logo_url: b.logoUrl !== undefined ? imageUrl(b.logoUrl, 'logoUrl') : cur.logo_url,
    cover_url: b.coverUrl !== undefined ? imageUrl(b.coverUrl, 'coverUrl') : cur.cover_url,
    phone: b.phone !== undefined ? phone(b.phone, 'phone', { optional: true }) : cur.phone,
    whatsapp: b.whatsapp !== undefined ? phone(b.whatsapp, 'whatsapp', { optional: true }) : cur.whatsapp,
    email: b.email !== undefined ? (b.email ? email(b.email) : null) : cur.email,
    address: b.address !== undefined ? str(b.address, 'address', { max: 300, optional: true }) : cur.address,
    city: b.city !== undefined ? str(b.city, 'city', { max: 100, optional: true }) : cur.city,
    latitude: coord(b.latitude, 'latitude', 90, cur.latitude),
    longitude: coord(b.longitude, 'longitude', 180, cur.longitude),
    timezone: b.timezone !== undefined ? b.timezone : cur.timezone,
    opening_hours: hours === undefined ? cur.opening_hours : (hours ? JSON.stringify(hours) : null),
    tax_rate_bp: b.taxRateBp !== undefined ? int(b.taxRateBp, 'taxRateBp', { max: 10000 }) : cur.tax_rate_bp,
    delivery_fee_cents: b.deliveryFeeCents !== undefined ? int(b.deliveryFeeCents, 'deliveryFeeCents', { max: 1e7 }) : cur.delivery_fee_cents,
    min_order_cents: b.minOrderCents !== undefined ? int(b.minOrderCents, 'minOrderCents', { max: 1e8 }) : cur.min_order_cents,
    accepting_orders: b.acceptingOrders !== undefined ? (bool(b.acceptingOrders, 'acceptingOrders') ? 1 : 0) : cur.accepting_orders,
  };
  req.db.prepare(
    `UPDATE restaurants SET name=?, description=?, logo_url=?, cover_url=?, phone=?, whatsapp=?, email=?, address=?, city=?,
       latitude=?, longitude=?, timezone=?, opening_hours=?, tax_rate_bp=?, delivery_fee_cents=?, min_order_cents=?, accepting_orders=? WHERE id=?`)
    .run(next.name, next.description, next.logo_url, next.cover_url, next.phone, next.whatsapp, next.email, next.address, next.city,
      next.latitude, next.longitude, next.timezone, next.opening_hours, next.tax_rate_bp, next.delivery_fee_cents,
      next.min_order_cents, next.accepting_orders, cur.id);
  ok(res, { restaurant: fmtRestaurant(req.db.prepare('SELECT * FROM restaurants WHERE id = ?').get(cur.id)) });
});

// ---------------- categories ----------------
router.get('/categories', (req, res) => {
  const rows = req.db.prepare(
    `SELECT c.id, c.name, c.sort_order, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.restaurant_id = c.restaurant_id) AS item_count
     FROM categories c WHERE c.restaurant_id = ? ORDER BY c.sort_order, c.name`).all(req.restaurant.id);
  ok(res, { categories: rows.map((c) => ({ id: c.id, name: c.name, sortOrder: c.sort_order, itemCount: c.item_count })) });
});

router.post('/categories', requireOwner, (req, res) => {
  const name = str(req.body?.name, 'name', { max: 60 });
  const sort = int(req.body?.sortOrder, 'sortOrder', { optional: true, max: 10000 }) ?? 0;
  try {
    const info = req.db.prepare('INSERT INTO categories (restaurant_id, name, sort_order) VALUES (?,?,?)')
      .run(req.restaurant.id, name, sort);
    ok(res, { category: { id: Number(info.lastInsertRowid), name, sortOrder: sort } }, 201);
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'duplicate', 'A category with that name already exists');
    throw e;
  }
});

router.put('/categories/:id', requireOwner, (req, res) => {
  const name = str(req.body?.name, 'name', { max: 60 });
  const sort = int(req.body?.sortOrder, 'sortOrder', { optional: true, max: 10000 });
  try {
    const info = req.db.prepare(
      'UPDATE categories SET name = ?, sort_order = COALESCE(?, sort_order) WHERE id = ? AND restaurant_id = ?')
      .run(name, sort, Number(req.params.id) || 0, req.restaurant.id);
    if (!info.changes) throw notFound('Category');
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'duplicate', 'A category with that name already exists');
    throw e;
  }
  ok(res, { updated: true });
});

router.delete('/categories/:id', requireOwner, (req, res) => {
  const id = Number(req.params.id) || 0;
  tx(req.db, () => {
    if (!req.db.prepare('SELECT 1 FROM categories WHERE id = ? AND restaurant_id = ?').get(id, req.restaurant.id)) throw notFound('Category');
    req.db.prepare('UPDATE products SET category_id = NULL WHERE category_id = ? AND restaurant_id = ?').run(id, req.restaurant.id);
    req.db.prepare('DELETE FROM categories WHERE id = ? AND restaurant_id = ?').run(id, req.restaurant.id);
  });
  ok(res, { deleted: true });
});

// ---------------- products ----------------
router.get('/products', (req, res) => {
  const rows = req.db.prepare('SELECT * FROM products WHERE restaurant_id = ? ORDER BY name').all(req.restaurant.id);
  ok(res, { products: rows.map(fmtProduct) });
});

// category_id must belong to the same restaurant (the composite FK enforces it too).
function resolveCategory(db, restaurantId, value) {
  if (value === undefined || value === null || value === '') return null;
  const id = int(value, 'categoryId', { min: 1 });
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ? AND restaurant_id = ?').get(id, restaurantId)) {
    throw new HttpError(400, 'validation_error', 'categoryId: category does not exist', { field: 'categoryId' });
  }
  return id;
}

router.post('/products', requireOwner, (req, res) => {
  const b = req.body || {};
  const data = {
    name: str(b.name, 'name', { max: 120 }),
    description: str(b.description, 'description', { max: 1000, optional: true }) || '',
    price: int(b.priceCents, 'priceCents', { max: 1e8 }),
    image: imageUrl(b.imageUrl),
    available: b.isAvailable === undefined ? true : bool(b.isAvailable, 'isAvailable'),
    category: resolveCategory(req.db, req.restaurant.id, b.categoryId),
  };
  const product = tx(req.db, () => {
    enforceLimit(req.db, req.restaurant.id, 'menuItems'); // checked inside the tx so concurrent adds can't overshoot
    const info = req.db.prepare(
      `INSERT INTO products (restaurant_id, category_id, name, description, price_cents, image_url, is_available)
       VALUES (?,?,?,?,?,?,?)`)
      .run(req.restaurant.id, data.category, data.name, data.description, data.price, data.image, data.available ? 1 : 0);
    return req.db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
  });
  ok(res, { product: fmtProduct(product) }, 201);
});

router.put('/products/:id', requireOwner, (req, res) => {
  const id = Number(req.params.id) || 0;
  const cur = req.db.prepare('SELECT * FROM products WHERE id = ? AND restaurant_id = ?').get(id, req.restaurant.id);
  if (!cur) throw notFound('Product');
  const b = req.body || {};
  const next = {
    name: b.name !== undefined ? str(b.name, 'name', { max: 120 }) : cur.name,
    description: b.description !== undefined ? (str(b.description, 'description', { max: 1000, optional: true }) || '') : cur.description,
    price: b.priceCents !== undefined ? int(b.priceCents, 'priceCents', { max: 1e8 }) : cur.price_cents,
    image: b.imageUrl !== undefined ? imageUrl(b.imageUrl) : cur.image_url,
    available: b.isAvailable !== undefined ? (bool(b.isAvailable, 'isAvailable') ? 1 : 0) : cur.is_available,
    category: b.categoryId !== undefined ? resolveCategory(req.db, req.restaurant.id, b.categoryId) : cur.category_id,
  };
  req.db.prepare(
    `UPDATE products SET name=?, description=?, price_cents=?, image_url=?, is_available=?, category_id=?
     WHERE id=? AND restaurant_id=?`)
    .run(next.name, next.description, next.price, next.image, next.available, next.category, id, req.restaurant.id);
  ok(res, { product: fmtProduct(req.db.prepare('SELECT * FROM products WHERE id = ?').get(id)) });
});

// Staff may flip availability (86'ing an item) but not edit prices or delete.
router.patch('/products/:id/availability', (req, res) => {
  const available = bool(req.body?.isAvailable, 'isAvailable');
  const info = req.db.prepare('UPDATE products SET is_available = ? WHERE id = ? AND restaurant_id = ?')
    .run(available ? 1 : 0, Number(req.params.id) || 0, req.restaurant.id);
  if (!info.changes) throw notFound('Product');
  ok(res, { updated: true });
});

router.delete('/products/:id', requireOwner, (req, res) => {
  const info = req.db.prepare('DELETE FROM products WHERE id = ? AND restaurant_id = ?')
    .run(Number(req.params.id) || 0, req.restaurant.id);
  if (!info.changes) throw notFound('Product');
  ok(res, { deleted: true });
});

// ---------------- image upload ----------------
const MAGIC = [
  { ext: 'png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
];
router.post('/uploads',
  requireOwner,
  express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '2mb' }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new HttpError(415, 'unsupported_media', 'Upload a PNG, JPEG or WebP image (max 2 MB)');
    }
    const kind = MAGIC.find((m) => m.test(req.body)); // trust file contents, not the declared type
    if (!kind) throw new HttpError(415, 'unsupported_media', 'File is not a valid PNG, JPEG or WebP image');
    const dir = path.join(config.uploadDir, String(req.restaurant.id));
    fs.mkdirSync(dir, { recursive: true });
    const name = `${crypto.randomBytes(12).toString('hex')}.${kind.ext}`;
    fs.writeFileSync(path.join(dir, name), req.body);
    ok(res, { url: `/uploads/${req.restaurant.id}/${name}` }, 201);
  });

// ---------------- menu options / add-ons (owner) ----------------
function loadOwnProduct(db, restaurantId, id) {
  const p = db.prepare('SELECT id FROM products WHERE id = ? AND restaurant_id = ?').get(Number(id) || 0, restaurantId);
  if (!p) throw notFound('Product');
  return p;
}
const fmtGroup = (db, restaurantId, g) => ({
  id: g.id, productId: g.product_id, name: g.name, minSelect: g.min_select, maxSelect: g.max_select,
  options: db.prepare('SELECT id, name, price_cents, is_available FROM options WHERE group_id = ? AND restaurant_id = ? ORDER BY sort_order, id').all(g.id, restaurantId)
    .map((o) => ({ id: o.id, name: o.name, priceCents: o.price_cents, isAvailable: !!o.is_available })),
});

router.get('/products/:id/option-groups', (req, res) => {
  const p = loadOwnProduct(req.db, req.restaurant.id, req.params.id);
  const groups = req.db.prepare('SELECT * FROM option_groups WHERE product_id = ? AND restaurant_id = ? ORDER BY sort_order, id').all(p.id, req.restaurant.id);
  ok(res, { groups: groups.map((g) => fmtGroup(req.db, req.restaurant.id, g)) });
});

function parseOptions(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > 30) throw new HttpError(400, 'validation_error', 'options: provide 1-30 options', { field: 'options' });
  return list.map((o, i) => ({
    name: str(o?.name, `options[${i}].name`, { max: 80 }),
    priceCents: int(o?.priceCents ?? 0, `options[${i}].priceCents`, { max: 1e7 }),
    isAvailable: o?.isAvailable === undefined ? true : bool(o.isAvailable, `options[${i}].isAvailable`),
  }));
}

function saveGroup(db, restaurantId, productId, b, groupId) {
  const minSelect = int(b.minSelect ?? 0, 'minSelect', { max: 30 });
  const maxSelect = int(b.maxSelect ?? 1, 'maxSelect', { min: 1, max: 30 });
  const options = parseOptions(b.options);
  if (minSelect > maxSelect || maxSelect > options.length) throw new HttpError(400, 'validation_error', 'minSelect/maxSelect: inconsistent with the number of options', { field: 'maxSelect' });
  const name = str(b.name, 'name', { max: 80 });
  return tx(db, () => {
    let id = groupId;
    if (id) {
      db.prepare('UPDATE option_groups SET name = ?, min_select = ?, max_select = ? WHERE id = ? AND restaurant_id = ?').run(name, minSelect, maxSelect, id, restaurantId);
      // order_item_options keeps its own snapshot (name + price), so past orders are unaffected by replacing options.
      db.prepare('DELETE FROM options WHERE group_id = ? AND restaurant_id = ?').run(id, restaurantId);
    } else {
      id = Number(db.prepare('INSERT INTO option_groups (restaurant_id, product_id, name, min_select, max_select) VALUES (?,?,?,?,?)').run(restaurantId, productId, name, minSelect, maxSelect).lastInsertRowid);
    }
    const ins = db.prepare('INSERT INTO options (restaurant_id, group_id, name, price_cents, is_available, sort_order) VALUES (?,?,?,?,?,?)');
    options.forEach((o, i) => ins.run(restaurantId, id, o.name, o.priceCents, o.isAvailable ? 1 : 0, i));
    return db.prepare('SELECT * FROM option_groups WHERE id = ?').get(id);
  });
}

router.post('/products/:id/option-groups', requireOwner, (req, res) => {
  const p = loadOwnProduct(req.db, req.restaurant.id, req.params.id);
  const g = saveGroup(req.db, req.restaurant.id, p.id, req.body || {});
  ok(res, { group: fmtGroup(req.db, req.restaurant.id, g) }, 201);
});

router.put('/option-groups/:id', requireOwner, (req, res) => {
  const g = req.db.prepare('SELECT * FROM option_groups WHERE id = ? AND restaurant_id = ?').get(Number(req.params.id) || 0, req.restaurant.id);
  if (!g) throw notFound('Option group');
  ok(res, { group: fmtGroup(req.db, req.restaurant.id, saveGroup(req.db, req.restaurant.id, g.product_id, req.body || {}, g.id)) });
});

router.delete('/option-groups/:id', requireOwner, (req, res) => {
  const info = req.db.prepare('DELETE FROM option_groups WHERE id = ? AND restaurant_id = ?').run(Number(req.params.id) || 0, req.restaurant.id);
  if (!info.changes) throw notFound('Option group');
  ok(res, { deleted: true });
});

// ---------------- orders ----------------
// Restaurants only ever see cash orders and card orders whose payment was verified. Unpaid, abandoned or
// failed card checkouts never reach them.
const VISIBLE = "(payment_method != 'card' OR paid_at IS NOT NULL)";

router.get('/orders', (req, res) => {
  const status = req.query.status;
  if (status !== undefined && status !== 'active' && !STATUSES.includes(status)) {
    throw new HttpError(400, 'validation_error', 'status: unknown status', { field: 'status' });
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  // "active" = everything still being worked on; filtered in SQL so old open orders are never cut off by the limit.
  const filter = status === undefined ? '' : status === 'active'
    ? `AND status IN (${ACTIVE.map((s) => `'${s}'`).join(',')})` : 'AND status = ?';
  const args = status && status !== 'active' ? [req.restaurant.id, status, limit] : [req.restaurant.id, limit];
  const rows = req.db.prepare(
    `SELECT * FROM orders WHERE restaurant_id = ? AND ${VISIBLE} ${filter} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args);
  ok(res, {
    orders: rows.map((o) => ({
      ...formatOrder(o),
      items: loadItems(req.db, o.id, req.restaurant.id).map((i) => ({ name: i.name, quantity: i.quantity, options: i.options })),
    })),
  });
});

router.get('/orders/:id', (req, res) => {
  const id = Number(req.params.id) || 0;
  const o = req.db.prepare(`SELECT * FROM orders WHERE id = ? AND restaurant_id = ? AND ${VISIBLE}`).get(id, req.restaurant.id);
  if (!o) throw notFound('Order');
  const history = req.db.prepare(
    'SELECT status, created_at FROM order_status_history WHERE order_id = ? AND restaurant_id = ? ORDER BY id').all(id, req.restaurant.id);
  ok(res, { order: formatOrder(o, loadItems(req.db, id, req.restaurant.id)), history });
});

router.patch('/orders/:id/status', async (req, res) => {
  const status = req.body?.status;
  if (!STATUSES.includes(status) || status === 'awaiting_payment') throw new HttpError(400, 'validation_error', 'status: unknown status', { field: 'status' });
  const id = Number(req.params.id) || 0;
  if (!req.db.prepare(`SELECT 1 FROM orders WHERE id = ? AND restaurant_id = ? AND ${VISIBLE}`).get(id, req.restaurant.id)) throw notFound('Order');
  const reason = req.body?.reason ? str(req.body.reason, 'reason', { max: 200 }) : null;
  const result = changeStatus(req.db, { restaurantId: req.restaurant.id, orderId: id, status, actor: req.user, reason });
  await payments.afterStatusChange(req.db, req.provider, result, reason || `Order ${status} by restaurant`);
  const fresh = req.db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  ok(res, { order: formatOrder(fresh, loadItems(req.db, id, req.restaurant.id)) });
});

// ---------------- dashboard overview (all roles, operational numbers only) ----------------
router.get('/overview', (req, res) => {
  const rid = req.restaurant.id;
  const one = (sql, ...a) => req.db.prepare(sql).get(rid, ...a);
  const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
  const t = todayStart.toISOString();
  ok(res, {
    pending: one("SELECT COUNT(*) c FROM orders WHERE restaurant_id = ? AND status = 'pending'").c,
    inProgress: one("SELECT COUNT(*) c FROM orders WHERE restaurant_id = ? AND status IN ('confirmed','preparing','ready','out_for_delivery')").c,
    ordersToday: one(`SELECT COUNT(*) c FROM orders WHERE restaurant_id = ? AND ${VISIBLE} AND created_at >= ?`, t).c,
    menuItems: one('SELECT COUNT(*) c FROM products WHERE restaurant_id = ?').c,
    ...(req.user.role === 'owner'
      ? { revenueTodayCents: one("SELECT COALESCE(SUM(total_cents),0) s FROM orders WHERE restaurant_id = ? AND status NOT IN ('cancelled','rejected','awaiting_payment') AND created_at >= ?", t).s }
      : {}),
  });
});

// ---------------- earnings, payments, payouts (owner) ----------------
router.get('/payment-account', requireOwner, (req, res) => ok(res, { paymentAccount: paymentAccountView(req.db, req.restaurant.id, req.provider) }));

// "Set up payout account": the owner submits business identifiers (never bank or card details). The platform completes the
// provider-side onboarding (KYC/KYB happens at the provider) and the provider confirms the account before payouts are enabled.
router.post('/payment-account/apply', requireOwner, (req, res) => {
  paymentAccounts.submitApplication(req.db, req, req.restaurant, req.body);
  ok(res, { paymentAccount: paymentAccountView(req.db, req.restaurant.id, req.provider) }, 201);
});

router.get('/finance', requireOwner, (req, res) => ok(res, { finance: finance.restaurantFinance(req.db, req.restaurant) }));

// What Tap reports it has settled to this restaurant (read-only; separate from the earnings statements above).
router.get('/settlements', requireOwner, (req, res) => ok(res, {
  settlementModel: config.payoutMode === 'provider_settled' ? 'TAP_SETTLEMENT' : 'PLATFORM_PAYOUT',
  settlements: settlements.settlementsFor(req.db, req.restaurant.id),
}));

router.get('/earnings', requireOwner, (req, res) => {
  const rid = req.restaurant.id;
  const bal = ledger.restaurantBalance(req.db, rid);
  const totals = req.db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN entry_type != 'cod_commission' THEN gross_amount_cents END),0) gross,
            COALESCE(SUM(platform_commission_cents),0) commission, COALESCE(SUM(platform_fee_cents),0) AS "platformFee",
            COALESCE(SUM(payment_fee_cents),0) AS "paymentFees",
            COALESCE(SUM(CASE WHEN entry_type != 'cod_commission' THEN restaurant_amount_cents END),0) net
     FROM ledger_entries WHERE restaurant_id = ?`).get(rid);
  const cod = req.db.prepare("SELECT COUNT(*) n, COALESCE(SUM(gross_amount_cents),0) gross FROM ledger_entries WHERE restaurant_id = ? AND entry_type = 'cod_commission'").get(rid);
  ok(res, {
    currency: req.restaurant.currency, payoutMode: config.payoutMode, ...bal,
    onlineGrossCents: totals.gross, commissionCents: totals.commission, platformFeeCents: totals.platformFee,
    paymentFeeCents: totals.paymentFees, onlineNetCents: totals.net,
    cashOrders: cod.n, cashCollectedCents: cod.gross,
  });
});

router.get('/earnings/ledger', requireOwner, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const rows = req.db.prepare(
    `SELECT l.*, o.order_number FROM ledger_entries l JOIN orders o ON o.id = l.order_id AND o.restaurant_id = l.restaurant_id
     WHERE l.restaurant_id = ? ORDER BY l.id DESC LIMIT ?`).all(req.restaurant.id, limit);
  ok(res, {
    entries: rows.map((l) => ({
      id: l.id, orderId: l.order_id, orderNumber: l.order_number, type: l.entry_type, grossCents: l.gross_amount_cents,
      commissionCents: l.platform_commission_cents, platformFeeCents: l.platform_fee_cents, paymentFeeCents: l.payment_fee_cents,
      restaurantAmountCents: l.restaurant_amount_cents, payoutId: l.payout_id, payoutStatus: l.payout_status,
      eligibleAt: l.eligible_at, settledAt: l.settled_at, createdAt: l.created_at,
    })),
  });
});

router.get('/payouts', requireOwner, (req, res) => {
  const rows = req.db.prepare('SELECT * FROM payouts WHERE restaurant_id = ? ORDER BY period_start DESC LIMIT 100').all(req.restaurant.id);
  const acct = req.db.prepare('SELECT masked_bank FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(req.restaurant.id);
  ok(res, {
    payouts: rows.map((p) => ({
      id: p.id, amountCents: p.amount_cents, currency: p.currency, status: p.status, periodStart: p.period_start, periodEnd: p.period_end,
      reference: p.provider_payout_id ? String(p.provider_payout_id).replace(/^manual:/, '') : null, provider: p.provider, failureReason: p.failure_reason,
      confirmedBy: p.status === 'paid' ? (p.confirmation_source === 'provider' ? 'payment provider' : 'recorded manually by the platform') : null,
      destination: acct?.masked_bank || null, settlementCurrency: p.settlement_currency,
      createdAt: p.created_at, paidAt: p.paid_at,
    })),
  });
});

router.get('/payments', requireOwner, (req, res) => {
  const rows = req.db.prepare(
    `SELECT p.*, o.order_number FROM payments p JOIN orders o ON o.id = p.order_id AND o.restaurant_id = p.restaurant_id
     WHERE p.restaurant_id = ? AND (o.payment_method != 'card' OR o.paid_at IS NOT NULL) ORDER BY p.id DESC LIMIT 200`).all(req.restaurant.id);
  ok(res, {
    payments: rows.map((p) => ({
      id: p.id, orderId: p.order_id, orderNumber: p.order_number, method: p.payment_method, source: p.payment_source, status: p.status,
      amountCents: p.amount_cents, refundedCents: p.refunded_cents, currency: p.currency, createdAt: p.created_at,
    })),
  });
});

// ---------------- customers (owner) ----------------
router.get('/customers', requireOwner, (req, res) => {
  const rows = req.db.prepare(
    `SELECT u.id, u.name, u.email, u.phone, rc.first_order_at,
            COUNT(o.id) AS order_count,
            COALESCE(SUM(CASE WHEN o.status NOT IN ('cancelled','rejected','awaiting_payment') THEN o.total_cents END), 0) AS total_spent,
            MAX(o.created_at) AS last_order_at
     FROM restaurant_customers rc
     JOIN users u ON u.id = rc.user_id
     LEFT JOIN orders o ON o.customer_id = u.id AND o.restaurant_id = rc.restaurant_id
     WHERE rc.restaurant_id = ?
     GROUP BY u.id, rc.first_order_at ORDER BY total_spent DESC, u.name LIMIT 500`).all(req.restaurant.id);
  ok(res, {
    customers: rows.map((c) => ({
      id: c.id, name: c.name, email: c.email, phone: c.phone, firstOrderAt: c.first_order_at,
      orderCount: c.order_count, totalSpentCents: c.total_spent, lastOrderAt: c.last_order_at,
    })),
  });
});

// ---------------- staff (owner) ----------------
router.get('/staff', requireOwner, (req, res) => {
  const rows = req.db.prepare(
    "SELECT id, email, name, phone, role, restaurant_id, is_active FROM users WHERE restaurant_id = ? AND role = 'staff' ORDER BY name").all(req.restaurant.id);
  ok(res, { staff: rows.map((u) => ({ ...publicUser(u), isActive: !!u.is_active })) });
});

router.post('/staff', requireOwner, (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 'name', { max: 100 });
  const mail = email(b.email);
  const pass = password(b.password);
  const user = tx(req.db, () => {
    enforceLimit(req.db, req.restaurant.id, 'staff');
    if (req.db.prepare('SELECT 1 FROM users WHERE email = ?').get(mail)) throw new HttpError(409, 'email_taken', 'An account with this email already exists');
    const info = req.db.prepare("INSERT INTO users (email, password_hash, name, role, restaurant_id) VALUES (?,?,?, 'staff', ?)")
      .run(mail, bcrypt.hashSync(pass, config.bcryptRounds), name, req.restaurant.id);
    return req.db.prepare('SELECT id, email, name, phone, role, restaurant_id FROM users WHERE id = ?').get(info.lastInsertRowid);
  });
  ok(res, { staff: publicUser(user) }, 201);
});

router.patch('/staff/:id', requireOwner, (req, res) => {
  const active = bool(req.body?.isActive, 'isActive');
  const info = req.db.prepare("UPDATE users SET is_active = ? WHERE id = ? AND restaurant_id = ? AND role = 'staff'")
    .run(active ? 1 : 0, Number(req.params.id) || 0, req.restaurant.id);
  if (!info.changes) throw notFound('Staff member');
  ok(res, { updated: true });
});

router.delete('/staff/:id', requireOwner, (req, res) => {
  const info = req.db.prepare("DELETE FROM users WHERE id = ? AND restaurant_id = ? AND role = 'staff'")
    .run(Number(req.params.id) || 0, req.restaurant.id);
  if (!info.changes) throw notFound('Staff member');
  ok(res, { deleted: true });
});

// ---------------- branches (owner, plan-limited) ----------------
router.get('/branches', requireOwner, (req, res) => {
  ok(res, { branches: req.db.prepare('SELECT id, name, address, phone FROM branches WHERE restaurant_id = ? ORDER BY name').all(req.restaurant.id) });
});
router.post('/branches', requireOwner, (req, res) => {
  const b = req.body || {};
  const data = { name: str(b.name, 'name', { max: 100 }), address: str(b.address, 'address', { max: 300, optional: true }), phone: phone(b.phone, 'phone', { optional: true }) };
  const row = tx(req.db, () => {
    enforceLimit(req.db, req.restaurant.id, 'branches');
    const info = req.db.prepare('INSERT INTO branches (restaurant_id, name, address, phone) VALUES (?,?,?,?)')
      .run(req.restaurant.id, data.name, data.address, data.phone);
    return { id: Number(info.lastInsertRowid), ...data };
  });
  ok(res, { branch: row }, 201);
});
router.delete('/branches/:id', requireOwner, (req, res) => {
  const info = req.db.prepare('DELETE FROM branches WHERE id = ? AND restaurant_id = ?').run(Number(req.params.id) || 0, req.restaurant.id);
  if (!info.changes) throw notFound('Branch');
  ok(res, { deleted: true });
});

// ---------------- SaaS subscription (owner): what THIS restaurant pays the platform ----------------
const invoicesOf = (db, rid) => db.prepare('SELECT * FROM saas_invoices WHERE restaurant_id = ? ORDER BY id DESC LIMIT 50').all(rid).map(subscriptions.invoiceView);

router.get('/subscription', requireOwner, (req, res) => {
  const plans = req.db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY sort_order, id').all().map(formatPlan);
  ok(res, {
    subscription: subscriptionView(req.db, req.restaurant.id), plans, invoices: invoicesOf(req.db, req.restaurant.id),
    cardPaymentsAvailable: req.provider.enabled,
  });
});


// The provider needs the payer's phone number to save a card for automatic renewal: kept on the owner's own user row.
function rememberOwnerPhone(req) {
  if (req.body?.saveCard === true && req.body.phone) {
    req.db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone(req.body.phone, 'phone'), req.user.id);
  }
}

// Choose / change plan. Free plans and first trials apply immediately; otherwise an invoice is issued.
router.post('/subscription/change', requireOwner, async (req, res) => {
  const plan = subscriptions.planByCode(req.db, str(req.body?.planCode, 'planCode', { max: 30 }));
  if (!plan || !plan.is_active) throw notFound('Plan');
  rememberOwnerPhone(req);
  const r = subscriptions.requestPlanChange(req.db, req.restaurant.id, plan);
  audit(req.db, req, 'subscription.change_requested', 'restaurant', req.restaurant.id, { plan: plan.code, applied: r.applied });
  let paymentUrl = null;
  if (r.invoice && req.provider.enabled && req.body?.pay !== false) {
    const owner = req.db.prepare('SELECT id, name, email, phone FROM users WHERE id = ?').get(req.user.id);
    ({ redirectUrl: paymentUrl } = await subscriptions.startInvoiceCheckout(req.db, req.provider, { invoiceId: r.invoice.id, restaurantId: req.restaurant.id, customer: owner, saveCard: req.body?.saveCard === true }));
  }
  ok(res, {
    applied: r.applied, trial: !!r.trial, invoice: r.invoice ? subscriptions.invoiceView(r.invoice) : null, paymentUrl,
    subscription: subscriptionView(req.db, req.restaurant.id),
  });
});

// Stop automatic renewals: forget the saved-card identifiers (renewals fall back to invoices the owner pays).
router.delete('/subscription/payment-method', requireOwner, (req, res) => {
  const removed = subscriptions.removeSavedMethod(req.db, req.restaurant.id);
  ok(res, { removed, subscription: subscriptionView(req.db, req.restaurant.id) });
});

router.post('/subscription/cancel', requireOwner, (req, res) => {
  subscriptions.cancelSubscription(req.db, req.restaurant.id);
  audit(req.db, req, 'subscription.cancelled', 'restaurant', req.restaurant.id, {});
  ok(res, { subscription: subscriptionView(req.db, req.restaurant.id) });
});

// Pay an open invoice through the payment provider's hosted page.
router.post('/invoices/:id/pay', requireOwner, async (req, res) => {
  rememberOwnerPhone(req);
  const owner = req.db.prepare('SELECT id, name, email, phone FROM users WHERE id = ?').get(req.user.id);
  const { redirectUrl } = await subscriptions.startInvoiceCheckout(req.db, req.provider, { invoiceId: Number(req.params.id) || 0, restaurantId: req.restaurant.id, customer: owner, saveCard: req.body?.saveCard === true });
  ok(res, { paymentUrl: redirectUrl });
});

// Return-from-checkout verification: asks the provider; the browser's claim is never used.
router.post('/invoices/:id/refresh', requireOwner, async (req, res) => {
  const inv = req.db.prepare('SELECT * FROM saas_invoices WHERE id = ? AND restaurant_id = ?').get(Number(req.params.id) || 0, req.restaurant.id);
  if (!inv) throw notFound('Invoice');
  if (inv.status === 'open' && inv.provider_ref && req.provider.enabled) {
    try { await subscriptions.reconcileInvoiceCharge(req.db, req.provider, inv.provider_ref, inv.id); } catch { /* provider unavailable: unchanged */ }
  }
  ok(res, { subscription: subscriptionView(req.db, req.restaurant.id), invoices: invoicesOf(req.db, req.restaurant.id) });
});

// Support tickets that concern THIS restaurant (read-only for the tenant).
router.get('/support-reports', requireOwner, (req, res) => {
  const rows = req.db.prepare('SELECT id, category, subject, status, priority, order_id, created_at, resolved_at FROM reports WHERE restaurant_id = ? ORDER BY created_at DESC LIMIT 100').all(req.restaurant.id);
  ok(res, { reports: rows.map((r) => ({ id: r.id, category: r.category, subject: r.subject, status: r.status, priority: r.priority, orderId: r.order_id, createdAt: r.created_at, resolvedAt: r.resolved_at })) });
});

// ---------------- reports (owner; plan-gated on the server) ----------------
const clampDays = (v) => Math.min(Math.max(Number(v) || 30, 1), 365);
const since = (days) => new Date(Date.now() - days * 86400000).toISOString();

router.get('/reports/summary', requireOwner, requireFeature('analytics'), (req, res) => {
  const rid = req.restaurant.id;
  const days = clampDays(req.query.days);
  const from = since(days);
  const totals = req.db.prepare(
    `SELECT COUNT(*) AS orders,
            COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','rejected','awaiting_payment') THEN total_cents END), 0) AS revenue,
            SUM(CASE WHEN status IN ('cancelled','rejected') THEN 1 ELSE 0 END) AS cancelled,
            COUNT(DISTINCT customer_id) AS customers
     FROM orders WHERE restaurant_id = ? AND (payment_method != 'card' OR paid_at IS NOT NULL) AND created_at >= ?`).get(rid, from);
  const valid = totals.orders - (totals.cancelled || 0);
  const byStatus = req.db.prepare(
    "SELECT status, COUNT(*) c FROM orders WHERE restaurant_id = ? AND (payment_method != 'card' OR paid_at IS NOT NULL) AND created_at >= ? GROUP BY status").all(rid, from);
  const daily = req.db.prepare(
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS orders,
            COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','rejected','awaiting_payment') THEN total_cents END), 0) AS revenue
     FROM orders WHERE restaurant_id = ? AND (payment_method != 'card' OR paid_at IS NOT NULL) AND created_at >= ? GROUP BY day ORDER BY day`).all(rid, from);
  ok(res, {
    days, orders: totals.orders, revenueCents: totals.revenue, cancelled: totals.cancelled || 0,
    customers: totals.customers, avgOrderCents: valid ? mulDiv(totals.revenue, 1, valid) : 0,
    byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s.c])),
    daily: daily.map((d) => ({ day: d.day, orders: d.orders, revenueCents: d.revenue })),
  });
});

router.get('/reports/advanced', requireOwner, requireFeature('advancedReports'), (req, res) => {
  const rid = req.restaurant.id;
  const from = since(clampDays(req.query.days));
  const topProducts = req.db.prepare(
    `SELECT i.product_name AS name, SUM(i.quantity) AS qty, SUM(i.line_total_cents) AS revenue
     FROM order_items i JOIN orders o ON o.id = i.order_id AND o.restaurant_id = i.restaurant_id
     WHERE i.restaurant_id = ? AND o.status NOT IN ('cancelled','rejected','awaiting_payment') AND o.created_at >= ?
     GROUP BY i.product_name ORDER BY qty DESC LIMIT 10`).all(rid, from);
  const hourly = req.db.prepare(
    `SELECT CAST(substr(created_at, 12, 2) AS INTEGER) AS hour, COUNT(*) AS orders
     FROM orders WHERE restaurant_id = ? AND status NOT IN ('cancelled','rejected','awaiting_payment') AND created_at >= ? GROUP BY hour ORDER BY hour`).all(rid, from);
  const repeat = req.db.prepare(
    `SELECT COUNT(*) AS customers, SUM(CASE WHEN n > 1 THEN 1 ELSE 0 END) AS returning_customers
     FROM (SELECT customer_id, COUNT(*) n FROM orders WHERE restaurant_id = ? AND status NOT IN ('cancelled','rejected','awaiting_payment') GROUP BY customer_id)`).get(rid);
  const byType = req.db.prepare(
    `SELECT order_type AS type, COUNT(*) AS orders, COALESCE(SUM(total_cents),0) AS revenue
     FROM orders WHERE restaurant_id = ? AND status NOT IN ('cancelled','rejected','awaiting_payment') AND created_at >= ? GROUP BY order_type`).all(rid, from);
  ok(res, {
    topProducts: topProducts.map((p) => ({ name: p.name, quantity: p.qty, revenueCents: p.revenue })),
    ordersByHourUtc: hourly,
    repeatCustomers: { total: repeat.customers || 0, returning: repeat.returning_customers || 0 },
    byOrderType: byType.map((t) => ({ type: t.type, orders: t.orders, revenueCents: t.revenue })),
  });
});

const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
router.get('/reports/orders.csv', requireOwner, requireFeature('advancedReports'), (req, res) => {
  const rows = req.db.prepare(
    "SELECT * FROM orders WHERE restaurant_id = ? AND (payment_method != 'card' OR paid_at IS NOT NULL) ORDER BY created_at DESC LIMIT 10000").all(req.restaurant.id);
  const head = ['order_number', 'created_at', 'status', 'type', 'payment_method', 'payment_status', 'customer', 'subtotal', 'tax', 'delivery_fee', 'service_fee', 'total', 'currency'];
  const lines = [head.join(',')].concat(rows.map((o) => [
    o.order_number, o.created_at, o.status, o.order_type, o.payment_method, o.payment_status, o.customer_name,
    toDecimalString(o.subtotal_cents), toDecimalString(o.tax_cents),
    toDecimalString(o.delivery_fee_cents), toDecimalString(o.platform_fee_cents), toDecimalString(o.total_cents), o.currency,
  ].map(csvCell).join(',')));
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="orders.csv"').send(lines.join('\n'));
});

module.exports = router;
