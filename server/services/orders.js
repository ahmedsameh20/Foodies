const crypto = require('node:crypto');
const config = require('../config');
const { tx } = require('../db');
const { HttpError, notFound, bad } = require('../utils');
const { getSubscription, countMonthlyOrders } = require('./plans');
const { computeOrderTotals } = require('./money');
const { commissionFor, serviceFee } = require('./platform');
const { accountStatus } = require('./paymentAccounts');
const { isOpenNow } = require('./hours');
const ledger = require('./ledger');
const inventory = require('./inventory');
const discounts = require('./discounts');
const coupons = require('./coupons');
const { hasDiscount, originalPriceOf, stockError, extraStockError, isExtraOrderable } = require('./catalog');

const STATUSES = ['awaiting_payment', 'pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled', 'rejected'];
// Orders a restaurant still has to work on
const ACTIVE = ['pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery'];
const TERMINAL = ['delivered', 'cancelled', 'rejected'];

function allowedNext(order) {
  const pickup = order.order_type === 'pickup';
  return {
    awaiting_payment: [], // system only: moves on verified payment, or is cancelled by expiry
    pending: ['confirmed', 'rejected', 'cancelled'],
    confirmed: ['preparing', 'cancelled'],
    preparing: ['ready', 'cancelled'],
    ready: [pickup ? 'delivered' : 'out_for_delivery', 'cancelled'],
    out_for_delivery: ['delivered', 'cancelled'],
    delivered: [], cancelled: [], rejected: [],
  }[order.status];
}

function formatOrder(o, items) {
  return {
    id: o.id, restaurantId: o.restaurant_id, branchId: o.branch_id ?? null, ...(o.branch_name ? { branchName: o.branch_name } : {}), orderNumber: o.order_number, status: o.status,
    orderType: o.order_type, paymentMethod: o.payment_method, paymentStatus: o.payment_status,
    customerName: o.customer_name, customerPhone: o.customer_phone,
    deliveryAddress: o.delivery_address, notes: o.notes,
    subtotalCents: o.subtotal_cents, discountCents: o.discount_cents, taxCents: o.tax_cents,
    deliveryFeeCents: o.delivery_fee_cents, platformFeeCents: o.platform_fee_cents, totalCents: o.total_cents,
    couponCode: o.coupon_code || null, couponDiscountCents: o.coupon_discount_cents || 0,
    currency: o.currency, cancelReason: o.cancel_reason, createdAt: o.created_at, updatedAt: o.updated_at,
    paidAt: o.paid_at, deliveredAt: o.delivered_at,
    ...(o.restaurant_name ? { restaurantName: o.restaurant_name, restaurantNameAr: o.restaurant_name_ar || '', restaurantNameEn: o.restaurant_name_en || '', restaurantSlug: o.restaurant_slug, restaurantWhatsapp: o.restaurant_whatsapp || null } : {}),
    ...(items ? { items } : {}),
  };
}

// The order lines exactly as they were sold: names (in both languages when the restaurant provided them), the dish price at order
// time, the extras with their quantities and prices, and the customer's free-text instructions. Everything comes from snapshot columns,
// so later menu edits never change a past order.
function loadItems(db, orderId, restaurantId) {
  const opts = db.prepare(
    `SELECT order_item_id, group_name, group_name_ar, group_name_en, option_name, option_name_ar, option_name_en, price_cents, quantity
     FROM order_item_options WHERE restaurant_id = ? AND order_item_id IN (SELECT id FROM order_items WHERE order_id = ? AND restaurant_id = ?) ORDER BY id`)
    .all(restaurantId, orderId, restaurantId);
  return db.prepare(
    `SELECT id, product_id, item_kind, extra_id, extra_category, product_name, product_name_ar, product_name_en, unit_price_cents, base_unit_price_cents,
            original_unit_price_cents, quantity, line_total_cents, instructions, discount_rule_id, discount_rule_name
     FROM order_items WHERE order_id = ? AND restaurant_id = ? ORDER BY id`)
    .all(orderId, restaurantId)
    .map((i) => ({
      // kind 'dish' (with its dish-specific extras in `options`) or 'extra' (a general extra ordered on its own: no dish, no options)
      kind: i.item_kind, productId: i.product_id, extraId: i.extra_id, extraCategory: i.extra_category || null, name: i.product_name, nameAr: i.product_name_ar || '', nameEn: i.product_name_en || '',
      // unitPriceCents = ONE dish including its extras; base / original are the dish-only snapshot (originalUnitPriceCents is null when no discount applied)
      unitPriceCents: i.unit_price_cents, baseUnitPriceCents: i.base_unit_price_cents, originalUnitPriceCents: i.original_unit_price_cents,
      quantity: i.quantity, lineTotalCents: i.line_total_cents, instructions: i.instructions || '', discountRuleId: i.discount_rule_id ?? null, discountRuleName: i.discount_rule_name || '',
      options: opts.filter((o) => o.order_item_id === i.id).map((o) => ({
        group: o.group_name, groupAr: o.group_name_ar || '', groupEn: o.group_name_en || '',
        name: o.option_name, nameAr: o.option_name_ar || '', nameEn: o.option_name_en || '',
        priceCents: o.price_cents, quantity: o.quantity,
      })),
    }));
}

// Everything that decides whether (and how) this restaurant can take an order right now.
function assertOrderable(db, restaurant, paymentMethod, provider) {
  if (!restaurant.is_active || restaurant.approval_status !== 'approved') {
    throw new HttpError(403, 'restaurant_unavailable', 'This restaurant is currently unavailable');
  }
  const sub = getSubscription(db, restaurant.id);
  if (!sub || !sub.active) throw new HttpError(403, 'restaurant_unavailable', 'This restaurant is not accepting orders right now');
  if (!restaurant.accepting_orders) throw new HttpError(403, 'not_accepting_orders', 'This restaurant is not accepting orders right now');
  const monthlyLimit = sub.plan.limits.ordersPerMonth;
  if (monthlyLimit !== null && monthlyLimit !== undefined && countMonthlyOrders(db, restaurant.id) >= monthlyLimit) {
    // the customer just sees an unavailable restaurant; the owner sees the plan limit on the dashboard
    throw new HttpError(403, 'not_accepting_orders', 'This restaurant cannot take more orders right now');
  }
  if (!isOpenNow(restaurant.opening_hours, restaurant.timezone)) throw new HttpError(403, 'restaurant_closed', 'This restaurant is closed right now');
  if (paymentMethod === 'card') {
    if (!provider.enabled) throw new HttpError(422, 'card_unavailable', 'Card payment is not available right now. Please pay cash on delivery.');
    if (config.payoutMode === 'provider_settled') {
      const acct = db.prepare('SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(restaurant.id);
      if (accountStatus(acct) !== 'VERIFIED') {
        throw new HttpError(422, 'card_unavailable', 'This restaurant cannot accept card payments yet. Please pay cash on delivery.');
      }
    }
  }
}

// Reads prices ONLY from the database. Returns priced lines + totals; client prices are never consulted.
//   unit price  = the dish's selling price: the discounted price while a discount is active, otherwise the original price
//   one dish    = unit price + sum(extra price x extra quantity)
//   line total  = one dish x dish quantity
// The customer's free-text instructions travel with the line but have no influence on any amount.
// input.items[]  = { productId, quantity, options: [{ optionId, quantity }], instructions }
// input.extras[] = { extraId, quantity }     general extras: independent order lines with their own quantity and price (no dish needed)
function priceCart(db, restaurant, input) {
  // The branch that fulfils the order decides which stock is checked (null = a restaurant without branches: stock lives on the dish).
  const branch = inventory.resolveBranch(db, restaurant.id, { branchId: input.branchId ?? null, latitude: input.latitude ?? null, longitude: input.longitude ?? null });
  const dishStock = branch ? inventory.stockRows(db, restaurant.id, branch.id, 'dish') : null;
  const extraStock = branch ? inventory.stockRows(db, restaurant.id, branch.id, 'extra') : null;
  const rules = discounts.loadActiveRules(db, restaurant.id, new Date(), { customerId: input.customerId ?? null }); // the SAME effective prices the public menu shows this customer
  const merged = new Map();
  for (const l of input.items) {
    const options = [...(l.options || [])].sort((a, b) => a.optionId - b.optionId);
    const instructions = l.instructions || '';
    const key = JSON.stringify([l.productId, options.map((o) => [o.optionId, o.quantity]), instructions]);
    const cur = merged.get(key) || { productId: l.productId, options, instructions, quantity: 0 };
    cur.quantity += l.quantity;
    merged.set(key, cur);
  }
  const lines = [];
  const wanted = new Map(); // productId -> units across all of its lines (stock belongs to the dish, not to one cart line)
  let subtotal = 0;
  for (const m of merged.values()) {
    if (m.quantity > 50) throw bad('quantity: at most 50 of one item per order', { field: 'quantity', reason: 'out_of_range', min: 1, max: 50 });
    // restaurant_id in the WHERE clause is what stops a cart containing another tenant's product.
    const stored = db.prepare('SELECT * FROM products WHERE id = ? AND restaurant_id = ?').get(m.productId, restaurant.id);
    const p = stored && (() => { const priced = discounts.applyToProduct(stored, rules); return branch ? inventory.atBranch(priced, dishStock.get(priced.id)) : priced; })();
    if (!p) throw new HttpError(422, 'invalid_item', `Item ${m.productId} is not on this restaurant's menu`, { productId: m.productId });
    if (!p.is_available) throw new HttpError(422, 'item_unavailable', `"${p.name}" is currently unavailable`, { productId: p.id, name: p.name, nameAr: p.name_ar, nameEn: p.name_en });
    if (p.track_stock) {
      const total = (wanted.get(p.id) || 0) + m.quantity;
      wanted.set(p.id, total);
      if (total > p.stock_quantity) throw stockError(p, total);
    }

    const groups = db.prepare('SELECT id, name, name_ar, name_en, min_select, max_select FROM option_groups WHERE product_id = ? AND restaurant_id = ?').all(p.id, restaurant.id);
    const chosen = [];
    for (const sel of m.options) {
      const o = db.prepare(
        `SELECT o.id, o.name, o.name_ar, o.name_en, o.price_cents, o.is_available, o.max_quantity, o.group_id FROM options o
         WHERE o.id = ? AND o.restaurant_id = ? AND o.group_id IN (SELECT id FROM option_groups WHERE product_id = ? AND restaurant_id = ?)`)
        .get(sel.optionId, restaurant.id, p.id, restaurant.id);
      if (!o) throw new HttpError(422, 'invalid_option', `Option ${sel.optionId} does not belong to "${p.name}"`, { optionId: sel.optionId });
      if (!o.is_available) throw new HttpError(422, 'option_unavailable', `Option "${o.name}" is currently unavailable`, { optionId: o.id, name: o.name, nameAr: o.name_ar, nameEn: o.name_en });
      if (sel.quantity > o.max_quantity) {
        throw new HttpError(422, 'option_quantity_exceeded', `You can add at most ${o.max_quantity} of "${o.name}"`, { optionId: o.id, max: o.max_quantity, name: o.name, nameAr: o.name_ar, nameEn: o.name_en });
      }
      chosen.push({ ...o, quantity: sel.quantity });
    }
    for (const g of groups) {
      const n = chosen.filter((o) => o.group_id === g.id).length; // distinct extras chosen from this group
      if (n < g.min_select || n > g.max_select) {
        throw new HttpError(422, 'invalid_option_count', `Choose ${g.min_select === g.max_select ? g.min_select : `${g.min_select}-${g.max_select}`} option(s) for "${g.name}" on "${p.name}"`,
          { groupId: g.id, min: g.min_select, max: g.max_select, name: g.name, nameAr: g.name_ar, nameEn: g.name_en });
      }
    }
    const extrasTotal = chosen.reduce((s, o) => s + o.price_cents * o.quantity, 0);
    const unit = p.price_cents + extrasTotal; // ONE dish with its extras
    subtotal += unit * m.quantity;
    lines.push({
      p, quantity: m.quantity, unit, lineTotal: unit * m.quantity, instructions: m.instructions,
      baseUnit: p.price_cents, originalUnit: hasDiscount(p) ? originalPriceOf(p) : null,
      options: chosen.map((o) => ({ ...o, group: groups.find((g) => g.id === o.group_id) })),
    });
  }
  // General extras: each is its own order line, priced from restaurant_extras. restaurant_id in the WHERE clause is what stops an order
  // naming another tenant's extra; availability, the per-order maximum and stock are all checked here, never trusted from the browser.
  const extraLines = [];
  for (const want of input.extras || []) {
    const stored = db.prepare('SELECT * FROM restaurant_extras WHERE id = ? AND restaurant_id = ?').get(want.extraId, restaurant.id);
    const e = stored && (branch ? inventory.atBranch(stored, extraStock.get(stored.id)) : stored);
    if (!e) throw new HttpError(422, 'invalid_extra', `Extra ${want.extraId} is not offered by this restaurant`, { extraId: want.extraId });
    const names = { extraId: e.id, name: e.name, nameAr: e.name_ar, nameEn: e.name_en };
    if (!e.is_available) throw new HttpError(422, 'extra_unavailable', `"${e.name}" is currently unavailable`, names);
    if (want.quantity > e.max_quantity) throw new HttpError(422, 'extra_quantity_exceeded', `You can add at most ${e.max_quantity} of "${e.name}"`, { ...names, max: e.max_quantity });
    if (!isExtraOrderable(e) || (e.track_stock && want.quantity > e.stock_quantity)) throw extraStockError(e, want.quantity);
    const lineTotal = e.price_cents * want.quantity;
    subtotal += lineTotal;
    extraLines.push({ e, quantity: want.quantity, unit: e.price_cents, lineTotal });
  }
  if (!input.quote && subtotal < restaurant.min_order_cents) {
    throw new HttpError(422, 'below_minimum', 'Order is below the restaurant minimum', { minOrderCents: restaurant.min_order_cents });
  }
  // One optional coupon, validated and priced here from the server-priced lines (see services/coupons.js for the precedence policy).
  const couponHit = input.couponCode ? coupons.evaluate(db, { restaurant, customerId: input.customerId, rawCode: input.couponCode, lines, extraLines, subtotalCents: subtotal }) : null;
  const commission = commissionFor(db, restaurant);
  const totals = computeOrderTotals({
    subtotalCents: subtotal,
    discountCents: couponHit ? couponHit.discountCents : 0,
    taxRateBp: restaurant.tax_rate_bp,
    deliveryFeeCents: input.orderType === 'delivery' ? restaurant.delivery_fee_cents : 0,
    serviceFee: serviceFee(db),
    commissionBp: commission.bp,
    commissionFixedCents: commission.fixedCents,
  });
  return { lines, extraLines, totals, branch, coupon: couponHit, commissionBp: commission.bp, commissionFixedCents: commission.fixedCents };
}

// The customer's cart as the server prices it (nothing is written): used by the storefront to show the real breakdown and to validate a coupon.
function quoteCart(db, restaurant, input) {
  const priced = priceCart(db, restaurant, { ...input, quote: true });
  const { totals, coupon } = priced;
  const automatic = priced.lines.reduce((s, l) => s + (l.originalUnit !== null && l.originalUnit !== undefined ? (l.originalUnit - l.baseUnit) * l.quantity : 0), 0);
  return {
    subtotalCents: totals.subtotalCents,
    automaticDiscountCents: automatic,
    couponDiscountCents: totals.discountCents,
    coupon: coupon ? { code: coupon.coupon.code, nameAr: coupon.coupon.name_ar, nameEn: coupon.coupon.name_en, discountCents: coupon.discountCents, eligibleSubtotalCents: coupon.eligibleCents } : null,
    taxCents: totals.taxCents, deliveryFeeCents: totals.deliveryFeeCents, platformFeeCents: totals.platformFeeCents, totalCents: totals.totalCents,
    belowMinimum: totals.subtotalCents < restaurant.min_order_cents, minOrderCents: restaurant.min_order_cents, currency: restaurant.currency,
  };
}

// Creates the order and its payment row atomically. Card orders start as "awaiting_payment" and are
// invisible to the restaurant until the provider's payment is verified; cash orders start as "pending".
// Stock of tracked dishes is taken in the same transaction (card orders hold it while awaiting payment; it is given back
// if the order is cancelled, rejected or the payment fails / expires).
function createOrder(db, { restaurant, customer, input, provider }) {
  assertOrderable(db, restaurant, input.paymentMethod, provider);
  return tx(db, () => {
    const { lines, extraLines, totals, branch, coupon, commissionBp, commissionFixedCents } = priceCart(db, restaurant, { ...input, customerId: customer.id });
    const branchId = branch ? branch.id : null;
    const card = input.paymentMethod === 'card';
    const nextNo = db.prepare('SELECT COALESCE(MAX(order_number), 0) + 1 n FROM orders WHERE restaurant_id = ?').get(restaurant.id).n;
    const expires = card ? new Date(Date.now() + config.unpaidOrderTtlMinutes * 60000).toISOString() : null;
    const info = db.prepare(
      `INSERT INTO orders (restaurant_id, customer_id, order_number, status, order_type, payment_method, payment_status,
         customer_name, customer_phone, delivery_address, delivery_latitude, delivery_longitude, notes,
         subtotal_cents, discount_cents, tax_cents, delivery_fee_cents, platform_fee_cents, total_cents,
         commission_bp, commission_fixed_cents, commission_cents, restaurant_amount_cents, currency, expires_at, branch_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(restaurant.id, customer.id, nextNo, card ? 'awaiting_payment' : 'pending', input.orderType, input.paymentMethod,
        card ? 'awaiting_payment' : 'cod_pending', input.customerName, input.customerPhone, input.deliveryAddress,
        input.latitude ?? null, input.longitude ?? null, input.notes,
        totals.subtotalCents, totals.discountCents, totals.taxCents, totals.deliveryFeeCents, totals.platformFeeCents,
        totals.totalCents, commissionBp, commissionFixedCents, totals.commissionCents, totals.restaurantAmountCents, restaurant.currency, expires, branchId);
    const orderId = Number(info.lastInsertRowid);
    const insItem = db.prepare(
      `INSERT INTO order_items (order_id, restaurant_id, product_id, product_name, product_name_ar, product_name_en, unit_price_cents,
         base_unit_price_cents, original_unit_price_cents, quantity, line_total_cents, instructions, stock_deducted, discount_rule_id, discount_rule_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insOpt = db.prepare(
      `INSERT INTO order_item_options (order_item_id, restaurant_id, option_id, group_name, group_name_ar, group_name_en,
         option_name, option_name_ar, option_name_en, price_cents, quantity) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const l of lines) {
      // Authoritative stock guard: one conditional UPDATE inside the serialised transaction. A concurrent order that took the last
      // units makes this fail, the whole order rolls back, and the customer gets a clear stock message.
      if (l.p.track_stock && !inventory.reserve(db, restaurant.id, branchId, l.p.id, l.quantity)) {
        const fresh = db.prepare('SELECT * FROM products WHERE id = ? AND restaurant_id = ?').get(l.p.id, restaurant.id);
        throw stockError(branch ? inventory.atBranch(fresh, inventory.stockRows(db, restaurant.id, branchId, 'dish').get(fresh.id)) : fresh, l.quantity);
      }
      const itemId = Number(insItem.run(orderId, restaurant.id, l.p.id, l.p.name, l.p.name_ar, l.p.name_en, l.unit, l.baseUnit, l.originalUnit,
        l.quantity, l.lineTotal, l.instructions || null, l.p.track_stock ? l.quantity : 0, l.p.discount_rule_id, l.p.discount_rule_id ? (l.p.discount_rule_name_en || l.p.discount_rule_name_ar) : null).lastInsertRowid);
      for (const o of l.options) insOpt.run(itemId, restaurant.id, o.id, o.group.name, o.group.name_ar, o.group.name_en, o.name, o.name_ar, o.name_en, o.price_cents, o.quantity);
    }
    // General extras are independent lines (item_kind 'extra', no product): the name, category and unit price are snapshotted like a dish.
    const insExtra = db.prepare(
      `INSERT INTO order_items (order_id, restaurant_id, product_id, item_kind, extra_id, extra_category, product_name, product_name_ar, product_name_en,
         unit_price_cents, base_unit_price_cents, quantity, line_total_cents, stock_deducted)
       VALUES (?,?,NULL,'extra',?,?,?,?,?,?,?,?,?,?)`);
    for (const x of extraLines) {
      if (x.e.track_stock && !inventory.reserveExtra(db, restaurant.id, branchId, x.e.id, x.quantity)) {
        const fresh = db.prepare('SELECT * FROM restaurant_extras WHERE id = ? AND restaurant_id = ?').get(x.e.id, restaurant.id);
        throw extraStockError(branch ? inventory.atBranch(fresh, inventory.stockRows(db, restaurant.id, branchId, 'extra').get(fresh.id)) : fresh, x.quantity);
      }
      insExtra.run(orderId, restaurant.id, x.e.id, x.e.category, x.e.name, x.e.name_ar, x.e.name_en, x.unit, x.unit, x.quantity, x.lineTotal, x.e.track_stock ? x.quantity : 0);
    }
    discounts.recordUse(db, restaurant.id, lines.map((l) => l.p.discount_rule_id), { orderId, customerId: customer.id });
    if (coupon) coupons.recordRedemption(db, { coupon: coupon.coupon, orderId, customerId: customer.id, discountCents: coupon.discountCents });
    const fee = card ? ledger.estimateProviderFee(totals.totalCents) : 0;
    const payInfo = db.prepare(
      `INSERT INTO payments (order_id, customer_id, restaurant_id, provider, amount_cents, currency, payment_method, status, estimated_fee_cents)
       VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(orderId, customer.id, restaurant.id, card ? provider.name : 'cod', totals.totalCents, restaurant.currency,
        input.paymentMethod, card ? 'initiated' : 'cod_pending', fee);
    db.prepare('INSERT INTO order_status_history (order_id, restaurant_id, status, changed_by) VALUES (?,?,?,?)')
      .run(orderId, restaurant.id, card ? 'awaiting_payment' : 'pending', customer.id);
    db.prepare('INSERT OR IGNORE INTO restaurant_customers (restaurant_id, user_id) VALUES (?,?)').run(restaurant.id, customer.id);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    return { order, paymentId: Number(payInfo.lastInsertRowid), items: loadItems(db, orderId, restaurant.id) };
  });
}

// Role-aware status change, scoped to one restaurant (or to the customer's own order).
// Returns { order, refundNeeded } - refundNeeded is true when a paid online order was cancelled/rejected
// and the caller must now issue the (idempotent) refund through the payment provider.
function changeStatus(db, { restaurantId, orderId, status, actor, reason = null, customerOnly = false }) {
  return tx(db, () => {
    const where = customerOnly ? 'id = ? AND restaurant_id = ? AND customer_id = ?' : 'id = ? AND restaurant_id = ?';
    const args = customerOnly ? [orderId, restaurantId, actor.id] : [orderId, restaurantId];
    const order = db.prepare(`SELECT * FROM orders WHERE ${where}`).get(...args);
    if (!order) throw notFound('Order');
    if (!allowedNext(order).includes(status)) {
      throw new HttpError(409, 'invalid_transition', `An order that is ${order.status.replace(/_/g, ' ')} cannot be changed to ${status.replace(/_/g, ' ')}`);
    }
    if (customerOnly && !(order.status === 'pending' && status === 'cancelled')) {
      throw new HttpError(409, 'invalid_transition', 'You can only cancel an order that the restaurant has not confirmed yet');
    }
    const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);
    const closing = status === 'cancelled' || status === 'rejected';
    let paymentStatus = order.payment_status;
    let refundNeeded = false;

    if (closing) {
      inventory.restoreForOrder(db, orderId, restaurantId); // idempotent: the units go back to stock exactly once
      discounts.releaseForOrder(db, orderId); // idempotent: the discount uses are given back exactly once
      coupons.releaseForOrder(db, orderId); // ...and the coupon use
      if (order.payment_method === 'cod') {
        paymentStatus = 'cancelled';
        db.prepare("UPDATE payments SET status = 'cancelled' WHERE id = ?").run(payment.id);
      } else if (payment.status === 'succeeded' || payment.status === 'partially_refunded') {
        refundNeeded = payment.amount_cents - payment.refunded_cents > 0;
      }
    }
    if (status === 'delivered') {
      discounts.markRedeemed(db, orderId);
      coupons.markRedeemed(db, orderId);
      if (order.payment_method === 'cod') {
        paymentStatus = 'cash_collected';
        db.prepare("UPDATE payments SET status = 'cash_collected' WHERE id = ?").run(payment.id);
      }
    }
    db.prepare(
      `UPDATE orders SET status = ?, payment_status = ?, cancel_reason = COALESCE(?, cancel_reason),
         delivered_at = CASE WHEN ? = 'delivered' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE delivered_at END
       WHERE id = ? AND restaurant_id = ?`).run(status, paymentStatus, closing ? (reason || `${status} by ${actor.role}`) : null, status, orderId, restaurantId);
    db.prepare('INSERT INTO order_status_history (order_id, restaurant_id, status, changed_by) VALUES (?,?,?,?)')
      .run(orderId, restaurantId, status, actor.id);

    if (status === 'delivered') {
      const fresh = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (order.payment_method === 'cod') ledger.recordCodCommission(db, fresh, payment);
      else ledger.markSaleEligible(db, orderId);
    }
    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    return { order: formatOrder(updated, loadItems(db, orderId, restaurantId)), refundNeeded, rawOrder: updated };
  });
}

const newKey = () => crypto.randomBytes(12).toString('hex');

module.exports = {
  STATUSES, ACTIVE, TERMINAL, allowedNext, formatOrder, loadItems, createOrder, changeStatus, priceCart, quoteCart, assertOrderable, newKey,
};
