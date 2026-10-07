// Weekly restaurant payouts.
//
// A payout is the weekly statement of what a restaurant earned online (net of commission, platform fee and
// refunds) from orders delivered up to the end of the period.
//  * provider_settled (default): the payment provider already routes each restaurant's share to its connected
//    account; a payout row tracks reconciliation of that settlement (pending -> processing -> paid + reference).
//  * manual_transfer: the platform holds the money and pays the restaurant itself; commission owed on cash
//    orders is netted off the transfer.
// Duplicates are impossible by construction: UNIQUE(restaurant_id, period_start) plus entries can only be
// attached to one payout (payout_id IS NULL guard) inside a single transaction.
const config = require('../config');
const logger = require('../logger');
const { tx } = require('../db');
const { HttpError, notFound } = require('../utils');
const { audit, getSetting } = require('./platform');
const { accountStatus } = require('./paymentAccounts');
const { ProviderError } = require('../payments/provider');

const dayStr = (d) => d.toISOString().slice(0, 10);

// Monday (UTC) of the week containing `date`.
function weekStart(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d;
}
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

// The most recent COMPLETE Monday-Sunday week before `now`.
function lastFullWeek(now = new Date()) {
  const start = addDays(weekStart(now), -7);
  return { periodStart: dayStr(start), periodEnd: dayStr(addDays(start, 6)), endExclusive: addDays(start, 7).toISOString() };
}

const netCod = () => config.payoutMode === 'manual_transfer';

function generateForRestaurant(db, restaurantId, period) {
  return tx(db, () => {
    if (db.prepare('SELECT 1 FROM payouts WHERE restaurant_id = ? AND period_start = ?').get(restaurantId, period.periodStart)) {
      return { skipped: 'already_generated' };
    }
    const entries = db.prepare(
      `SELECT id, restaurant_amount_cents, entry_type, currency FROM ledger_entries
       WHERE restaurant_id = ? AND payout_id IS NULL AND eligible_at IS NOT NULL AND eligible_at < ?
         AND (entry_type != 'cod_commission' OR ?)`).all(restaurantId, period.endExclusive, netCod() ? 1 : 0);
    if (!entries.length) return { skipped: 'nothing_to_pay' };
    const amount = entries.reduce((s, e) => s + e.restaurant_amount_cents, 0);
    if (amount <= 0) return { skipped: 'non_positive_balance', amountCents: amount }; // carried into the next statement
    const minPayout = getSetting(db, 'min_payout_cents');
    if (amount < minPayout) return { skipped: 'below_minimum_payout', amountCents: amount, minPayoutCents: minPayout }; // carried forward
    // 'eligible' = the restaurant's payout account is VERIFIED by the provider; otherwise the statement waits as 'pending'.
    const acct = db.prepare('SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(restaurantId);
    const status = accountStatus(acct) === 'VERIFIED' ? 'eligible' : 'pending';
    const info = db.prepare(
      `INSERT INTO payouts (restaurant_id, amount_cents, currency, settlement_currency, provider, period_start, period_end, status)
       VALUES (?,?,?,?,?,?,?,?)`)
      .run(restaurantId, amount, entries[0].currency, acct?.settlement_currency || null, config.paymentProvider === 'none' ? 'manual' : config.paymentProvider, period.periodStart, period.periodEnd, status);
    const payoutId = Number(info.lastInsertRowid);
    recordEvent(db, payoutId, null, status, 'system', { details: { entries: entries.length, amountCents: amount } });
    const upd = db.prepare("UPDATE ledger_entries SET payout_id = ?, payout_status = 'in_payout' WHERE id = ? AND payout_id IS NULL");
    for (const e of entries) {
      if (upd.run(payoutId, e.id).changes !== 1) throw new Error('ledger entry already assigned to a payout');
    }
    return { payoutId, amountCents: amount, entries: entries.length };
  });
}

function generateWeeklyPayouts(db, { now = new Date(), actor = null } = {}) {
  const period = lastFullWeek(now);
  const ids = db.prepare('SELECT DISTINCT restaurant_id id FROM ledger_entries WHERE payout_id IS NULL AND eligible_at IS NOT NULL AND eligible_at < ?').all(period.endExclusive);
  const created = [];
  for (const { id } of ids) {
    const r = generateForRestaurant(db, id, period);
    if (r.payoutId) created.push({ restaurantId: id, ...r });
  }
  if (created.length || actor) {
    audit(db, actor ? { user: actor } : null, 'payouts.generated', 'payout_period', period.periodStart, { created: created.length, period: [period.periodStart, period.periodEnd] });
    logger.info('payout.weekly_generated', { period: period.periodStart, created: created.length });
  }
  return { period, created };
}

// ---------------------------------------------------------------- payout state machine
// pending       statement created; the restaurant's payout account is not VERIFIED yet
// eligible      account VERIFIED: the statement can be paid
// requested     a payout was created at the provider (createPayout) and the provider acknowledged it
// processing    the provider reports it is moving the money
// paid          the PROVIDER confirmed it  (confirmation_source='provider'), or an admin recorded a bank transfer made
//               OUTSIDE the platform with its reference (confirmation_source='admin_manual', only via manual_payout)
// failed / reversed / cancelled
// manual_payout the platform will pay (or has paid) this statement by hand: an explicit state, never disguised as provider money
const ADMIN_TRANSITIONS = {
  pending: ['manual_payout', 'cancelled'],
  eligible: ['manual_payout', 'cancelled'],
  manual_payout: ['paid', 'failed', 'pending', 'cancelled'],
  failed: ['pending', 'cancelled'], // retry puts it back in the queue
};
const PROVIDER_TRANSITIONS = {
  pending: ['requested', 'processing', 'paid', 'failed', 'cancelled'],
  eligible: ['requested', 'processing', 'paid', 'failed', 'cancelled'],
  requested: ['processing', 'paid', 'failed', 'cancelled'],
  processing: ['paid', 'failed', 'cancelled'],
  paid: ['reversed'],
  failed: ['requested', 'processing', 'paid'],
};
const TRANSITIONS = ADMIN_TRANSITIONS;

function recordEvent(db, payoutId, from, to, source, { providerEventId = null, actorId = null, details = null } = {}) {
  db.prepare('INSERT INTO payout_events (payout_id, from_status, to_status, source, provider_event_id, actor_id, details) VALUES (?,?,?,?,?,?,?)')
    .run(payoutId, from, to, source, providerEventId, actorId, details ? JSON.stringify(details) : null);
}

// Ledger side effects shared by every path.
function settleLedger(db, payoutId, status) {
  if (status === 'paid') {
    db.prepare("UPDATE ledger_entries SET payout_status = 'paid', payout_date = strftime('%Y-%m-%dT%H:%M:%fZ','now'), settled_at = CASE WHEN entry_type = 'cod_commission' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE settled_at END WHERE payout_id = ?").run(payoutId);
  }
  if (status === 'cancelled' || status === 'reversed') {
    // release the entries so a later weekly run picks them up again
    db.prepare("UPDATE ledger_entries SET payout_id = NULL, payout_status = 'unpaid', payout_date = NULL WHERE payout_id = ?").run(payoutId);
  }
}

// Admin action. An admin can NEVER mark a payout paid unless it went through manual_payout, and then it is recorded as
// a manual confirmation with the bank reference. Provider-confirmed payment arrives only through applyProviderEvent.
function updatePayoutStatus(db, payoutId, status, { reference = null, failureReason = null, actor }) {
  const result = tx(db, () => {
    const p = db.prepare('SELECT * FROM payouts WHERE id = ?').get(payoutId);
    if (!p) throw notFound('Payout');
    if (!(ADMIN_TRANSITIONS[p.status] || []).includes(status)) {
      const hint = status === 'paid' ? ' (an admin can only record a payout as paid after moving it to manual_payout; provider payouts are confirmed by the provider)' : '';
      throw new HttpError(409, 'invalid_transition', `A ${p.status} payout cannot become ${status}${hint}`);
    }
    if (status === 'paid' && !reference) throw new HttpError(400, 'validation_error', 'reference: the bank transfer reference is required to record a manual payout as paid', { field: 'reference' });
    if (status === 'failed' && !failureReason) throw new HttpError(400, 'validation_error', 'failureReason: required', { field: 'failureReason' });
    let next = status;
    if (status === 'pending') { // retry / undo: eligible again if the account is verified
      const acct = db.prepare('SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(p.restaurant_id);
      next = accountStatus(acct) === 'VERIFIED' ? 'eligible' : 'pending';
    }
    db.prepare(
      `UPDATE payouts SET status = ?, provider_payout_id = COALESCE(?, provider_payout_id), failure_reason = ?,
         confirmation_source = CASE WHEN ? = 'paid' THEN 'admin_manual' ELSE confirmation_source END,
         paid_at = CASE WHEN ? = 'paid' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE paid_at END WHERE id = ?`)
      .run(next, status === 'paid' ? `manual:${reference}` : null, status === 'failed' ? failureReason : null, status, status, payoutId);
    settleLedger(db, payoutId, status);
    recordEvent(db, payoutId, p.status, next, 'admin', { actorId: actor?.id ?? null, details: { reference, failureReason } });
    return db.prepare('SELECT * FROM payouts WHERE id = ?').get(payoutId);
  });
  audit(db, { user: actor }, `payout.${status}`, 'payout', payoutId, { reference, failureReason, confirmedBy: status === 'paid' ? 'admin_manual' : undefined });
  logger.info('payout.status', { payoutId, status });
  return result;
}

// A status reported by the provider (verified webhook or authenticated API poll). Applied exactly once per event id.
function applyProviderEvent(db, { eventId, providerPayoutId, status, amountCents = null, currency = null, failureReason = null }) {
  if (!['requested', 'processing', 'paid', 'failed', 'reversed', 'cancelled'].includes(status)) throw new HttpError(400, 'validation_error', `unsupported payout status ${status}`);
  return tx(db, () => {
    if (eventId && db.prepare('SELECT 1 FROM payout_events WHERE provider_event_id = ?').get(eventId)) return { duplicate: true };
    const p = db.prepare("SELECT * FROM payouts WHERE provider_payout_id = ? AND provider != 'manual'").get(providerPayoutId);
    if (!p) return { unknown: true };
    if (status === 'paid' && ((amountCents !== null && amountCents !== p.amount_cents) || (currency && currency !== (p.settlement_currency || p.currency)))) {
      logger.error('payout.mismatch', { payoutId: p.id, expected: { amount: p.amount_cents, currency: p.settlement_currency || p.currency }, got: { amountCents, currency } });
      recordEvent(db, p.id, p.status, p.status, 'provider', { providerEventId: eventId, details: { rejected: 'amount_or_currency_mismatch' } });
      return { mismatch: true };
    }
    if (p.status === status) { recordEvent(db, p.id, p.status, p.status, 'provider', { providerEventId: eventId }); return { unchanged: true }; }
    if (!(PROVIDER_TRANSITIONS[p.status] || []).includes(status)) {
      recordEvent(db, p.id, p.status, p.status, 'provider', { providerEventId: eventId, details: { ignored: `${p.status}->${status}` } });
      return { ignored: true };
    }
    db.prepare(
      `UPDATE payouts SET status = ?, failure_reason = ?, confirmation_source = CASE WHEN ? = 'paid' THEN 'provider' ELSE confirmation_source END,
         paid_at = CASE WHEN ? = 'paid' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE paid_at END WHERE id = ?`)
      .run(status, status === 'failed' ? failureReason || 'failed at provider' : null, status, status, p.id);
    settleLedger(db, p.id, status);
    recordEvent(db, p.id, p.status, status, 'provider', { providerEventId: eventId, details: { failureReason } });
    audit(db, null, `payout.${status}`, 'payout', p.id, { source: 'provider', providerPayoutId });
    return { applied: true, payoutId: p.id, status };
  });
}

// Ask the provider to pay an eligible statement. Only works when the adapter really implements createPayout (Tap: NOT VERIFIED).
async function requestPayout(db, provider, payoutId, actor) {
  const p = db.prepare('SELECT * FROM payouts WHERE id = ?').get(payoutId);
  if (!p) throw notFound('Payout');
  if (p.status !== 'eligible') throw new HttpError(409, 'invalid_transition', `Only an eligible payout (verified payout account) can be requested; this one is ${p.status}`);
  const acct = db.prepare('SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(p.restaurant_id);
  let r;
  try {
    r = await provider.createPayout({ payoutId: p.id, destinationId: acct.connected_account_id, amountCents: p.amount_cents, currency: p.settlement_currency || p.currency, idempotencyKey: `payout:${p.id}` });
  } catch (e) {
    if (e instanceof ProviderError && ['capability_not_verified', 'not_supported', 'provider_disabled'].includes(e.code)) {
      throw new HttpError(501, 'provider_capability_unavailable', `${e.message}. Use manual_payout, or rely on the provider's own automatic settlement.`);
    }
    throw e;
  }
  tx(db, () => {
    const cur = db.prepare('SELECT status FROM payouts WHERE id = ?').get(p.id);
    if (cur.status !== 'eligible') throw new HttpError(409, 'invalid_transition', 'Payout changed while the request was in flight');
    db.prepare("UPDATE payouts SET status = 'requested', provider_payout_id = ?, requested_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(r.providerPayoutId, p.id);
    recordEvent(db, p.id, 'eligible', 'requested', 'admin', { actorId: actor?.id ?? null, details: { providerPayoutId: r.providerPayoutId } });
  });
  audit(db, { user: actor }, 'payout.requested', 'payout', p.id, { providerPayoutId: r.providerPayoutId });
  return db.prepare('SELECT * FROM payouts WHERE id = ?').get(p.id);
}

// When a restaurant's payout account becomes VERIFIED, statements that were waiting become eligible.
function promoteEligible(db, restaurantId) {
  const acct = db.prepare('SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(restaurantId);
  if (accountStatus(acct) !== 'VERIFIED') return 0;
  const rows = db.prepare("SELECT id FROM payouts WHERE restaurant_id = ? AND status = 'pending'").all(restaurantId);
  for (const r of rows) {
    db.prepare("UPDATE payouts SET status = 'eligible' WHERE id = ? AND status = 'pending'").run(r.id);
    recordEvent(db, r.id, 'pending', 'eligible', 'system', { details: { reason: 'payout account verified' } });
  }
  return rows.length;
}

// Cash orders: the platform records that it collected the commission a restaurant owed (provider_settled mode).
function settleCodCommission(db, restaurantId, { actor, note }) {
  const n = db.prepare("UPDATE ledger_entries SET settled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE restaurant_id = ? AND entry_type = 'cod_commission' AND settled_at IS NULL AND payout_id IS NULL").run(restaurantId).changes;
  audit(db, { user: actor }, 'cod_commission.settled', 'restaurant', restaurantId, { entries: n, note });
  return n;
}

function startScheduler(db) {
  if (!config.weeklyPayoutScheduler) return null;
  // Hourly check; the unique constraint makes repeated/overlapping runs harmless.
  const t = setInterval(() => {
    try { if (db.tryLeader()) generateWeeklyPayouts(db); } catch (e) { logger.error('payout.scheduler_failed', { error: e }); }
  }, 3600 * 1000);
  t.unref();
  return t;
}

module.exports = { lastFullWeek, weekStart, generateForRestaurant, generateWeeklyPayouts, updatePayoutStatus, applyProviderEvent, requestPayout, promoteEligible, settleCodCommission, startScheduler, TRANSITIONS, ADMIN_TRANSITIONS, PROVIDER_TRANSITIONS };
