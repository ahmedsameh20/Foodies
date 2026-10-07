// Finance views and checks built on the existing ledgers. Nothing here moves money; it reads, summarises and compares.
//   restaurantFinance  the restaurant's own finance dashboard (tenant-scoped by the caller)
//   platformFinance    platform-wide figures for the admin finance report
//   reconcile          compares the platform database with the payment provider
const logger = require('../logger');
const config = require('../config');
const { toDecimalString, mulDiv } = require('./money');
const { audit } = require('./platform');
const { accountStatus, DISPLAY } = require('./paymentAccounts');
const { settlementState } = require('./settlements');

const iso = (d) => d.toISOString();

// Next Monday 00:00 UTC: when the next weekly statement is created.
function nextPayoutDate(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const add = ((8 - d.getUTCDay()) % 7) || 7; // Monday=1; if today is Monday the next one is in 7 days
  d.setUTCDate(d.getUTCDate() + add);
  return d.toISOString().slice(0, 10);
}

// All figures are integer cents in the restaurant's currency, computed from the append-only ledger.
// "Paid out" counts only statements that are PAID (confirmed by the provider, or recorded manually by the platform; the
// split is reported so the restaurant can see which).
function restaurantFinance(db, restaurant) {
  const rid = restaurant.id;
  const q = (sql, ...a) => db.prepare(sql).get(rid, ...a).v;
  const online = "entry_type != 'cod_commission'";
  const acct = db.prepare('SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(rid);
  const st = accountStatus(acct);
  const paidProvider = db.prepare("SELECT COALESCE(SUM(amount_cents),0) v FROM payouts WHERE restaurant_id = ? AND status = 'paid' AND confirmation_source = 'provider'").get(rid).v;
  const paidManual = db.prepare("SELECT COALESCE(SUM(amount_cents),0) v FROM payouts WHERE restaurant_id = ? AND status = 'paid' AND confirmation_source = 'admin_manual'").get(rid).v;
  const pending = q(`SELECT COALESCE(SUM(restaurant_amount_cents),0) v FROM ledger_entries WHERE restaurant_id = ? AND ${online} AND eligible_at IS NULL`);
  const unassigned = q(`SELECT COALESCE(SUM(restaurant_amount_cents),0) v FROM ledger_entries WHERE restaurant_id = ? AND ${online} AND eligible_at IS NOT NULL AND payout_id IS NULL`);
  const inPayout = q(`SELECT COALESCE(SUM(restaurant_amount_cents),0) v FROM ledger_entries WHERE restaurant_id = ? AND ${online} AND payout_status = 'in_payout'`);
  const paid = q(`SELECT COALESCE(SUM(restaurant_amount_cents),0) v FROM ledger_entries WHERE restaurant_id = ? AND ${online} AND payout_status = 'paid'`);
  const grossSales = q("SELECT COALESCE(SUM(gross_amount_cents),0) v FROM ledger_entries WHERE restaurant_id = ? AND entry_type = 'sale'");
  const refunds = -q("SELECT COALESCE(SUM(gross_amount_cents),0) v FROM ledger_entries WHERE restaurant_id = ? AND entry_type = 'refund'");
  const fees = q(`SELECT COALESCE(SUM(platform_commission_cents + platform_fee_cents),0) v FROM ledger_entries WHERE restaurant_id = ? AND ${online}`);
  const net = q(`SELECT COALESCE(SUM(restaurant_amount_cents),0) v FROM ledger_entries WHERE restaurant_id = ? AND ${online}`);
  const nextPayout = db.prepare("SELECT COUNT(*) c FROM payouts WHERE restaurant_id = ? AND status IN ('pending','eligible','requested','processing','manual_payout')").get(rid).c;
  return {
    currency: restaurant.currency,
    currentBalanceCents: pending + unassigned + inPayout,          // earned, not yet paid out
    pendingBalanceCents: pending,                                    // waiting for delivery
    availableForPayoutCents: unassigned,                             // delivered, not yet on a statement
    inPayoutCents: inPayout,                                         // on a statement that is not paid yet
    totalSalesCents: grossSales,
    platformFeesCents: fees,
    refundsCents: refunds,
    netEarningsCents: net,
    paidOutCents: paid,
    paidOutByProviderCents: paidProvider,
    paidOutManuallyRecordedCents: paidManual,
    nextPayoutDate: nextPayoutDate(),
    // TAP_SETTLEMENT: Tap itself pays the restaurant's bank; the platform's weekly statements are EARNINGS records, not payouts.
    settlementModel: config.payoutMode === 'provider_settled' ? 'TAP_SETTLEMENT' : 'PLATFORM_PAYOUT',
    settlementState: settlementState(db, rid, st),
    openStatements: nextPayout,
    payoutBlockedReason: st === 'VERIFIED' ? null : `Your payout account is ${DISPLAY[st].toLowerCase().replace('_', ' ')}: statements wait until the payment provider verifies your account`,
    payoutAccount: { status: st, displayStatus: DISPLAY[st], maskedBank: acct?.masked_bank || null, settlementCurrency: acct?.settlement_currency || null },
  };
}

// Admin finance summary for [from, to). Money as cents; rates as percent strings computed with integer maths.
function platformFinance(db, { from, to }) {
  const one = (sql, ...a) => db.prepare(sql).get(...a, from, to).v;
  const pct = (part, whole) => (whole ? `${toDecimalString(mulDiv(part, 10000, whole))}%` : 'n/a'); // 9750 bp -> "97.50%"
  const cardPaid = one("SELECT COALESCE(SUM(amount_cents),0) v FROM payments WHERE payment_method = 'card' AND status IN ('succeeded','refunded','partially_refunded') AND created_at >= ? AND created_at < ?");
  const cash = one("SELECT COALESCE(SUM(amount_cents),0) v FROM payments WHERE payment_method = 'cod' AND status = 'cash_collected' AND created_at >= ? AND created_at < ?");
  const gmv = one("SELECT COALESCE(SUM(total_cents),0) v FROM orders WHERE status NOT IN ('cancelled','rejected','awaiting_payment') AND created_at >= ? AND created_at < ?");
  const commission = one("SELECT COALESCE(SUM(platform_commission_cents + platform_fee_cents),0) v FROM ledger_entries WHERE created_at >= ? AND created_at < ?");
  const earnings = one("SELECT COALESCE(SUM(restaurant_amount_cents),0) v FROM ledger_entries WHERE entry_type != 'cod_commission' AND created_at >= ? AND created_at < ?");
  const refunds = one("SELECT COALESCE(SUM(amount_cents),0) v FROM refunds WHERE status = 'succeeded' AND created_at >= ? AND created_at < ?");
  const payoutSum = (st) => one(`SELECT COALESCE(SUM(amount_cents),0) v FROM payouts WHERE status IN (${st}) AND created_at >= ? AND created_at < ?`);
  const saasPaid = one("SELECT COALESCE(SUM(amount_cents),0) v FROM saas_invoices WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?");
  const saasRefunded = one("SELECT COALESCE(SUM(amount_cents),0) v FROM saas_invoice_refunds WHERE status = 'succeeded' AND created_at >= ? AND created_at < ?");
  const ok = one("SELECT COUNT(*) v FROM payments WHERE payment_method = 'card' AND status IN ('succeeded','refunded','partially_refunded') AND created_at >= ? AND created_at < ?");
  const bad = one("SELECT COUNT(*) v FROM payments WHERE payment_method = 'card' AND status IN ('failed','cancelled') AND created_at >= ? AND created_at < ?");
  // MRR: active/trialing paid subscriptions normalised to a month (yearly / 12, half-up). Not date-ranged: it is a snapshot.
  const subs = db.prepare("SELECT price_cents, billing_interval FROM subscriptions WHERE status IN ('active','past_due') AND price_cents > 0").all();
  const mrr = subs.reduce((s, x) => s + (x.billing_interval === 'year' ? mulDiv(x.price_cents, 1, 12) : x.price_cents), 0);
  const money = (c) => toDecimalString(c);
  const rows = [
    ['Total online payments (card)', money(cardPaid), 'Customer → restaurant orders'],
    ['Total cash payments (collected)', money(cash), 'Cash on delivery'],
    ['Marketplace GMV (order value)', money(gmv), 'Delivered/active orders, all methods'],
    ['Platform commission + service fees', money(commission), 'Net of refund reversals'],
    ['Restaurant earnings (online, net)', money(earnings), 'After commission, fees and refunds'],
    ['Order refunds', money(refunds), 'Succeeded refunds'],
    ['Payouts paid', money(payoutSum("'paid'")), ''],
    ['Payouts pending', money(payoutSum("'pending','eligible','requested','processing','manual_payout'")), ''],
    ['Payouts failed', money(payoutSum("'failed','reversed'")), ''],
    ['Payment success rate', pct(ok, ok + bad), `${ok} succeeded / ${bad} failed or cancelled card payments`],
    ['Payment failure rate', pct(bad, ok + bad), ''],
    ['SaaS subscription revenue (paid invoices)', money(saasPaid), 'Restaurant → platform; separate ledger'],
    ['SaaS refunds', money(saasRefunded), ''],
    ['MRR (snapshot)', money(mrr), 'Paid subscriptions normalised to one month'],
    ['ARR (snapshot)', money(mrr * 12), 'MRR × 12'],
  ];
  return rows.map(([metric, value, note]) => ({ metric, value, currency: config.currency, note }));
}

// ---------------------------------------------------------------- reconciliation
// Compares what this platform recorded with what the provider reports. Database-only checks always run; provider checks
// need an enabled provider and re-fetch each charge through the authenticated API (bounded, newest first).
async function reconcile(db, provider, { days = 7, limit = 100, actor = null } = {}) {
  const since = iso(new Date(Date.now() - days * 86400000));
  const findings = [];
  const add = (severity, type, ref, detail) => findings.push({ severity, type, ref, detail });

  // --- database-only invariants
  for (const r of db.prepare(`SELECT p.id, p.order_id FROM payments p WHERE p.status = 'succeeded' AND p.payment_method = 'card'
      AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.payment_id = p.id AND l.entry_type = 'sale')`).all()) add('critical', 'paid_without_ledger', `payment:${r.id}`, 'Paid card payment has no ledger sale entry');
  for (const r of db.prepare(`SELECT p.id, p.refunded_cents, COALESCE((SELECT SUM(amount_cents) FROM refunds f WHERE f.payment_id = p.id AND f.status = 'succeeded'),0) s
      FROM payments p WHERE p.refunded_cents != COALESCE((SELECT SUM(amount_cents) FROM refunds f WHERE f.payment_id = p.id AND f.status = 'succeeded'),0)`).all()) {
    add('critical', 'refund_discrepancy', `payment:${r.id}`, `payment says ${r.refunded_cents} refunded, refund rows total ${r.s}`);
  }
  for (const r of db.prepare("SELECT id, provider_payout_id, confirmation_source FROM payouts WHERE status = 'paid' AND (provider_payout_id IS NULL OR confirmation_source IS NULL)").all()) add('critical', 'paid_payout_without_confirmation', `payout:${r.id}`, 'Payout is paid without a reference or confirmation source');
  for (const r of db.prepare("SELECT id, status FROM refunds WHERE status = 'pending' AND created_at < ?").all(iso(new Date(Date.now() - 3600000)))) add('warning', 'refund_stuck_pending', `refund:${r.id}`, 'Refund has been pending for over an hour');
  for (const r of db.prepare("SELECT id FROM payouts WHERE status IN ('failed','reversed')").all()) add('warning', 'payout_failed', `payout:${r.id}`, 'Payout failed or was reversed and needs attention');
  for (const r of db.prepare(`SELECT provider, object_id, COUNT(*) n FROM webhook_events WHERE status = 'processed' AND event_type = 'charge' AND received_at >= ? GROUP BY provider, object_id HAVING COUNT(*) > 3`).all(since)) add('info', 'many_webhooks_for_charge', `charge:${r.object_id}`, `${r.n} processed events (status changes are normal; check if unexpected)`);
  for (const r of db.prepare(`SELECT l.restaurant_id, COALESCE(SUM(l.restaurant_amount_cents),0) s FROM ledger_entries l WHERE l.payout_status = 'paid' AND l.payout_id IS NULL GROUP BY l.restaurant_id`).all()) add('critical', 'paid_entry_without_payout', `restaurant:${r.restaurant_id}`, 'Ledger entries marked paid without a payout');

  // --- provider comparison (card payments created in the window)
  const result = { checked: 0, providerChecked: false, skippedReason: null };
  if (!provider.enabled) {
    result.skippedReason = 'No payment provider is configured: only database invariants were checked';
  } else {
    result.providerChecked = true;
    const rows = db.prepare(`SELECT id, order_id, provider_transaction_id, amount_cents, currency, status FROM payments
      WHERE provider = ? AND provider_transaction_id IS NOT NULL AND created_at >= ? ORDER BY id DESC LIMIT ?`).all(provider.name, since, limit);
    for (const p of rows) {
      result.checked += 1;
      let c;
      try { c = await provider.verifyPayment(p.provider_transaction_id); } catch (e) {
        add('warning', e.status === 404 ? 'missing_at_provider' : 'provider_lookup_failed', `payment:${p.id}`, e.status === 404 ? 'Provider has no such charge' : `Could not re-fetch: ${e.code || e.message}`);
        continue;
      }
      if (c.amountCents !== p.amount_cents) add('critical', 'amount_mismatch', `payment:${p.id}`, `platform ${p.amount_cents} vs provider ${c.amountCents}`);
      if (c.currency !== p.currency) add('critical', 'currency_mismatch', `payment:${p.id}`, `platform ${p.currency} vs provider ${c.currency}`);
      if (c.orderRef && c.orderRef !== `ord_${p.order_id}`) add('critical', 'reference_mismatch', `payment:${p.id}`, `provider reference ${c.orderRef}`);
      const dbPaid = ['succeeded', 'refunded', 'partially_refunded'].includes(p.status);
      if (c.isSuccess && !dbPaid) add('critical', 'paid_at_provider_not_recorded', `payment:${p.id}`, `provider says ${c.status}, platform says ${p.status}`);
      if (!c.isSuccess && dbPaid) add('critical', 'recorded_paid_not_captured', `payment:${p.id}`, `platform says ${p.status}, provider says ${c.status}`);
    }
  }
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const status = critical ? 'DISCREPANCIES' : findings.some((f) => f.severity === 'warning') ? 'ATTENTION' : 'CLEAN';
  audit(db, actor ? { user: actor } : null, 'reconciliation.run', 'reconciliation', null, { status, findings: findings.length, critical, ...result });
  logger.info('reconciliation.run', { status, findings: findings.length, critical });
  return { status, windowDays: days, ranAt: iso(new Date()), ...result, findings };
}

module.exports = { restaurantFinance, platformFinance, reconcile, nextPayoutDate };
