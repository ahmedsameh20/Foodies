// SaaS subscriptions: what a RESTAURANT pays the PLATFORM for using the software.
//
// This is a completely separate money system from customer order payments:
//   saas_invoices            <- this file         (restaurant -> platform)
//   payments/refunds/ledger  <- services/payments (customer -> restaurant, platform commission)
// Nothing here reads or writes the order ledger, and order payments never touch invoices.
const config = require('../config');
const logger = require('../logger');
const { tx } = require('../db');
const { HttpError, notFound } = require('../utils');
const { getSubscription, getUsage, formatPlan } = require('./plans');
const { audit } = require('./platform');
const { ProviderError } = require('../payments/provider');

const iso = (d) => d.toISOString();
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
function addInterval(d, interval) {
  const x = new Date(d.getTime());
  if (interval === 'year') x.setUTCFullYear(x.getUTCFullYear() + 1); else x.setUTCMonth(x.getUTCMonth() + 1);
  return x;
}

const planByCode = (db, code) => db.prepare('SELECT * FROM plans WHERE code = ?').get(code);

// What the limits of `plan` would be, compared with current usage (used to refuse downgrades that don't fit).
function assertFits(db, restaurantId, plan) {
  const usage = getUsage(db, restaurantId);
  const checks = [
    ['menuItems', plan.max_menu_items, 'menu items'], ['staff', plan.max_staff, 'staff accounts'],
    ['branches', plan.max_branches, 'branches'], ['ordersPerMonth', plan.max_orders_per_month, 'orders this month'],
  ];
  for (const [k, max, label] of checks) {
    if (max !== null && max !== undefined && usage[k] > max) {
      throw new HttpError(409, 'over_plan_limit', `You currently use ${usage[k]} ${label}; the ${plan.name} plan allows ${max}. Reduce usage first.`,
        { resource: k, used: usage[k], limit: max, plan: plan.code });
    }
  }
}

function openInvoiceFor(db, restaurantId) {
  return db.prepare("SELECT * FROM saas_invoices WHERE restaurant_id = ? AND status = 'open'").get(restaurantId);
}

function createInvoice(db, { restaurantId, subscriptionId, plan, periodStart }) {
  // one open invoice per restaurant: a newer request supersedes the old one
  db.prepare("UPDATE saas_invoices SET status = 'void' WHERE restaurant_id = ? AND status = 'open'").run(restaurantId);
  const start = periodStart || new Date();
  const info = db.prepare(
    `INSERT INTO saas_invoices (restaurant_id, subscription_id, plan_id, amount_cents, currency, billing_interval, period_start, period_end)
     VALUES (?,?,?,?,?,?,?,?)`)
    .run(restaurantId, subscriptionId, plan.id, plan.price_cents, plan.currency, plan.billing_interval, iso(start), iso(addInterval(start, plan.billing_interval)));
  return db.prepare('SELECT * FROM saas_invoices WHERE id = ?').get(info.lastInsertRowid);
}

// Create the first subscription of a new restaurant.
//   free plan            -> ACTIVE forever
//   paid plan + trial    -> TRIALING until trial_end, then an invoice is issued
//   paid plan, no trial  -> EXPIRED until the first invoice is paid (no entitlement without payment)
function startSubscription(db, restaurantId, plan, now = new Date()) {
  return tx(db, () => {
    let status; let trialEnd = null; let endDate = null;
    if (plan.price_cents === 0) status = 'active';
    else if (plan.trial_days > 0) { status = 'trialing'; trialEnd = iso(addDays(now, plan.trial_days)); endDate = trialEnd; } else status = 'expired';
    const info = db.prepare(
      `INSERT INTO subscriptions (restaurant_id, plan_id, status, price_cents, currency, billing_interval, start_date, end_date, trial_end, provider)
       VALUES (?,?,?,?,?,?,?,?,?, 'platform')`)
      .run(restaurantId, plan.id, status, plan.price_cents, plan.currency, plan.billing_interval, iso(now), endDate, trialEnd);
    const subId = Number(info.lastInsertRowid);
    let invoice = null;
    if (status === 'expired') invoice = createInvoice(db, { restaurantId, subscriptionId: subId, plan, periodStart: now });
    return { subscriptionId: subId, status, invoice };
  });
}

// Owner-initiated plan change.
//   -> free plan: switches immediately.
//   -> paid plan and the restaurant has never had a trial: starts a trial on the new plan.
//   -> otherwise an invoice is issued; the plan switches when the invoice is paid.
function requestPlanChange(db, restaurantId, newPlan, now = new Date()) {
  return tx(db, () => {
    const sub = db.prepare('SELECT * FROM subscriptions WHERE restaurant_id = ?').get(restaurantId);
    if (!sub) throw notFound('Subscription');
    if (sub.status === 'suspended') throw new HttpError(403, 'suspended', 'Your account is suspended by the platform. Contact support.');
    if (!newPlan.is_active) throw new HttpError(409, 'plan_unavailable', 'That plan is not available');
    const current = db.prepare('SELECT * FROM plans WHERE id = ?').get(sub.plan_id);
    if (newPlan.id === current.id && ['active', 'trialing'].includes(sub.status) && !sub.cancelled_at) {
      throw new HttpError(409, 'already_on_plan', 'You are already on this plan');
    }
    assertFits(db, restaurantId, newPlan);

    if (newPlan.price_cents === 0) {
      db.prepare("UPDATE saas_invoices SET status = 'void' WHERE restaurant_id = ? AND status = 'open'").run(restaurantId);
      db.prepare(
        `UPDATE subscriptions SET plan_id = ?, status = 'active', price_cents = 0, currency = ?, billing_interval = ?, end_date = NULL,
           trial_end = NULL, cancelled_at = NULL WHERE id = ?`).run(newPlan.id, newPlan.currency, newPlan.billing_interval, sub.id);
      return { applied: true, invoice: null };
    }
    if (newPlan.trial_days > 0 && !sub.trial_end) {
      const trialEnd = iso(addDays(now, newPlan.trial_days));
      db.prepare("UPDATE saas_invoices SET status = 'void' WHERE restaurant_id = ? AND status = 'open'").run(restaurantId);
      db.prepare(
        `UPDATE subscriptions SET plan_id = ?, status = 'trialing', price_cents = ?, currency = ?, billing_interval = ?, end_date = ?, trial_end = ?, cancelled_at = NULL WHERE id = ?`)
        .run(newPlan.id, newPlan.price_cents, newPlan.currency, newPlan.billing_interval, trialEnd, trialEnd, sub.id);
      return { applied: true, invoice: null, trial: true };
    }
    return { applied: false, invoice: createInvoice(db, { restaurantId, subscriptionId: sub.id, plan: newPlan, periodStart: now }) };
  });
}

function cancelSubscription(db, restaurantId, now = new Date()) {
  return tx(db, () => {
    const sub = db.prepare('SELECT * FROM subscriptions WHERE restaurant_id = ?').get(restaurantId);
    if (!sub) throw notFound('Subscription');
    if (sub.price_cents === 0) throw new HttpError(409, 'nothing_to_cancel', 'The Free plan has no subscription to cancel');
    if (sub.cancelled_at) throw new HttpError(409, 'already_cancelled', 'This subscription is already set to end');
    db.prepare("UPDATE saas_invoices SET status = 'void' WHERE restaurant_id = ? AND status = 'open'").run(restaurantId);
    // access continues until the end of the period already paid for / the trial; no renewal will be invoiced
    db.prepare('UPDATE subscriptions SET cancelled_at = ? WHERE id = ?').run(iso(now), sub.id);
    return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(sub.id);
  });
}

// Admin: assign any plan/status without payment (audit-logged by the caller).
function assignPlan(db, restaurantId, plan, { status = 'active', endDate = null } = {}) {
  return tx(db, () => {
    const sub = db.prepare('SELECT * FROM subscriptions WHERE restaurant_id = ?').get(restaurantId);
    if (!sub) throw notFound('Subscription');
    db.prepare("UPDATE saas_invoices SET status = 'void' WHERE restaurant_id = ? AND status = 'open'").run(restaurantId);
    db.prepare(
      `UPDATE subscriptions SET plan_id = ?, status = ?, price_cents = ?, currency = ?, billing_interval = ?, end_date = ?, cancelled_at = NULL,
         provider = 'platform' WHERE id = ?`)
      .run(plan.id, status, plan.price_cents, plan.currency, plan.billing_interval, endDate, sub.id);
  });
}

// Apply a paid invoice. Idempotent: only an open/failed invoice can become paid, exactly once.
function markInvoicePaid(db, invoiceId, { provider, reference }) {
  return tx(db, () => {
    const inv = db.prepare('SELECT * FROM saas_invoices WHERE id = ?').get(invoiceId);
    if (!inv) throw notFound('Invoice');
    if (inv.status === 'paid') return { changed: false, invoice: inv };
    if (inv.status === 'void') throw new HttpError(409, 'invoice_void', 'This invoice was cancelled');
    db.prepare("UPDATE saas_invoices SET status = 'paid', provider = ?, provider_ref = ?, failure_reason = NULL, paid_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(provider, reference, invoiceId);
    db.prepare(
      `UPDATE subscriptions SET plan_id = ?, status = 'active', price_cents = ?, currency = ?, billing_interval = ?,
         end_date = ?, cancelled_at = NULL, provider = ?, provider_ref = ? WHERE restaurant_id = ?`)
      .run(inv.plan_id, inv.amount_cents, inv.currency, inv.billing_interval, inv.period_end, provider === 'manual' ? 'platform' : provider, reference, inv.restaurant_id);
    logger.info('saas.invoice_paid', { invoiceId, restaurantId: inv.restaurant_id, provider });
    return { changed: true, invoice: db.prepare('SELECT * FROM saas_invoices WHERE id = ?').get(invoiceId) };
  });
}

// ---- paying an invoice through the payment provider (hosted checkout) ----
async function startInvoiceCheckout(db, provider, { invoiceId, restaurantId, customer, saveCard = false }) {
  const inv = db.prepare('SELECT * FROM saas_invoices WHERE id = ? AND restaurant_id = ?').get(invoiceId, restaurantId);
  if (!inv) throw notFound('Invoice');
  if (inv.status !== 'open') throw new HttpError(409, 'invoice_not_open', `This invoice is ${inv.status}`);
  if (!provider.enabled) throw new HttpError(422, 'payments_unavailable', 'Online payment is not available yet. Contact support to activate your plan.');
  const plan = db.prepare('SELECT name FROM plans WHERE id = ?').get(inv.plan_id);
  if (saveCard) {
    if (!config.saasAutoRenewal) throw new HttpError(422, 'auto_renewal_unavailable', 'Automatic renewal is not enabled on this platform');
    if (!customer.phone) throw new HttpError(422, 'phone_required', 'A phone number on your account is required to save a card for automatic renewal');
  }
  try {
    const charge = await provider.createCharge({
      referenceTransaction: `sub_${invoiceId}`, referenceOrder: `inv_${invoiceId}`, amountCents: inv.amount_cents, currency: inv.currency,
      customer: { firstName: customer.name.split(' ')[0].slice(0, 40) || 'Owner', email: customer.email, phone: customer.phone || null }, destination: null, saveCard,
      description: `${plan.name} plan subscription`.slice(0, 120),
      returnUrl: `${config.appUrl}/dashboard.html#subscription`, webhookUrl: `${config.appUrl}/webhooks/${config.paymentProvider}`,
    });
    db.prepare("UPDATE saas_invoices SET provider = ?, provider_ref = ? WHERE id = ? AND status = 'open'").run(provider.name, charge.providerTransactionId, invoiceId);
    return { redirectUrl: charge.redirectUrl };
  } catch (e) {
    logger.error('saas.checkout_failed', { invoiceId, error: e });
    throw new HttpError(502, 'payment_provider_error', e instanceof ProviderError ? 'We could not start the payment. Please try again shortly.' : 'Could not start the payment');
  }
}

// ---- saved card (card-on-file) for automatic renewal. Only provider-issued ids are stored: never a card number or CVV. ----
function rememberCard(db, providerName, restaurantId, charge) {
  if (!charge.card?.id || !charge.customerId || !charge.agreementId) return false;
  tx(db, () => {
    db.prepare("UPDATE subscription_payment_methods SET status = 'removed', removed_at = ? WHERE restaurant_id = ? AND status = 'active' AND provider_card_id != ?")
      .run(iso(new Date()), restaurantId, charge.card.id);
    db.prepare(
      `INSERT INTO subscription_payment_methods (restaurant_id, provider, provider_customer_id, provider_card_id, provider_agreement_id, brand, last4)
       VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider, provider_card_id) DO UPDATE SET status = 'active', removed_at = NULL,
         provider_agreement_id = excluded.provider_agreement_id, provider_customer_id = excluded.provider_customer_id`)
      .run(restaurantId, providerName, charge.customerId, charge.card.id, charge.agreementId, charge.card.brand || null, /^\d{4}$/.test(charge.card.last4 || '') ? charge.card.last4 : null);
  });
  audit(db, null, 'subscription.card_saved', 'restaurant', restaurantId, { brand: charge.card.brand || null });
  return true;
}
const savedMethodOf = (db, restaurantId) => db.prepare("SELECT * FROM subscription_payment_methods WHERE restaurant_id = ? AND status = 'active'").get(restaurantId) || null;
function removeSavedMethod(db, restaurantId) {
  const n = db.prepare("UPDATE subscription_payment_methods SET status = 'removed', removed_at = ? WHERE restaurant_id = ? AND status = 'active'").run(iso(new Date()), restaurantId).changes;
  if (n) audit(db, null, 'subscription.card_removed', 'restaurant', restaurantId, {});
  return n > 0;
}

const MAX_RENEWAL_ATTEMPTS = 3;
// Merchant-initiated renewal charge for ONE open invoice. Idempotent per (invoice, attempt number). Never marks the invoice paid
// from the charge response alone: the charge is re-fetched and checked (amount, currency, inv_<id> reference, CAPTURED).
async function chargeInvoiceWithSavedCard(db, provider, invoiceId, { now = new Date() } = {}) {
  const inv = db.prepare('SELECT * FROM saas_invoices WHERE id = ?').get(invoiceId);
  if (!inv || inv.status !== 'open') return { skipped: 'not_open' };
  const pm = savedMethodOf(db, inv.restaurant_id);
  if (!pm || pm.provider !== provider.name) return { skipped: 'no_saved_card' };
  const attempt = tx(db, () => {
    const last = db.prepare('SELECT * FROM subscription_charge_attempts WHERE invoice_id = ? ORDER BY attempt_no DESC LIMIT 1').get(invoiceId);
    if (last && last.status === 'started') return null; // another attempt is in flight
    if (last && last.attempt_no >= MAX_RENEWAL_ATTEMPTS) return null;
    if (last && new Date(last.created_at).getTime() > now.getTime() - 20 * 3600 * 1000) return null; // at most one attempt a day
    const n = (last?.attempt_no || 0) + 1;
    db.prepare("INSERT INTO subscription_charge_attempts (invoice_id, restaurant_id, attempt_no, status) VALUES (?,?,?,'started')").run(invoiceId, inv.restaurant_id, n);
    return n;
  });
  if (!attempt) return { skipped: 'not_due' };
  const fail = (reason) => {
    db.prepare("UPDATE subscription_charge_attempts SET status = 'failed', failure_reason = ? WHERE invoice_id = ? AND attempt_no = ?").run(String(reason).slice(0, 200), invoiceId, attempt);
    db.prepare("UPDATE saas_invoices SET failure_reason = ? WHERE id = ? AND status = 'open'").run(`Automatic renewal failed: ${String(reason).slice(0, 150)}`, invoiceId);
    audit(db, null, 'subscription.auto_renewal_failed', 'invoice', invoiceId, { attempt, reason: String(reason).slice(0, 150) });
    return { status: 'failed', attempt };
  };
  try {
    const r = await provider.chargeSavedCard({
      customerId: pm.provider_customer_id, cardId: pm.provider_card_id, agreementId: pm.provider_agreement_id,
      referenceTransaction: `sub_${invoiceId}_a${attempt}`, referenceOrder: `inv_${invoiceId}`, amountCents: inv.amount_cents, currency: inv.currency,
      description: 'Subscription renewal', webhookUrl: `${config.appUrl}/webhooks/${config.paymentProvider}`, idempotencyKey: `inv_${invoiceId}_a${attempt}`,
    });
    db.prepare('UPDATE subscription_charge_attempts SET provider_charge_id = ? WHERE invoice_id = ? AND attempt_no = ?').run(r.providerTransactionId, invoiceId, attempt);
    const v = await reconcileInvoiceCharge(db, provider, r.providerTransactionId, invoiceId);
    if (v.status === 'paid') {
      db.prepare("UPDATE subscription_charge_attempts SET status = 'succeeded' WHERE invoice_id = ? AND attempt_no = ?").run(invoiceId, attempt);
      return { status: 'paid', attempt };
    }
    return fail(`provider result: ${v.status}`);
  } catch (e) {
    return fail(e instanceof ProviderError ? e.message : 'unexpected error');
  }
}

// Called every few minutes from the server (only when SAAS_AUTO_RENEWAL=on and a provider is configured).
async function runAutoRenewals(db, provider, now = new Date()) {
  const out = { attempted: 0, paid: 0, failed: 0 };
  if (!config.saasAutoRenewal || !provider.enabled) return out;
  const rows = db.prepare("SELECT i.id FROM saas_invoices i JOIN subscription_payment_methods m ON m.restaurant_id = i.restaurant_id AND m.status = 'active' WHERE i.status = 'open' LIMIT 100").all();
  for (const { id } of rows) {
    const r = await chargeInvoiceWithSavedCard(db, provider, id, { now });
    if (r.status) { out.attempted += 1; if (r.status === 'paid') out.paid += 1; else out.failed += 1; }
  }
  return out;
}

// Verify a provider charge for an invoice by asking the provider, never by trusting the caller.
async function reconcileInvoiceCharge(db, provider, chargeId, invoiceIdHint = null) {
  const charge = await provider.retrieveCharge(chargeId);
  const m = /^inv_(\d+)$/.exec(charge.orderRef || '');
  if (!m) return { status: 'unrelated' };
  const invoiceId = Number(m[1]);
  if (invoiceIdHint && invoiceIdHint !== invoiceId) return { status: 'mismatch' };
  const inv = db.prepare('SELECT * FROM saas_invoices WHERE id = ?').get(invoiceId);
  if (!inv) return { status: 'unrelated' };
  if (charge.amountCents !== inv.amount_cents || charge.currency !== inv.currency) {
    logger.error('saas.invoice_mismatch', { invoiceId, expected: [inv.amount_cents, inv.currency], got: [charge.amountCents, charge.currency] });
    return { status: 'mismatch' };
  }
  if (charge.isSuccess) {
    if (inv.status === 'void') return { status: 'void' }; // paid for a superseded invoice: needs a manual refund/credit by an admin
    markInvoicePaid(db, invoiceId, { provider: provider.name, reference: chargeId });
    rememberCard(db, provider.name, inv.restaurant_id, charge); // only if this charge saved a card (provider ids only)
    return { status: 'paid' };
  }
  if (charge.isFailure && inv.status === 'open') {
    db.prepare("UPDATE saas_invoices SET failure_reason = ? WHERE id = ?").run(String(charge.failureReason || charge.status).slice(0, 200), invoiceId);
    return { status: 'failed' };
  }
  return { status: 'pending' };
}

// Refund a paid SaaS invoice (restaurant -> platform ledger; unrelated to order refunds). Idempotent per key. A full
// refund ends the paid access immediately. Only provider-paid invoices can be refunded through the provider; manual
// settlements are reversed outside the platform.
async function refundInvoice(db, provider, { invoiceId, amountCents = null, reason, idempotencyKey, actor }) {
  const key = `${invoiceId}:${idempotencyKey}`;
  const prior = db.prepare('SELECT * FROM saas_invoice_refunds WHERE idempotency_key = ?').get(key);
  if (prior) return { refund: prior, replayed: true };
  const refund = tx(db, () => {
    const inv = db.prepare('SELECT * FROM saas_invoices WHERE id = ?').get(invoiceId);
    if (!inv) throw notFound('Invoice');
    if (inv.status !== 'paid') throw new HttpError(422, 'not_refundable', 'Only paid invoices can be refunded');
    if (inv.provider === 'manual') throw new HttpError(422, 'not_refundable', 'This invoice was settled manually by an admin; reverse it outside the platform');
    const taken = db.prepare("SELECT COALESCE(SUM(amount_cents),0) s FROM saas_invoice_refunds WHERE invoice_id = ? AND status IN ('pending','succeeded')").get(invoiceId).s;
    const available = inv.amount_cents - taken;
    const amount = amountCents ?? available;
    if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, 'validation_error', 'amount: must be a positive whole number of cents', { field: 'amount' });
    if (amount > available) throw new HttpError(422, 'refund_exceeds_payment', `At most ${available} cents can still be refunded`, { availableCents: available });
    const info = db.prepare(
      `INSERT INTO saas_invoice_refunds (invoice_id, restaurant_id, amount_cents, currency, status, provider, idempotency_key, reason, created_by)
       VALUES (?,?,?,?,'pending',?,?,?,?)`).run(invoiceId, inv.restaurant_id, amount, inv.currency, inv.provider, key, String(reason).slice(0, 300), actor?.id ?? null);
    return db.prepare('SELECT * FROM saas_invoice_refunds WHERE id = ?').get(info.lastInsertRowid);
  });
  const inv = db.prepare('SELECT * FROM saas_invoices WHERE id = ?').get(invoiceId);
  let r;
  try {
    r = await provider.refundPayment({
      providerTransactionId: inv.provider_ref, amountCents: refund.amount_cents, currency: inv.currency, reason: refund.reason,
      idempotencyKey: `saas:${key}`.slice(0, 100), destination: null, webhookUrl: `${config.appUrl}/webhooks/${config.paymentProvider}`,
    });
  } catch (e) {
    db.prepare("UPDATE saas_invoice_refunds SET status = 'failed', failure_reason = ? WHERE id = ?").run(String(e.message).slice(0, 200), refund.id);
    throw new HttpError(502, 'payment_provider_error', e instanceof ProviderError ? 'The payment provider could not process the refund' : 'Could not refund');
  }
  tx(db, () => {
    db.prepare('UPDATE saas_invoice_refunds SET status = ?, provider_refund_id = ?, failure_reason = ? WHERE id = ?')
      .run(r.status === 'succeeded' ? 'succeeded' : r.status === 'failed' ? 'failed' : 'pending', r.providerRefundId, r.failureReason || null, refund.id);
    if (r.status === 'succeeded') {
      const total = db.prepare("SELECT COALESCE(SUM(amount_cents),0) s FROM saas_invoice_refunds WHERE invoice_id = ? AND status = 'succeeded'").get(invoiceId).s;
      if (total >= inv.amount_cents) {
        db.prepare("UPDATE subscriptions SET status = 'cancelled', end_date = ?, cancelled_at = COALESCE(cancelled_at, ?) WHERE restaurant_id = ? AND provider_ref = ?")
          .run(iso(new Date()), iso(new Date()), inv.restaurant_id, inv.provider_ref);
      }
    }
  });
  audit(db, { user: actor }, 'saas_invoice.refunded', 'invoice', invoiceId, { amountCents: refund.amount_cents, status: r.status });
  return { refund: db.prepare('SELECT * FROM saas_invoice_refunds WHERE id = ?').get(refund.id), replayed: false };
}

// After an admin lifts a suspension: restore the status the subscription's dates justify.
function restoreAfterSuspension(db, restaurantId, now = new Date()) {
  const s = db.prepare('SELECT * FROM subscriptions WHERE restaurant_id = ?').get(restaurantId);
  if (!s || s.status !== 'suspended') return;
  let status = 'active';
  if (s.end_date && new Date(s.end_date).getTime() < now.getTime()) status = 'expired';
  else if (s.trial_end && new Date(s.trial_end).getTime() >= now.getTime()) status = 'trialing';
  db.prepare('UPDATE subscriptions SET status = ? WHERE id = ?').run(status, s.id);
}

// ---- lifecycle sweeper (runs every minute from index.js; takes `now` for tests) ----
function runLifecycle(db, now = new Date()) {
  const nowIso = iso(now);
  const out = { renewalsIssued: 0, trialsEnded: 0, expired: 0, cancelled: 0 };
  const rows = db.prepare("SELECT s.*, p.price_cents AS plan_price FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status IN ('trialing','active','past_due') AND s.end_date IS NOT NULL AND s.end_date < ?").all(nowIso);
  for (const s of rows) {
    tx(db, () => {
      const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(s.plan_id);
      if (s.status === 'past_due') {
        if (new Date(s.end_date).getTime() + config.saasGraceDays * 86400000 < now.getTime()) {
          db.prepare("UPDATE subscriptions SET status = 'expired' WHERE id = ?").run(s.id);
          audit(db, null, 'subscription.expired', 'restaurant', s.restaurant_id, { plan: plan.code });
          out.expired++;
        }
        return;
      }
      if (s.cancelled_at) { // the paid period (or trial) the owner chose to end has run out
        db.prepare("UPDATE subscriptions SET status = 'cancelled' WHERE id = ?").run(s.id);
        out.cancelled++;
        return;
      }
      // trial finished or paid period ended: issue the next invoice and give the grace period
      createInvoice(db, { restaurantId: s.restaurant_id, subscriptionId: s.id, plan, periodStart: new Date(s.end_date) });
      db.prepare("UPDATE subscriptions SET status = 'past_due' WHERE id = ?").run(s.id);
      if (s.status === 'trialing') out.trialsEnded++; else out.renewalsIssued++;
    });
  }
  return out;
}

function subscriptionView(db, restaurantId) {
  const sub = getSubscription(db, restaurantId);
  const r = sub.row;
  const open = openInvoiceFor(db, restaurantId);
  return {
    status: sub.status, active: sub.active, plan: sub.plan, usage: getUsage(db, restaurantId),
    priceCents: r.sub_price_cents, currency: r.sub_currency, billingInterval: r.sub_interval,
    startDate: r.start_date, endDate: r.end_date, trialEnd: r.trial_end, cancelledAt: r.cancelled_at,
    nextBillingDate: r.cancelled_at || !r.sub_price_cents ? null : r.end_date,
    openInvoice: open ? invoiceView(open) : null,
    currentPeriodEnd: r.end_date,
    autoRenewal: { available: config.saasAutoRenewal, savedCard: (() => { const m = savedMethodOf(db, restaurantId); return m ? { brand: m.brand, last4: m.last4 } : null; })() },
  };
}

const invoiceView = (i) => ({
  id: i.id, planId: i.plan_id, amountCents: i.amount_cents, currency: i.currency, billingInterval: i.billing_interval,
  periodStart: i.period_start, periodEnd: i.period_end, status: i.status, provider: i.provider, reference: i.provider_ref,
  failureReason: i.failure_reason, createdAt: i.created_at, paidAt: i.paid_at,
});

module.exports = {
  startSubscription, requestPlanChange, cancelSubscription, assignPlan, markInvoicePaid, startInvoiceCheckout, reconcileInvoiceCharge, refundInvoice,
  chargeInvoiceWithSavedCard, runAutoRenewals, savedMethodOf, removeSavedMethod, MAX_RENEWAL_ATTEMPTS,
  runLifecycle, restoreAfterSuspension, subscriptionView, invoiceView, createInvoice, openInvoiceFor, planByCode, formatPlan,
};
