// Payment orchestration: starting card payments, verifying provider confirmations, refunds.
// Money state only ever changes from a provider-verified source (webhook re-checked against the provider's
// API, or a direct API lookup) - never from anything the browser sends.
const config = require('../config');
const logger = require('../logger');
const { tx } = require('../db');
const { HttpError, notFound } = require('../utils');
const ledger = require('./ledger');
const { audit } = require('./platform');
const { ProviderError } = require('../payments/provider');
const { mulDiv } = require('./money');
const subscriptions = require('./subscriptions');
const payouts = require('./payouts');

const webhookUrl = () => `${config.appUrl}/webhooks/${config.paymentProvider}`;

// ---------------------------------------------------------------- starting a card payment
// Called after createOrder() committed. The provider call is made OUTSIDE the DB transaction (network I/O);
// any failure leaves the order cancelled and the payment failed, never half-created.
async function startCardPayment(db, provider, { order, paymentId, restaurant, customer }) {
  let destination = null;
  if (config.payoutMode === 'provider_settled') {
    const acct = db.prepare('SELECT connected_account_id FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(restaurant.id);
    const payment = db.prepare('SELECT estimated_fee_cents FROM payments WHERE id = ?').get(paymentId);
    // The restaurant's share is routed straight to its connected account; the remainder stays with the platform.
    const restaurantShare = order.total_cents - order.commission_cents - order.platform_fee_cents - ledger.restaurantBorneFee(payment.estimated_fee_cents);
    destination = { id: acct.connected_account_id, amountCents: restaurantShare };
  }
  try {
    const charge = await provider.createCharge({
      paymentId, orderId: order.id, amountCents: order.total_cents, currency: order.currency,
      customer: { firstName: customer.name.split(' ')[0].slice(0, 40) || 'Customer', email: customer.email },
      destination, description: `Order #${order.order_number} at ${restaurant.name}`.slice(0, 120),
      returnUrl: `${config.appUrl}/order.html?id=${order.id}`, webhookUrl: webhookUrl(),
    });
    db.prepare("UPDATE payments SET provider_transaction_id = ?, status = 'pending' WHERE id = ? AND status = 'initiated'")
      .run(charge.providerTransactionId, paymentId);
    logger.info('payment.initiated', { paymentId, orderId: order.id, provider: provider.name, amountCents: order.total_cents });
    return { redirectUrl: charge.redirectUrl };
  } catch (e) {
    failPayment(db, paymentId, e instanceof ProviderError ? e.message : 'Could not start payment', 'payment_failed');
    logger.error('payment.initiate_failed', { paymentId, orderId: order.id, error: e });
    throw new HttpError(502, 'payment_provider_error', 'We could not start the payment. Please try again or choose cash on delivery.');
  }
}

// ---------------------------------------------------------------- confirming / failing
// Idempotent: calling twice (duplicate webhook, webhook + return-page refresh, sweeper) is safe.
// Returns { changed, needsRefund }.
function markPaid(db, paymentId, { source = null } = {}) {
  const r = tx(db, () => {
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!payment) throw notFound('Payment');
    if (payment.status === 'succeeded' || payment.status === 'refunded' || payment.status === 'partially_refunded') {
      return { changed: false, needsRefund: false };
    }
    if (!['initiated', 'pending', 'failed', 'cancelled'].includes(payment.status)) return { changed: false, needsRefund: false };
    db.prepare("UPDATE payments SET status = 'succeeded', failure_reason = NULL, payment_source = COALESCE(?, payment_source) WHERE id = ?").run(source, paymentId);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(payment.order_id);
    let needsRefund = false;
    if (order.status === 'awaiting_payment') {
      db.prepare("UPDATE orders SET status = 'pending', payment_status = 'paid', paid_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), expires_at = NULL WHERE id = ?").run(order.id);
      db.prepare('INSERT INTO order_status_history (order_id, restaurant_id, status) VALUES (?,?,?)').run(order.id, order.restaurant_id, 'pending');
    } else {
      // The customer paid after we had already cancelled the unpaid order (expiry race): take the money
      // into the books, then refund it in full below.
      db.prepare("UPDATE orders SET payment_status = 'paid', paid_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(order.id);
      needsRefund = true;
    }
    const fresh = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    const freshPayment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    ledger.recordSale(db, fresh, freshPayment);
    return { changed: true, needsRefund, orderId: order.id };
  });
  if (r.changed) logger.info('payment.succeeded', { paymentId, orderId: r.orderId });
  return r;
}

function failPayment(db, paymentId, reason, orderReason = 'payment_failed') {
  return tx(db, () => {
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!payment || ['succeeded', 'refunded', 'partially_refunded', 'cod_pending', 'cash_collected'].includes(payment.status)) return { changed: false };
    db.prepare("UPDATE payments SET status = 'failed', failure_reason = ? WHERE id = ?").run(String(reason).slice(0, 300), paymentId);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(payment.order_id);
    if (order.status === 'awaiting_payment') {
      db.prepare("UPDATE orders SET status = 'cancelled', payment_status = 'failed', cancel_reason = ?, expires_at = NULL WHERE id = ?").run(orderReason, order.id);
      db.prepare('INSERT INTO order_status_history (order_id, restaurant_id, status) VALUES (?,?,?)').run(order.id, order.restaurant_id, 'cancelled');
    }
    return { changed: true };
  });
}

// Ask the provider (authoritative) what happened to this payment and apply it. Used by the webhook handler,
// the customer's "I've paid" refresh and the unpaid-order sweeper.
async function reconcilePayment(db, provider, paymentId) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment || payment.payment_method !== 'card' || !payment.provider_transaction_id) return { status: payment?.status || 'unknown' };
  const charge = await provider.retrieveCharge(payment.provider_transaction_id);
  // Defence against a forged/mismatched confirmation: the provider's record must match our own.
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(payment.order_id);
  if (charge.amountCents !== payment.amount_cents || charge.currency !== payment.currency || charge.orderRef !== `ord_${order.id}`) {
    logger.error('payment.mismatch', { paymentId, expected: { amount: payment.amount_cents, currency: payment.currency, ref: `ord_${order.id}` }, got: { amount: charge.amountCents, currency: charge.currency, ref: charge.orderRef } });
    return { status: 'mismatch' };
  }
  if (charge.isSuccess) {
    const r = markPaid(db, paymentId, { source: charge.source });
    if (r.needsRefund) await refundPayment(db, provider, { paymentId, reason: 'Order was cancelled before payment completed', idempotencyKey: `auto:late-payment:${payment.order_id}`, actor: null });
    return { status: 'succeeded' };
  }
  if (charge.isFailure) {
    failPayment(db, paymentId, charge.failureReason || charge.status);
    return { status: 'failed' };
  }
  return { status: 'pending' };
}

// ---------------------------------------------------------------- webhooks
// Never trusts the body: 1) signature, 2) de-duplication, 3) re-check against the provider's API.
async function handlePayoutWebhook(db, provider, ev) {
  if (ev.invalidSignature) {
    logger.warn('webhook.invalid_signature', { provider: provider.name, kind: 'payout' });
    throw new HttpError(401, 'invalid_signature', 'Invalid webhook signature');
  }
  const eventKey = `payout:${ev.eventId}`;
  try {
    db.prepare('INSERT INTO webhook_events (provider, event_key, event_type, object_id, payload) VALUES (?,?,?,?,?)')
      .run(provider.name, eventKey, 'payout', String(ev.providerPayoutId), JSON.stringify(logger.redact(ev.raw || {})).slice(0, 8000));
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return { duplicate: true };
    throw e;
  }
  const finish = (status, error) => db.prepare("UPDATE webhook_events SET status = ?, error = ?, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE provider = ? AND event_key = ?")
    .run(status, error || null, provider.name, eventKey);
  try {
    // Prefer the provider's authoritative record over the webhook body whenever the adapter can fetch it.
    let facts = { status: ev.status, amountCents: ev.amountCents, currency: ev.currency, failureReason: ev.failureReason };
    try {
      const fresh = await provider.getPayout(ev.providerPayoutId);
      facts = { status: fresh.status, amountCents: fresh.amountCents, currency: fresh.currency, failureReason: fresh.failureReason };
    } catch (e) {
      if (!(e instanceof ProviderError) || e.code !== 'capability_not_verified') throw e;
    }
    const r = payouts.applyProviderEvent(db, { eventId: ev.eventId, providerPayoutId: ev.providerPayoutId, ...facts });
    finish(r.mismatch ? 'failed' : r.unknown ? 'ignored' : 'processed', r.mismatch ? 'amount/currency mismatch' : r.unknown ? 'unknown payout' : null);
    return { processed: true, ...r };
  } catch (e) {
    db.prepare('DELETE FROM webhook_events WHERE provider = ? AND event_key = ?').run(provider.name, eventKey);
    logger.error('webhook.failed', { eventKey, error: e });
    throw new HttpError(503, 'try_again', 'Temporarily unable to process the event');
  }
}

async function handleWebhook(db, provider, { headers, body }) {
  if (!provider.enabled) throw new HttpError(404, 'not_found', 'Not found');
  // Payout events have their own signature scheme; only adapters that implement it can have them applied.
  if (typeof provider.parsePayoutEvent === 'function') {
    const ev = provider.parsePayoutEvent(headers, body);
    if (ev) return handlePayoutWebhook(db, provider, ev);
  }
  if (!provider.verifyWebhook(headers, body)) {
    logger.warn('webhook.invalid_signature', { provider: provider.name, objectId: body?.id });
    throw new HttpError(401, 'invalid_signature', 'Invalid webhook signature');
  }
  const objectId = String(body.id || '');
  const objectType = String(body.object || 'charge');
  const eventKey = `${objectType}:${objectId}:${String(body.status || '').toUpperCase()}`;
  try {
    db.prepare('INSERT INTO webhook_events (provider, event_key, event_type, object_id, payload) VALUES (?,?,?,?,?)')
      .run(provider.name, eventKey, objectType, objectId, JSON.stringify(logger.redact(body)).slice(0, 8000));
  } catch (e) {
    if (/UNIQUE/.test(e.message)) { logger.info('webhook.duplicate', { eventKey }); return { duplicate: true }; }
    throw e;
  }
  const finish = (status, error) => db.prepare('UPDATE webhook_events SET status = ?, error = ?, processed_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE provider = ? AND event_key = ?')
    .run(status, error || null, provider.name, eventKey);

  if (objectType !== 'charge') {
    // Refund / payout / onboarding events: recorded for operators, but state is only changed through
    // authenticated API calls and admin actions (the provider's signature scheme for these is not documented).
    finish('ignored');
    logger.info('webhook.recorded_unhandled', { objectType, eventKey });
    return { ignored: true };
  }
  const payment = db.prepare("SELECT id FROM payments WHERE provider = ? AND provider_transaction_id = ?").get(provider.name, objectId);
  if (!payment) {
    // Not a customer order payment: it may be a restaurant's SaaS subscription invoice (a separate ledger).
    try {
      const r = await subscriptions.reconcileInvoiceCharge(db, provider, objectId);
      if (r.status === 'unrelated') { finish('ignored', 'unknown charge'); logger.warn('webhook.unknown_charge', { objectId }); return { ignored: true }; }
      finish(['mismatch', 'void'].includes(r.status) ? 'failed' : 'processed', ['mismatch', 'void'].includes(r.status) ? r.status : null);
      logger.info('webhook.invoice', { eventKey, result: r.status });
      return { processed: true, invoice: r.status };
    } catch (e) {
      db.prepare('DELETE FROM webhook_events WHERE provider = ? AND event_key = ?').run(provider.name, eventKey);
      logger.error('webhook.failed', { eventKey, error: e });
      throw new HttpError(503, 'try_again', 'Temporarily unable to process the event');
    }
  }
  try {
    const r = await reconcilePayment(db, provider, payment.id);
    finish(r.status === 'mismatch' ? 'failed' : 'processed', r.status === 'mismatch' ? 'amount/currency/reference mismatch' : null);
    logger.info('webhook.processed', { eventKey, result: r.status });
    return { processed: true, status: r.status };
  } catch (e) {
    // Allow the provider's retry (and our own reconciliation) to try again.
    db.prepare('DELETE FROM webhook_events WHERE provider = ? AND event_key = ?').run(provider.name, eventKey);
    logger.error('webhook.failed', { eventKey, error: e });
    throw new HttpError(503, 'try_again', 'Temporarily unable to process the event');
  }
}

// ---------------------------------------------------------------- refunds
const reservedRefundCents = (db, paymentId) =>
  db.prepare("SELECT COALESCE(SUM(amount_cents),0) s FROM refunds WHERE payment_id = ? AND status IN ('pending','succeeded')").get(paymentId).s;

// Full or partial refund. Idempotent per (idempotencyKey): replaying returns the original refund and never
// calls the provider or touches the ledger a second time.
async function refundPayment(db, provider, { paymentId, amountCents = null, reason, idempotencyKey, actor }) {
  const key = `${paymentId}:${idempotencyKey}`;
  const existing = db.prepare('SELECT * FROM refunds WHERE idempotency_key = ?').get(key);
  if (existing) return { refund: existing, replayed: true };

  const refund = tx(db, () => {
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!payment) throw notFound('Payment');
    if (payment.payment_method !== 'card') throw new HttpError(422, 'not_refundable', 'Cash orders have no online payment to refund');
    if (!['succeeded', 'partially_refunded'].includes(payment.status)) throw new HttpError(422, 'not_refundable', 'Only successful online payments can be refunded');
    const available = payment.amount_cents - reservedRefundCents(db, paymentId);
    const amount = amountCents ?? available;
    if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, 'validation_error', 'amount: must be a positive whole number of cents', { field: 'amount' });
    if (amount > available) throw new HttpError(422, 'refund_exceeds_payment', `At most ${available} cents can still be refunded`, { availableCents: available });
    const info = db.prepare(
      `INSERT INTO refunds (payment_id, order_id, restaurant_id, amount_cents, currency, reason, status, idempotency_key, requested_by)
       VALUES (?,?,?,?,?,?,'pending',?,?)`)
      .run(paymentId, payment.order_id, payment.restaurant_id, amount, payment.currency, String(reason).slice(0, 300), key, actor?.id ?? null);
    return db.prepare('SELECT * FROM refunds WHERE id = ?').get(info.lastInsertRowid);
  });

  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(payment.order_id);
  let result;
  try {
    let destination = null;
    if (config.payoutMode === 'provider_settled') {
      const acct = db.prepare('SELECT connected_account_id FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(payment.restaurant_id);
      if (acct?.connected_account_id) {
        // take back from the restaurant only its proportional share
        const restaurantPart = order.total_cents - order.commission_cents - order.platform_fee_cents;
        destination = { id: acct.connected_account_id, amountCents: mulDiv(restaurantPart, refund.amount_cents, payment.amount_cents) };
      }
    }
    result = await provider.createRefund({
      providerTransactionId: payment.provider_transaction_id, amountCents: refund.amount_cents, currency: refund.currency,
      reason: refund.reason, idempotencyKey: key, destination, webhookUrl: webhookUrl(),
    });
  } catch (e) {
    db.prepare("UPDATE refunds SET status = 'failed', failure_reason = ? WHERE id = ?").run(String(e.message).slice(0, 300), refund.id);
    logger.error('refund.failed', { refundId: refund.id, paymentId, error: e });
    throw new HttpError(502, 'payment_provider_error', 'The payment provider could not process the refund. Nothing was changed; please retry.');
  }
  const final = applyRefundResult(db, refund.id, result);
  if (actor) audit(db, { user: actor }, 'refund.created', 'refund', refund.id, { paymentId, amountCents: refund.amount_cents, reason: refund.reason, status: final.status });
  logger.info('refund.result', { refundId: refund.id, paymentId, status: final.status, amountCents: refund.amount_cents });
  return { refund: final, replayed: false };
}

// Apply the provider's answer. Idempotent: only a 'pending' refund can change state.
function applyRefundResult(db, refundId, result) {
  return tx(db, () => {
    const refund = db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
    if (refund.status !== 'pending') return refund;
    if (result.status === 'pending') {
      db.prepare('UPDATE refunds SET provider_refund_id = COALESCE(?, provider_refund_id) WHERE id = ?').run(result.providerRefundId, refundId);
      return db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
    }
    if (result.status === 'failed') {
      db.prepare("UPDATE refunds SET status = 'failed', provider_refund_id = ?, failure_reason = ? WHERE id = ?")
        .run(result.providerRefundId, String(result.failureReason || 'declined').slice(0, 300), refundId);
      return db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
    }
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(refund.payment_id);
    const before = payment.refunded_cents;
    const after = before + refund.amount_cents;
    const full = after === payment.amount_cents;
    db.prepare("UPDATE refunds SET status = 'succeeded', provider_refund_id = ? WHERE id = ?").run(result.providerRefundId, refundId);
    db.prepare('UPDATE payments SET refunded_cents = ?, status = ? WHERE id = ?').run(after, full ? 'refunded' : 'partially_refunded', payment.id);
    db.prepare('UPDATE orders SET payment_status = ? WHERE id = ?').run(full ? 'refunded' : 'partially_refunded', payment.order_id);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(payment.order_id);
    ledger.recordRefund(db, order, payment, refund, before);
    return db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
  });
}

// Automatic full refund after a paid online order is cancelled or rejected.
async function refundCancelledOrder(db, provider, orderId, reason) {
  const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);
  if (!payment) return null;
  try {
    return await refundPayment(db, provider, { paymentId: payment.id, reason, idempotencyKey: `auto:cancel:${orderId}`, actor: null });
  } catch (e) {
    // The order is already cancelled; the failed refund stays visible to admins (refund row 'failed') for retry.
    logger.error('refund.auto_failed', { orderId, error: e });
    return null;
  }
}

// ---------------------------------------------------------------- unpaid order sweeper
async function expireUnpaidOrders(db, provider) {
  const stale = db.prepare("SELECT o.id order_id, p.id payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.status = 'awaiting_payment' AND o.expires_at < ?")
    .all(new Date().toISOString());
  let cancelled = 0;
  for (const s of stale) {
    try {
      const r = provider.enabled ? await reconcilePayment(db, provider, s.payment_id) : { status: 'failed' };
      if (r.status === 'succeeded') continue;
      if (r.status === 'pending' || r.status === 'mismatch' || r.status === 'failed') {
        failPayment(db, s.payment_id, 'Payment was not completed in time', 'payment_expired');
        cancelled++;
      }
    } catch (e) {
      logger.warn('sweeper.reconcile_failed', { orderId: s.order_id, error: e }); // provider down: try again next run
    }
  }
  return { checked: stale.length, cancelled };
}

// Wrapper used by routes after changeStatus(): runs the refund when required.
async function afterStatusChange(db, provider, result, reason) {
  if (result.refundNeeded) await refundCancelledOrder(db, provider, result.rawOrder.id, reason || `Order ${result.order.status}`);
  return result;
}

module.exports = {
  startCardPayment, markPaid, failPayment, reconcilePayment, handleWebhook, refundPayment, applyRefundResult,
  refundCancelledOrder, expireUnpaidOrders, afterStatusChange, reservedRefundCents,
};
