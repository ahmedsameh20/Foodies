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
    id: o.id, restaurantId: o.restaurant_id, orderNumber: o.order_number, status: o.status,
    orderType: o.order_type, paymentMethod: o.payment_method, paymentStatus: o.payment_status,
    customerName: o.customer_name, customerPhone: o.customer_phone,
    deliveryAddress: o.delivery_address, notes: o.notes,
    subtotalCents: o.subtotal_cents, discountCents: o.discount_cents, taxCents: o.tax_cents,
    deliveryFeeCents: o.delivery_fee_cents, platformFeeCents: o.platform_fee_cents, totalCents: o.total_cents,
    currency: o.currency, cancelReason: o.cancel_reason, createdAt: o.created_at, updatedAt: o.updated_at,
    paidAt: o.paid_at, deliveredAt: o.delivered_at,
    ...(o.restaurant_name ? { restaurantName: o.restaurant_name, restaurantSlug: o.restaurant_slug, restaurantWhatsapp: o.restaurant_whatsapp || null } : {}),
    ...(items ? { items } : {}),
  };
}

function loadItems(db, orderId, restaurantId) {
  const opts = db.prepare('SELECT order_item_id, group_name, option_name, price_cents FROM order_item_options WHERE restaurant_id = ? AND order_item_id IN (SELECT id FROM order_items WHERE order_id = ? AND restaurant_id = ?)')
    .all(restaurantId, orderId, restaurantId);
  return db.prepare(
    `SELECT id, product_id, product_name, unit_price_cents, quantity, line_total_cents
     FROM order_items WHERE order_id = ? AND restaurant_id = ? ORDER BY id`)
    .all(orderId, restaurantId)
    .map((i) => ({
      productId: i.product_id, name: i.product_name, unitPriceCents: i.unit_price_cents,
      quantity: i.quantity, lineTotalCents: i.line_total_cents,
      options: opts.filter((o) => o.order_item_id === i.id).map((o) => ({ group: o.group_name, name: o.option_name, priceCents: o.price_cents })),
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
function priceCart(db, restaurant, input) {
  const merged = new Map();
  for (const l of input.items) {
    const optionIds = [...new Set(l.optionIds || [])].sort((a, b) => a - b);
    const key = `${l.productId}:${optionIds.join(',')}`;
    const cur = merged.get(key) || { productId: l.productId, optionIds, quantity: 0 };
    cur.quantity += l.quantity;
    merged.set(key, cur);
  }
  const lines = [];
  let subtotal = 0;
  for (const m of merged.values()) {
    if (m.quantity > 50) throw bad('quantity: at most 50 of one item per order', { field: 'quantity' });
    // restaurant_id in the WHERE clause is what stops a cart containing another tenant's product.
    const p = db.prepare('SELECT id, name, price_cents, is_available FROM products WHERE id = ? AND restaurant_id = ?').get(m.productId, restaurant.id);
    if (!p) throw new HttpError(422, 'invalid_item', `Item ${m.productId} is not on this restaurant's menu`, { productId: m.productId });
    if (!p.is_available) throw new HttpError(422, 'item_unavailable', `"${p.name}" is currently unavailable`, { productId: p.id });

    const groups = db.prepare('SELECT id, name, min_select, max_select FROM option_groups WHERE product_id = ? AND restaurant_id = ?').all(p.id, restaurant.id);
    const chosen = [];
    for (const optionId of m.optionIds) {
      const o = db.prepare(
        `SELECT o.id, o.name, o.price_cents, o.is_available, o.group_id FROM options o
         WHERE o.id = ? AND o.restaurant_id = ? AND o.group_id IN (SELECT id FROM option_groups WHERE product_id = ? AND restaurant_id = ?)`)
        .get(optionId, restaurant.id, p.id, restaurant.id);
      if (!o) throw new HttpError(422, 'invalid_option', `Option ${optionId} does not belong to "${p.name}"`, { optionId });
      if (!o.is_available) throw new HttpError(422, 'option_unavailable', `Option "${o.name}" is currently unavailable`, { optionId });
      chosen.push(o);
    }
    for (const g of groups) {
      const n = chosen.filter((o) => o.group_id === g.id).length;
      if (n < g.min_select || n > g.max_select) {
        throw new HttpError(422, 'invalid_option_count', `Choose ${g.min_select === g.max_select ? g.min_select : `${g.min_select}-${g.max_select}`} option(s) for "${g.name}" on "${p.name}"`, { groupId: g.id });
      }
    }
    const optionsTotal = chosen.reduce((s, o) => s + o.price_cents, 0);
    const unit = p.price_cents + optionsTotal;
    subtotal += unit * m.quantity;
    lines.push({
      p, quantity: m.quantity, unit, lineTotal: unit * m.quantity,
      options: chosen.map((o) => ({ ...o, groupName: groups.find((g) => g.id === o.group_id).name })),
    });
  }
  if (subtotal < restaurant.min_order_cents) {
    throw new HttpError(422, 'below_minimum', 'Order is below the restaurant minimum', { minOrderCents: restaurant.min_order_cents });
  }
  const commission = commissionFor(db, restaurant);
  const totals = computeOrderTotals({
    subtotalCents: subtotal,
    taxRateBp: restaurant.tax_rate_bp,
    deliveryFeeCents: input.orderType === 'delivery' ? restaurant.delivery_fee_cents : 0,
    serviceFee: serviceFee(db),
    commissionBp: commission.bp,
    commissionFixedCents: commission.fixedCents,
  });
  return { lines, totals, commissionBp: commission.bp, commissionFixedCents: commission.fixedCents };
}

// Creates the order and its payment row atomically. Card orders start as "awaiting_payment" and are
// invisible to the restaurant until the provider's payment is verified; cash orders start as "pending".
function createOrder(db, { restaurant, customer, input, provider }) {
  assertOrderable(db, restaurant, input.paymentMethod, provider);
  return tx(db, () => {
    const { lines, totals, commissionBp, commissionFixedCents } = priceCart(db, restaurant, input);
    const card = input.paymentMethod === 'card';
    const nextNo = db.prepare('SELECT COALESCE(MAX(order_number), 0) + 1 n FROM orders WHERE restaurant_id = ?').get(restaurant.id).n;
    const expires = card ? new Date(Date.now() + config.unpaidOrderTtlMinutes * 60000).toISOString() : null;
    const info = db.prepare(
      `INSERT INTO orders (restaurant_id, customer_id, order_number, status, order_type, payment_method, payment_status,
         customer_name, customer_phone, delivery_address, delivery_latitude, delivery_longitude, notes,
         subtotal_cents, discount_cents, tax_cents, delivery_fee_cents, platform_fee_cents, total_cents,
         commission_bp, commission_fixed_cents, commission_cents, restaurant_amount_cents, currency, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(restaurant.id, customer.id, nextNo, card ? 'awaiting_payment' : 'pending', input.orderType, input.paymentMethod,
        card ? 'awaiting_payment' : 'cod_pending', input.customerName, input.customerPhone, input.deliveryAddress,
        input.latitude ?? null, input.longitude ?? null, input.notes,
        totals.subtotalCents, totals.discountCents, totals.taxCents, totals.deliveryFeeCents, totals.platformFeeCents,
        totals.totalCents, commissionBp, commissionFixedCents, totals.commissionCents, totals.restaurantAmountCents, restaurant.currency, expires);
    const orderId = Number(info.lastInsertRowid);
    const insItem = db.prepare(
      `INSERT INTO order_items (order_id, restaurant_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
       VALUES (?,?,?,?,?,?,?)`);
    const insOpt = db.prepare('INSERT INTO order_item_options (order_item_id, restaurant_id, option_id, group_name, option_name, price_cents) VALUES (?,?,?,?,?,?)');
    for (const l of lines) {
      const itemId = Number(insItem.run(orderId, restaurant.id, l.p.id, l.p.name, l.unit, l.quantity, l.lineTotal).lastInsertRowid);
      for (const o of l.options) insOpt.run(itemId, restaurant.id, o.id, o.groupName, o.name, o.price_cents);
    }
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
      if (order.payment_method === 'cod') {
        paymentStatus = 'cancelled';
        db.prepare("UPDATE payments SET status = 'cancelled' WHERE id = ?").run(payment.id);
      } else if (payment.status === 'succeeded' || payment.status === 'partially_refunded') {
        refundNeeded = payment.amount_cents - payment.refunded_cents > 0;
      }
    }
    if (status === 'delivered') {
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
  STATUSES, ACTIVE, TERMINAL, allowedNext, formatOrder, loadItems, createOrder, changeStatus, priceCart, assertOrderable, newKey,
};
