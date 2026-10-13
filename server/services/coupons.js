// Coupons: codes a customer types at checkout. Managed by the restaurant (routes/manageMenu.js), applied by the ONE order-pricing function
// (services/orders.js priceCart) so the cart quote, the order and the payment always agree.
//
// Pricing and precedence policy (documented in docs/MENU.md):
//   1. Dish prices come first: a dish's own discounted price, else the most specific automatic rule (dish > category > whole menu), see discounts.js.
//   2. A coupon is applied to the ALREADY-PRICED cart. By default it does NOT stack: dishes that are already discounted (manual price or
//      automatic rule) are not eligible. A coupon created with "allow stacking" also applies to them.
//   3. Scope decides the eligible subtotal: 'order' = every dish line and every general extra; 'menu' = every dish line; 'category' = dishes of
//      that category; 'product' = the selected dishes. A dish line includes its own extras.
//   4. Discount = percentage of the eligible subtotal (capped by max_discount_cents) or a fixed amount, never more than the eligible subtotal.
//      The minimum subtotal is compared with the eligible subtotal. At most ONE coupon per order. There are no platform promotions.
//   5. The coupon discount is deducted before tax, the customer's service fee is charged on the discounted food value and commission is
//      charged on it too (money.js computeOrderTotals, unchanged): the restaurant bears the coupon, exactly like any other price reduction.
//
// Limits: usage_limit = total redemptions across all customers (NULL = unlimited); max_uses_per_customer = per customer (default 1 on creation).
// coupon_redemptions (one row per coupon per order): reserved (order placed) -> redeemed (delivered) | released (cancelled, rejected, payment
// failed / expired). Reserved + redeemed count toward both limits; releasing gives the total count back exactly once.
const { tx } = require('../db');
const crypto = require('node:crypto');
const { toDecimalString, mulDiv } = require('./money');
const { percentToBp, parseInstant } = require('./discounts');
const {
  HttpError, fail, str, int, bool,
} = require('../utils');

const MAX_COUPONS = 500;
const MAX_FIXED_CENTS = 1e8;
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
const SCOPES = ['order', 'menu', 'category', 'product'];
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

// "  ahmed20 " -> "AHMED20": Unicode-normalised, whitespace removed, upper-case. Codes are unique per restaurant.
const normalizeCode = (v) => String(v ?? '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();

function generateCode(db, restaurantId) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I: easy to read out and type
  for (let i = 0; i < 20; i++) {
    const code = Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
    if (!db.prepare('SELECT 1 FROM coupons WHERE restaurant_id = ? AND code = ?').get(restaurantId, code)) return code;
  }
  throw new HttpError(503, 'try_again', 'Could not generate a code, please try again');
}

function status(c, nowIso) {
  if (!c.is_active) return 'disabled';
  if (c.ends_at && c.ends_at <= nowIso) return 'expired';
  if (c.usage_limit !== null && c.usage_limit !== undefined && c.used_count >= c.usage_limit) return 'fully_redeemed';
  if (c.starts_at && c.starts_at > nowIso) return 'scheduled';
  return 'active';
}

// ---------------------------------------------------------------- management
function parseCoupon(db, restaurantId, b, cur) {
  const rawCode = b.code !== undefined ? b.code : cur?.code;
  if (rawCode === undefined || rawCode === null || String(rawCode).trim() === '') fail('code', 'is required', 'required');
  const code = normalizeCode(rawCode);
  if (!CODE_RE.test(code)) fail('code', 'use 3 to 32 letters, digits, - or _', 'invalid_coupon_code');

  const scope = b.scope !== undefined ? b.scope : cur?.scope;
  if (!SCOPES.includes(scope)) fail('scope', 'must be order, menu, category or product', 'invalid');
  const kind = b.kind !== undefined ? b.kind : cur?.kind;
  if (!['percent', 'fixed'].includes(kind)) fail('kind', 'must be percent or fixed', 'invalid');
  let value;
  if (kind === 'percent') {
    value = b.percent !== undefined ? percentToBp(b.percent, 'percent') : (cur && cur.kind === 'percent' && b.kind === undefined ? cur.value : null);
    if (value === null) fail('percent', 'is required', 'required');
  } else {
    value = b.amountCents !== undefined ? int(b.amountCents, 'amountCents', { min: 1, max: MAX_FIXED_CENTS }) : (cur && cur.kind === 'fixed' && b.kind === undefined ? cur.value : null);
    if (value === null) fail('amountCents', 'is required', 'required');
  }
  const maxDiscount = kind !== 'percent' ? null
    : (b.maxDiscountCents !== undefined ? int(b.maxDiscountCents, 'maxDiscountCents', { min: 1, max: MAX_FIXED_CENTS, optional: true }) : (cur?.max_discount_cents ?? null));
  const minSubtotal = b.minSubtotalCents !== undefined ? (int(b.minSubtotalCents, 'minSubtotalCents', { min: 0, max: MAX_FIXED_CENTS, optional: true }) ?? 0) : (cur?.min_subtotal_cents ?? 0);
  if (kind === 'fixed' && minSubtotal > 0 && value > minSubtotal) fail('amountCents', 'must not exceed the minimum order amount', 'discount_exceeds_minimum');

  let categoryId = null;
  let productIds = null; // null = unchanged on update
  if (scope === 'category') {
    const raw = b.categoryId !== undefined ? b.categoryId : cur?.category_id;
    if (raw === undefined || raw === null || raw === '') fail('categoryId', 'choose a category', 'required');
    categoryId = int(raw, 'categoryId', { min: 1 });
    if (!db.prepare('SELECT 1 FROM categories WHERE id = ? AND restaurant_id = ?').get(categoryId, restaurantId)) fail('categoryId', 'category does not exist', 'invalid_category');
  }
  if (scope === 'product') {
    const raw = b.productIds !== undefined ? b.productIds : (cur?.scope === 'product' ? cur.productIds : undefined);
    if (!Array.isArray(raw) || raw.length < 1) fail('productIds', 'choose at least one dish', 'required');
    if (raw.length > 200) fail('productIds', 'at most 200 dishes per coupon', 'too_many', { max: 200 });
    productIds = [...new Set(raw.map((x, i) => int(x, `productIds[${i}]`, { min: 1 })))];
    for (const id of productIds) if (!db.prepare('SELECT 1 FROM products WHERE id = ? AND restaurant_id = ?').get(id, restaurantId)) fail('productIds', 'one of the dishes does not exist', 'invalid_product');
  }
  const startsAt = b.startsAt !== undefined ? parseInstant(b.startsAt, 'startsAt') : (cur?.starts_at ?? null);
  const endsAt = b.endsAt !== undefined ? parseInstant(b.endsAt, 'endsAt') : (cur?.ends_at ?? null);
  if (startsAt && endsAt && startsAt >= endsAt) fail('endsAt', 'must be after the start', 'end_before_start');
  const usageLimit = b.usageLimit !== undefined ? int(b.usageLimit, 'usageLimit', { min: 1, max: 1e7, optional: true }) : (cur?.usage_limit ?? null);
  const perCustomer = b.maxUsesPerCustomer !== undefined
    ? int(b.maxUsesPerCustomer, 'maxUsesPerCustomer', { min: 1, max: 1e6, optional: true })
    : (cur ? (cur.max_uses_per_customer ?? null) : 1);
  const text = (key, col, max, optional) => str(b[key] !== undefined ? b[key] : cur?.[col], key, { max, optional });
  return {
    row: {
      code, name_ar: text('nameAr', 'name_ar', 120), name_en: text('nameEn', 'name_en', 120),
      description_ar: text('descriptionAr', 'description_ar', 500, true), description_en: text('descriptionEn', 'description_en', 500, true),
      scope, kind, value, max_discount_cents: maxDiscount, min_subtotal_cents: minSubtotal, category_id: categoryId, starts_at: startsAt, ends_at: endsAt,
      is_active: b.isActive !== undefined ? (bool(b.isActive, 'isActive') ? 1 : 0) : (cur?.is_active ?? 1),
      usage_limit: usageLimit ?? null, max_uses_per_customer: perCustomer ?? null,
      allow_stacking: b.allowStacking !== undefined ? (bool(b.allowStacking, 'allowStacking') ? 1 : 0) : (cur?.allow_stacking ?? 0),
    },
    productIds,
  };
}

const COLS = ['code', 'name_ar', 'name_en', 'description_ar', 'description_en', 'scope', 'kind', 'value', 'max_discount_cents', 'min_subtotal_cents', 'category_id',
  'starts_at', 'ends_at', 'is_active', 'usage_limit', 'max_uses_per_customer', 'allow_stacking'];

function saveCoupon(db, restaurantId, id, parsed) {
  try {
    return tx(db, () => {
      const r = parsed.row;
      let couponId = id;
      if (couponId === null) {
        if (db.prepare('SELECT COUNT(*) c FROM coupons WHERE restaurant_id = ?').get(restaurantId).c >= MAX_COUPONS) {
          throw new HttpError(400, 'validation_error', `coupons: at most ${MAX_COUPONS} coupons`, { field: 'coupons', reason: 'too_many', max: MAX_COUPONS });
        }
        couponId = Number(db.prepare(`INSERT INTO coupons (restaurant_id, ${COLS.join(', ')}) VALUES (?${',?'.repeat(COLS.length)})`).run(restaurantId, ...COLS.map((c) => r[c])).lastInsertRowid);
      } else {
        db.prepare(`UPDATE coupons SET ${COLS.map((c) => `${c} = ?`).join(', ')}, updated_at = ${NOW} WHERE id = ? AND restaurant_id = ?`).run(...COLS.map((c) => r[c]), couponId, restaurantId);
      }
      if (r.scope !== 'product') db.prepare('DELETE FROM coupon_products WHERE coupon_id = ? AND restaurant_id = ?').run(couponId, restaurantId);
      else if (parsed.productIds) {
        db.prepare('DELETE FROM coupon_products WHERE coupon_id = ? AND restaurant_id = ?').run(couponId, restaurantId);
        for (const pid of parsed.productIds) db.prepare('INSERT INTO coupon_products (coupon_id, restaurant_id, product_id) VALUES (?,?,?)').run(couponId, restaurantId, pid);
      }
      return couponId;
    });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'coupon_code_taken', 'This coupon code is already used by your restaurant', { field: 'code', reason: 'coupon_code_taken' });
    throw e;
  }
}

function loadAll(db, restaurantId, id = null) {
  const rows = id === null
    ? db.prepare('SELECT * FROM coupons WHERE restaurant_id = ? ORDER BY id DESC').all(restaurantId)
    : db.prepare('SELECT * FROM coupons WHERE restaurant_id = ? AND id = ?').all(restaurantId, id);
  const links = db.prepare('SELECT coupon_id, product_id FROM coupon_products WHERE restaurant_id = ?').all(restaurantId);
  return rows.map((c) => ({ ...c, productIds: links.filter((l) => l.coupon_id === c.id).map((l) => l.product_id) }));
}

// Dashboard rows with statistics. Only reserved / redeemed redemptions count; a released one (cancelled, failed) is not a redemption.
function describe(db, restaurantId, now = new Date()) {
  const iso = now.toISOString();
  const stats = new Map(db.prepare(
    `SELECT coupon_id, COUNT(*) n, COUNT(DISTINCT customer_id) customers, COALESCE(SUM(discount_cents), 0) total
     FROM coupon_redemptions WHERE restaurant_id = ? AND status != 'released' GROUP BY coupon_id`).all(restaurantId).map((s) => [s.coupon_id, s]));
  return loadAll(db, restaurantId).map((c) => {
    const s = stats.get(c.id);
    return {
      id: c.id, code: c.code, nameAr: c.name_ar, nameEn: c.name_en, descriptionAr: c.description_ar || '', descriptionEn: c.description_en || '',
      scope: c.scope, kind: c.kind, percent: c.kind === 'percent' ? c.value / 100 : null, amountCents: c.kind === 'fixed' ? c.value : null,
      maxDiscountCents: c.max_discount_cents, minSubtotalCents: c.min_subtotal_cents, categoryId: c.category_id, productIds: c.productIds,
      startsAt: c.starts_at, endsAt: c.ends_at, isActive: !!c.is_active, allowStacking: !!c.allow_stacking,
      usageLimit: c.usage_limit, maxUsesPerCustomer: c.max_uses_per_customer ?? null, status: status(c, iso),
      redemptions: s ? s.n : 0, uniqueCustomers: s ? s.customers : 0, totalDiscountCents: s ? s.total : 0,
      remaining: c.usage_limit === null ? null : Math.max(0, c.usage_limit - c.used_count),
      createdAt: c.created_at,
    };
  });
}

function redemptionHistory(db, restaurantId, couponId, limit = 200) {
  return db.prepare(
    `SELECT r.id, r.order_id, r.discount_cents, r.status, r.created_at, r.redeemed_at, r.released_at, o.order_number, o.customer_name, o.total_cents, o.currency
     FROM coupon_redemptions r JOIN orders o ON o.id = r.order_id AND o.restaurant_id = r.restaurant_id
     WHERE r.restaurant_id = ? AND r.coupon_id = ? ORDER BY r.id DESC LIMIT ?`).all(restaurantId, couponId, limit)
    .map((r) => ({ id: r.id, orderId: r.order_id, orderNumber: r.order_number, customerName: r.customer_name, discountCents: r.discount_cents, orderTotalCents: r.total_cents, currency: r.currency, status: r.status, createdAt: r.created_at, redeemedAt: r.redeemed_at, releasedAt: r.released_at }));
}

// Coupons that have redemptions are disabled, never deleted: the audit trail and the orders' history must stay intact.
function removeCoupon(db, restaurantId, id) {
  return tx(db, () => {
    if (!db.prepare('SELECT 1 FROM coupons WHERE id = ? AND restaurant_id = ?').get(id, restaurantId)) return 0;
    if (db.prepare('SELECT 1 FROM coupon_redemptions WHERE coupon_id = ? AND restaurant_id = ?').get(id, restaurantId)) {
      throw new HttpError(409, 'coupon_has_redemptions', 'This coupon has been used. Disable it instead of deleting it.');
    }
    return db.prepare('DELETE FROM coupons WHERE id = ? AND restaurant_id = ?').run(id, restaurantId).changes;
  });
}

// ---------------------------------------------------------------- checkout
const invalid = () => new HttpError(422, 'coupon_invalid', 'This coupon is invalid or has expired.');

// Validates `rawCode` for this restaurant and customer against the priced cart and returns the discount. Reads only; every figure comes from
// the server-priced lines (priceCart), never from the request. Throws a 422 with a stable code the storefront translates.
//   lines:      [{ p, quantity, lineTotal, originalUnit }]    dish lines (originalUnit != null = already discounted)
//   extraLines: [{ lineTotal }]                               general extras
function evaluate(db, { restaurant, customerId, rawCode, lines, extraLines, subtotalCents, now = new Date() }) {
  const code = normalizeCode(rawCode);
  if (!code || !CODE_RE.test(code)) throw invalid();
  // restaurant_id in the WHERE clause: another restaurant's coupon simply does not exist here
  const c = loadAll(db, restaurant.id).find((x) => x.code === code);
  if (!c) throw invalid();
  const st = status(c, now.toISOString());
  if (st === 'disabled' || st === 'expired' || st === 'scheduled') throw invalid();
  if (st === 'fully_redeemed') throw new HttpError(422, 'coupon_exhausted', 'This coupon has been fully redeemed.');
  if (c.max_uses_per_customer !== null) {
    const used = db.prepare("SELECT COUNT(*) n FROM coupon_redemptions WHERE coupon_id = ? AND customer_id = ? AND status != 'released'").get(c.id, customerId).n;
    if (used >= c.max_uses_per_customer) throw new HttpError(422, 'coupon_customer_limit', 'You have reached the usage limit for this coupon.', { max: c.max_uses_per_customer });
  }
  const inScope = (l) => c.scope === 'order' || c.scope === 'menu'
    || (c.scope === 'category' && l.p.category_id === c.category_id)
    || (c.scope === 'product' && c.productIds.includes(l.p.id));
  const dishes = lines.filter(inScope);
  const stackable = !!c.allow_stacking;
  const eligibleLines = dishes.filter((l) => stackable || l.originalUnit === null || l.originalUnit === undefined);
  const eligibleCents = eligibleLines.reduce((s, l) => s + l.lineTotal, 0) + (c.scope === 'order' ? extraLines.reduce((s, x) => s + x.lineTotal, 0) : 0);
  if (eligibleCents <= 0) throw new HttpError(422, 'coupon_not_applicable', 'None of the items in your order qualify for this coupon.');
  if (c.min_subtotal_cents > 0 && eligibleCents < c.min_subtotal_cents) {
    throw new HttpError(422, 'coupon_min_subtotal', `This coupon needs eligible items worth at least ${toDecimalString(c.min_subtotal_cents)} ${restaurant.currency}.`,
      { minCents: c.min_subtotal_cents, minAmount: toDecimalString(c.min_subtotal_cents), currency: restaurant.currency });
  }
  let off = c.kind === 'percent' ? mulDiv(eligibleCents, c.value, 10000) : c.value;
  if (c.max_discount_cents !== null) off = Math.min(off, c.max_discount_cents);
  off = Math.min(off, eligibleCents, subtotalCents - 1); // never more than what it applies to, and always at least 1 cent left to pay: no zero / negative totals
  if (off < 1) throw new HttpError(422, 'coupon_not_applicable', 'None of the items in your order qualify for this coupon.');
  return { coupon: c, discountCents: off, eligibleCents };
}

// Inside the order transaction, after the order row exists. The conditional UPDATE is the authoritative total-limit guard (and locks the row),
// the count below is the authoritative per-customer guard; throwing rolls the whole order back.
function recordRedemption(db, { coupon, orderId, customerId, discountCents }) {
  const nowIso = new Date().toISOString();
  const done = db.prepare(
    `UPDATE coupons SET used_count = used_count + 1 WHERE id = ? AND restaurant_id = ? AND is_active = 1 AND (usage_limit IS NULL OR used_count < usage_limit)
       AND (ends_at IS NULL OR ends_at > ?)`).run(coupon.id, coupon.restaurant_id, nowIso).changes === 1;
  if (!done) throw new HttpError(409, 'coupon_exhausted', 'This coupon is no longer available.');
  if (coupon.max_uses_per_customer !== null) {
    const used = db.prepare("SELECT COUNT(*) n FROM coupon_redemptions WHERE coupon_id = ? AND customer_id = ? AND status != 'released'").get(coupon.id, customerId).n;
    if (used >= coupon.max_uses_per_customer) throw new HttpError(409, 'coupon_customer_limit', 'You have reached the usage limit for this coupon.', { max: coupon.max_uses_per_customer });
  }
  db.prepare('INSERT INTO coupon_redemptions (coupon_id, restaurant_id, customer_id, order_id, code, discount_cents) VALUES (?,?,?,?,?,?)')
    .run(coupon.id, coupon.restaurant_id, customerId, orderId, coupon.code, discountCents);
  db.prepare('UPDATE orders SET coupon_id = ?, coupon_code = ?, coupon_discount_cents = ? WHERE id = ? AND restaurant_id = ?').run(coupon.id, coupon.code, discountCents, orderId, coupon.restaurant_id);
}

function markRedeemed(db, orderId) {
  db.prepare(`UPDATE coupon_redemptions SET status = 'redeemed', redeemed_at = ${NOW} WHERE order_id = ? AND status = 'reserved'`).run(orderId);
}

// Cancelled / rejected / payment failed or expired: give the use back. Idempotent (the status change is the guard).
function releaseForOrder(db, orderId) {
  return tx(db, () => {
    let released = 0;
    for (const r of db.prepare("SELECT id, coupon_id FROM coupon_redemptions WHERE order_id = ? AND status != 'released'").all(orderId)) {
      const moved = db.prepare(`UPDATE coupon_redemptions SET status = 'released', released_at = ${NOW} WHERE id = ? AND status != 'released'`).run(r.id).changes === 1;
      if (!moved) continue;
      db.prepare('UPDATE coupons SET used_count = used_count - 1 WHERE id = ? AND used_count > 0').run(r.coupon_id);
      released += 1;
    }
    return released;
  });
}

// Owner reporting: what coupons cost in a period (orders that were not cancelled / rejected / unpaid).
function reportSummary(db, restaurantId, fromIso) {
  const r = db.prepare(
    `SELECT COUNT(*) orders, COALESCE(SUM(coupon_discount_cents), 0) discount FROM orders
     WHERE restaurant_id = ? AND coupon_discount_cents > 0 AND status NOT IN ('cancelled','rejected','awaiting_payment') AND created_at >= ?`).get(restaurantId, fromIso);
  return { couponOrders: r.orders, couponDiscountCents: r.discount };
}

module.exports = {
  MAX_COUPONS, normalizeCode, generateCode, status, parseCoupon, saveCoupon, loadAll, describe, redemptionHistory, removeCoupon,
  evaluate, recordRedemption, markRedeemed, releaseForOrder, reportSummary,
};
