const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const payouts = require('../server/services/payouts');
const { reservedRefundCents } = require('../server/services/payments');

let t;
before(async () => { t = await startApp({ tap: true }); });
after(async () => { await t.close(); });

async function setup({ price = 10000, commissionBp = 1000 } = {}) {
  const o = await t.createRestaurantOwner('Money Maker', 'pro', { payoutAccount: true });
  t.db.prepare('UPDATE restaurants SET commission_bp_override = ? WHERE id = ?').run(commissionBp, o.restaurant.id);
  const p = await t.addProduct(o, { priceCents: price });
  const c = await t.registerCustomer();
  const admin = await t.createAdminUser();
  return { o, p, c, admin };
}
const payRow = (orderId) => t.db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);
const orderRow = (id) => t.db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const ledgerSum = (orderId) => t.db.prepare('SELECT COALESCE(SUM(restaurant_amount_cents),0) s, COALESCE(SUM(platform_commission_cents),0) c, COALESCE(SUM(gross_amount_cents),0) g FROM ledger_entries WHERE order_id = ?').get(orderId);

// card order, paid via a verified webhook
async function paidOrder(s, { qty = 1, extra = {} } = {}) {
  const r = await t.placeOrder(s.o, s.c, [{ productId: s.p.id, quantity: qty }], { paymentMethod: 'card', ...extra });
  assert.equal(r.status, 201, r.text);
  const id = r.body.data.order.id;
  const chargeId = payRow(id).provider_transaction_id;
  t.fake.capture(chargeId);
  const w = t.fake.webhookFor(chargeId);
  assert.equal((await t.call('POST', '/webhooks/tap', { body: w.body, headers: w.headers })).status, 200);
  return { id, payment: payRow(id), chargeId };
}
async function codOrder(s, qty = 1) {
  const r = await t.placeOrder(s.o, s.c, [{ productId: s.p.id, quantity: qty }], { paymentMethod: 'cod' });
  assert.equal(r.status, 201);
  return r.body.data.order;
}
const advance = async (s, id, steps = ['confirmed', 'preparing', 'ready', 'delivered']) => {
  for (const st of steps) {
    const r = await t.call('PATCH', `/api/manage/orders/${id}/status`, { token: s.o.token, body: { status: st } });
    assert.equal(r.status, 200, `${st}: ${r.text}`);
  }
};
const refund = (s, paymentId, body, key = t.unique('refund-key-')) => t.call('POST', `/api/admin/payments/${paymentId}/refund`, { token: s.admin.token, body, headers: { 'Idempotency-Key': key } });

test('full refund: provider called once, payment/order marked refunded, ledger nets to zero, replay is a no-op', async () => {
  const s = await setup();
  const { id, payment } = await paidOrder(s);
  const key = 'refund-key-full-0001';
  const calls = () => t.fake.calls.filter((c) => c.url === '/refunds').length;
  const before = calls();
  const r = await refund(s, payment.id, { reason: 'Customer complaint' }, key);
  assert.equal(r.status, 201);
  assert.equal(r.body.data.refund.status, 'succeeded');
  assert.equal(r.body.data.refund.amountCents, 10000);
  assert.equal(payRow(id).status, 'refunded');
  assert.equal(payRow(id).refunded_cents, 10000);
  assert.equal(orderRow(id).payment_status, 'refunded');
  assert.deepEqual({ ...ledgerSum(id) }, { s: 0, c: 0, g: 0 }); // restaurant earnings AND platform commission both reversed

  const sent = t.fake.calls.filter((c) => c.url === '/refunds').pop();
  assert.equal(sent.body.amount, 100);
  assert.equal(sent.body.charge_id, payment.provider_transaction_id);
  assert.ok(sent.body.reference.idempotent.endsWith(key));
  assert.equal(sent.body.destinations.destination[0].amount, 90); // restaurant's share taken back from its destination

  const replay = await refund(s, payment.id, { reason: 'Customer complaint' }, key);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
  assert.equal(replay.body.data.refund.id, r.body.data.refund.id);
  assert.equal(calls() - before, 1);
  // a second refund with a NEW key cannot refund again
  const dup = await refund(s, payment.id, { reason: 'again' });
  assert.equal(dup.status, 422);
  assert.equal(dup.body.error.code, 'not_refundable'); // already fully refunded
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM refunds WHERE payment_id = ?').get(payment.id).c, 1);
  assert.equal(payRow(id).refunded_cents, 10000);
});

test('partial refunds accumulate exactly and can never exceed the payment', async () => {
  const s = await setup({ price: 3333 });
  const { id, payment } = await paidOrder(s, { qty: 3 }); // 9999
  assert.equal(payment.amount_cents, 9999);
  const total = ledgerSum(id);
  assert.equal(total.c, 1000); // 10% of 9999 = 999.9 -> 1000
  for (const amt of [3333, 3333]) {
    const r = await refund(s, payment.id, { amountCents: amt, reason: 'partial' });
    assert.equal(r.status, 201);
  }
  assert.equal(payRow(id).status, 'partially_refunded');
  assert.equal(orderRow(id).payment_status, 'partially_refunded');
  assert.equal((await refund(s, payment.id, { amountCents: 3334, reason: 'too much' })).status, 422);
  const last = await refund(s, payment.id, { amountCents: 3333, reason: 'rest' });
  assert.equal(last.status, 201);
  assert.equal(payRow(id).status, 'refunded');
  assert.deepEqual({ ...ledgerSum(id) }, { s: 0, c: 0, g: 0 }); // proportional reversals add up exactly, no cent lost
  assert.equal(reservedRefundCents(t.db, payment.id), 9999);
  for (const bad of [{ amountCents: 0 }, { amountCents: -5 }, { amountCents: 1.5 }, { amountCents: 'x' }]) {
    assert.equal((await refund(s, payment.id, { ...bad, reason: 'x' })).status, 400, JSON.stringify(bad));
  }
});

test('refund guards: admin only, Idempotency-Key required, cash orders and unpaid payments are not refundable', async () => {
  const s = await setup();
  const { payment } = await paidOrder(s);
  assert.equal((await t.call('POST', `/api/admin/payments/${payment.id}/refund`, { token: s.o.token, body: { reason: 'x' }, headers: { 'Idempotency-Key': 'abcdefgh1234' } })).status, 403);
  assert.equal((await t.call('POST', `/api/admin/payments/${payment.id}/refund`, { token: s.c.token, body: { reason: 'x' }, headers: { 'Idempotency-Key': 'abcdefgh1234' } })).status, 403);
  assert.equal((await t.call('POST', `/api/admin/payments/${payment.id}/refund`, { token: s.admin.token, body: { reason: 'x' } })).status, 400); // no key
  assert.equal((await refund(s, payment.id, {})).status, 400); // no reason
  const cod = await codOrder(s);
  assert.equal((await refund(s, payRow(cod.id).id, { reason: 'x' })).body.error.code, 'not_refundable');
  const unpaid = await t.placeOrder(s.o, s.c, [{ productId: s.p.id, quantity: 1 }], { paymentMethod: 'card' });
  assert.equal((await refund(s, payRow(unpaid.body.data.order.id).id, { reason: 'x' })).body.error.code, 'not_refundable');
  assert.equal((await refund(s, 987654, { reason: 'x' })).status, 404);
});

test('provider refund failure leaves money state untouched and can be retried; pending refunds reserve the amount', async () => {
  const s = await setup();
  const { id, payment } = await paidOrder(s);
  t.fake.behavior.failRefunds = true;
  const failed = await refund(s, payment.id, { reason: 'try' });
  assert.equal(failed.body.data.refund.status, 'failed');
  assert.equal(payRow(id).refunded_cents, 0);
  assert.equal(payRow(id).status, 'succeeded');
  assert.equal(ledgerSum(id).s, 9000);
  t.fake.behavior.failRefunds = false;

  t.fake.behavior.pendingRefunds = true;
  const pending = await refund(s, payment.id, { amountCents: 6000, reason: 'slow provider' });
  t.fake.behavior.pendingRefunds = false;
  assert.equal(pending.body.data.refund.status, 'pending');
  assert.equal(payRow(id).refunded_cents, 0); // not booked until the provider confirms
  const over = await refund(s, payment.id, { amountCents: 5000, reason: 'would exceed with the pending one' });
  assert.equal(over.status, 422);
  assert.equal((await refund(s, payment.id, { amountCents: 4000, reason: 'remaining' })).status, 201);
});

test('provider outage during refund: nothing is booked, refund recorded as failed, safe to retry', async () => {
  const s = await setup();
  const { id, payment } = await paidOrder(s);
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { if (String(url).includes('/refunds')) throw new Error('network down'); return realFetch(url, opts); };
  try {
    const r = await refund(s, payment.id, { reason: 'x' });
    assert.equal(r.status, 502);
  } finally { global.fetch = realFetch; }
  assert.equal(payRow(id).refunded_cents, 0);
  assert.equal(t.db.prepare("SELECT status FROM refunds WHERE payment_id = ?").get(payment.id).status, 'failed');
  assert.equal((await refund(s, payment.id, { reason: 'retry' })).status, 201);
});

test('cancelling or rejecting a paid card order refunds it automatically (restaurant, customer and admin paths)', async () => {
  const s = await setup();
  const set = (id, status, token = s.o.token) => t.call('PATCH', `/api/manage/orders/${id}/status`, { token, body: { status } });

  const a = await paidOrder(s);
  assert.equal((await set(a.id, 'rejected')).status, 200);
  assert.equal(payRow(a.id).status, 'refunded');
  assert.equal(ledgerSum(a.id).s, 0);

  const b = await paidOrder(s);
  assert.equal((await t.call('POST', `/api/me/orders/${b.id}/cancel`, { token: s.c.token })).status, 200);
  assert.equal(payRow(b.id).status, 'refunded');

  const c = await paidOrder(s);
  await advance(s, c.id, ['confirmed', 'preparing']);
  assert.equal((await t.call('POST', `/api/admin/orders/${c.id}/cancel`, { token: s.admin.token, body: { reason: 'Kitchen fire' } })).status, 200);
  assert.equal(payRow(c.id).status, 'refunded');
  assert.equal(orderRow(c.id).status, 'cancelled');
  assert.equal(orderRow(c.id).payment_status, 'refunded');
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM refunds WHERE order_id IN (?,?,?)').get(a.id, b.id, c.id).c, 3);
  // never refunded twice even if the status call is repeated
  assert.equal((await set(a.id, 'cancelled')).status, 409);
});

test('ledger: online sale becomes payable only after delivery; COD creates a commission receivable', async () => {
  const s = await setup();
  const a = await paidOrder(s);
  let bal = (await t.call('GET', '/api/manage/earnings', { token: s.o.token })).body.data;
  assert.equal(bal.pendingCents, 9000);
  assert.equal(bal.availableCents, 0);
  await advance(s, a.id);
  bal = (await t.call('GET', '/api/manage/earnings', { token: s.o.token })).body.data;
  assert.equal(bal.pendingCents, 0);
  assert.equal(bal.availableCents, 9000);
  assert.equal(bal.commissionCents, 1000);

  const cod = await codOrder(s, 2); // 20000 cash
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE order_id = ?').get(cod.id).c, 0); // nothing until delivered
  await advance(s, cod.id);
  const e = t.db.prepare("SELECT * FROM ledger_entries WHERE order_id = ? AND entry_type = 'cod_commission'").get(cod.id);
  assert.equal(e.gross_amount_cents, 20000);
  assert.equal(e.platform_commission_cents, 2000);
  assert.equal(e.restaurant_amount_cents, -2000);
  assert.equal(orderRow(cod.id).payment_status, 'cash_collected');
  assert.equal(payRow(cod.id).status, 'cash_collected');
  bal = (await t.call('GET', '/api/manage/earnings', { token: s.o.token })).body.data;
  assert.equal(bal.codCommissionDueCents, 2000);
  assert.equal(bal.availableCents, 9000); // COD never counts as online earnings

  // the ledger is append-only
  assert.throws(() => t.db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(e.id), /append-only/);
  // a COD order that was cancelled leaves no receivable
  const c2 = await codOrder(s);
  await t.call('PATCH', `/api/manage/orders/${c2.id}/status`, { token: s.o.token, body: { status: 'rejected' } });
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE order_id = ?').get(c2.id).c, 0);

  // admin records that the commission was collected
  const settle = await t.call('POST', `/api/admin/restaurants/${s.o.restaurant.id}/cod-settlement`, { token: s.admin.token, body: { note: 'bank transfer ref 123' } });
  assert.equal(settle.body.data.settledEntries, 1);
  assert.equal((await t.call('GET', '/api/manage/earnings', { token: s.o.token })).body.data.codCommissionDueCents, 0);
});

// ------------------------------------------------------------------------------- payouts
const NOW = new Date('2026-03-12T09:00:00Z'); // Thursday: the week to pay is the previous Mon-Sun
async function deliveredPaid(s) {
  const a = await paidOrder(s);
  await advance(s, a.id);
  return a;
}
const placeInWeek = (orderId, period) => t.db.prepare('UPDATE ledger_entries SET eligible_at = ? WHERE order_id = ?').run(`${period.periodStart}T12:00:00.000Z`, orderId);

test('week boundaries: the payout period is the last complete Monday-Sunday (UTC)', () => {
  const w = payouts.lastFullWeek(NOW);
  assert.equal(new Date(`${w.periodStart}T00:00:00Z`).getUTCDay(), 1);
  assert.equal(new Date(`${w.periodEnd}T00:00:00Z`).getUTCDay(), 0);
  assert.equal(w.periodStart, '2026-03-02');
  assert.equal(w.periodEnd, '2026-03-08');
  // on a Monday morning the week that just ended is paid
  assert.equal(payouts.lastFullWeek(new Date('2026-03-09T00:00:01Z')).periodStart, '2026-03-02');
  assert.equal(payouts.lastFullWeek(new Date('2026-03-08T23:59:59Z')).periodStart, '2026-02-23');
});

test('weekly payout: sums delivered online earnings net of commission, excludes the current week, never duplicates', async () => {
  const s = await setup();
  const period = payouts.lastFullWeek(NOW);
  const a = await deliveredPaid(s);
  const b = await deliveredPaid(s);
  const current = await deliveredPaid(s); // delivered "this week": not part of last week's payout
  const undelivered = await paidOrder(s);
  placeInWeek(a.id, period); placeInWeek(b.id, period);
  t.db.prepare('UPDATE ledger_entries SET eligible_at = ? WHERE order_id = ?').run('2026-03-11T08:00:00.000Z', current.id);

  const res = payouts.generateWeeklyPayouts(t.db, { now: NOW });
  const mine = res.created.find((c) => c.restaurantId === s.o.restaurant.id);
  assert.ok(mine);
  assert.equal(mine.amountCents, 2 * 9000);
  assert.equal(mine.entries, 2);
  const payout = t.db.prepare('SELECT * FROM payouts WHERE restaurant_id = ?').get(s.o.restaurant.id);
  assert.equal(payout.status, 'eligible');
  assert.equal(payout.period_start, '2026-03-02');
  assert.equal(payout.currency, 'SAR');
  assert.equal(t.db.prepare("SELECT COUNT(*) c FROM ledger_entries WHERE payout_id = ?").get(payout.id).c, 2);
  assert.equal(t.db.prepare('SELECT payout_id FROM ledger_entries WHERE order_id = ?').get(current.id).payout_id, null);
  assert.equal(t.db.prepare('SELECT payout_id FROM ledger_entries WHERE order_id = ?').get(undelivered.id).payout_id, null);

  // run again, and again concurrently: still exactly one payout and no entry in two payouts
  payouts.generateWeeklyPayouts(t.db, { now: NOW });
  payouts.generateWeeklyPayouts(t.db, { now: NOW });
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM payouts WHERE restaurant_id = ?').get(s.o.restaurant.id).c, 1);
  assert.deepEqual(payouts.generateForRestaurant(t.db, s.o.restaurant.id, payouts.lastFullWeek(NOW)), { skipped: 'already_generated' });
  // the database itself forbids a second payout for the same restaurant-week
  assert.throws(() => t.db.prepare("INSERT INTO payouts (restaurant_id, amount_cents, currency, provider, period_start, period_end) VALUES (?,?,?,?,?,?)").run(s.o.restaurant.id, 1, 'USD', 'tap', '2026-03-02', '2026-03-08'), /UNIQUE/);

  // the owner sees it
  const mineView = (await t.call('GET', '/api/manage/payouts', { token: s.o.token })).body.data.payouts;
  assert.equal(mineView.length, 1);
  assert.equal(mineView[0].amountCents, 18000);
  // a different restaurant sees nothing
  const other = await t.createRestaurantOwner('Not Mine');
  assert.equal((await t.call('GET', '/api/manage/payouts', { token: other.token })).body.data.payouts.length, 0);

  // next week's run picks up the order that was delivered in between
  const next = payouts.generateWeeklyPayouts(t.db, { now: new Date('2026-03-19T09:00:00Z') });
  assert.equal(next.created.find((c) => c.restaurantId === s.o.restaurant.id).amountCents, 9000);
});

test('refund after a payout was generated is carried into the next statement as a negative entry', async () => {
  const s = await setup();
  const period = payouts.lastFullWeek(NOW);
  const a = await deliveredPaid(s);
  const b = await deliveredPaid(s);
  placeInWeek(a.id, period); placeInWeek(b.id, period);
  payouts.generateWeeklyPayouts(t.db, { now: NOW });
  assert.equal(t.db.prepare('SELECT amount_cents FROM payouts WHERE restaurant_id = ?').get(s.o.restaurant.id).amount_cents, 18000);

  await refund(s, a.payment.id, { reason: 'late complaint' }); // order a refunded after its week was already statemented
  const pending = (await t.call('GET', '/api/manage/earnings', { token: s.o.token })).body.data;
  assert.equal(pending.availableCents, -9000);
  // negative balance: no payout is created, it is carried forward
  const w2 = payouts.generateWeeklyPayouts(t.db, { now: new Date('2026-03-19T09:00:00Z') });
  assert.equal(w2.created.find((c) => c.restaurantId === s.o.restaurant.id), undefined);
  // new earnings in a later week absorb the carried-over debit: net zero -> still no payout, nothing lost
  const c = await deliveredPaid(s);
  t.db.prepare('UPDATE ledger_entries SET eligible_at = ? WHERE order_id = ?').run('2026-03-23T10:00:00.000Z', c.id);
  const w3 = payouts.generateWeeklyPayouts(t.db, { now: new Date('2026-03-30T09:00:00Z') });
  assert.equal(w3.created.find((x) => x.restaurantId === s.o.restaurant.id), undefined);
  // the following week's earnings are paid out in full (+9000), the earlier debit and credit having cancelled out
  const d = await deliveredPaid(s);
  t.db.prepare('UPDATE ledger_entries SET eligible_at = ? WHERE order_id = ?').run('2026-04-01T10:00:00.000Z', d.id);
  const w4 = payouts.generateWeeklyPayouts(t.db, { now: new Date('2026-04-09T09:00:00Z') });
  const p4 = w4.created.find((x) => x.restaurantId === s.o.restaurant.id);
  assert.equal(p4.amountCents, 9000);
  assert.equal(p4.entries, 3); // the refund reversal (-9000), c (+9000) and d (+9000)
});

test('payout workflow (admin): an admin can never mark a payout paid directly; manual payouts need a reference; failed needs a reason', async () => {
  const s = await setup();
  const period = payouts.lastFullWeek(NOW);
  const a = await deliveredPaid(s);
  placeInWeek(a.id, period);
  payouts.generateWeeklyPayouts(t.db, { now: NOW });
  const row = () => t.db.prepare('SELECT * FROM payouts WHERE restaurant_id = ?').get(s.o.restaurant.id);
  const id = row().id;
  assert.equal(row().status, 'eligible'); // the restaurant's payout account is verified
  const patch = (body, token = s.admin.token) => t.call('PATCH', `/api/admin/payouts/${id}`, { token, body });

  assert.equal((await patch({ status: 'paid', reference: 'X' }, s.o.token)).status, 403); // owners cannot touch payouts
  assert.equal((await patch({ status: 'paid', reference: 'X' })).status, 409); // not even admins: only the provider confirms, or manual_payout first
  assert.equal((await patch({ status: 'processing' })).status, 400); // provider-only state
  assert.equal((await patch({ status: 'requested' })).status, 400);
  assert.equal((await patch({ status: 'manual_payout' })).status, 200);
  assert.equal((await patch({ status: 'paid' })).status, 400); // reference required
  assert.equal((await patch({ status: 'failed' })).status, 400); // reason required
  assert.equal((await patch({ status: 'failed', failureReason: 'IBAN rejected by bank' })).status, 200);
  assert.equal(row().failure_reason, 'IBAN rejected by bank');
  assert.equal((await patch({ status: 'pending' })).status, 200); // retry -> eligible again
  assert.equal(row().status, 'eligible');
  assert.equal((await patch({ status: 'manual_payout' })).status, 200);
  const paid = await patch({ status: 'paid', reference: 'BANK-REF-8812' });
  assert.equal(paid.status, 200);
  assert.ok(paid.body.data.payout.paidAt);
  assert.equal(paid.body.data.payout.confirmationSource, 'admin_manual'); // never presented as provider-confirmed
  assert.equal(row().provider_payout_id, 'manual:BANK-REF-8812');
  const owner = (await t.call('GET', '/api/manage/payouts', { token: s.o.token })).body.data.payouts[0];
  assert.equal(owner.confirmedBy, 'recorded manually by the platform');
  const e = t.db.prepare('SELECT payout_status, payout_date FROM ledger_entries WHERE order_id = ?').get(a.id);
  assert.equal(e.payout_status, 'paid');
  assert.ok(e.payout_date);
  assert.equal((await patch({ status: 'cancelled' })).status, 409); // paid is final
  assert.equal((await patch({ status: 'pending' })).status, 409);
  assert.equal((await patch({ status: 'bogus' })).status, 400);
  // the database itself refuses 'paid' without a reference and a confirmation source
  assert.throws(() => t.db.prepare("UPDATE payouts SET status = 'paid', confirmation_source = NULL WHERE id = ?").run(id));
  assert.ok(t.db.prepare('SELECT COUNT(*) c FROM payout_events WHERE payout_id = ?').get(id).c >= 6);

  // cancelling a pending payout releases its entries for the next run
  const b = await deliveredPaid(s);
  placeInWeek(b.id, { periodStart: '2026-03-09' });
  payouts.generateWeeklyPayouts(t.db, { now: new Date('2026-03-19T09:00:00Z') });
  const id2 = t.db.prepare("SELECT id FROM payouts WHERE restaurant_id = ? AND period_start = '2026-03-09'").get(s.o.restaurant.id).id;
  assert.equal((await t.call('PATCH', `/api/admin/payouts/${id2}`, { token: s.admin.token, body: { status: 'cancelled' } })).status, 200);
  assert.equal(t.db.prepare('SELECT payout_id, payout_status FROM ledger_entries WHERE order_id = ?').get(b.id).payout_id, null);
  const audit = t.db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action LIKE 'payout.%'").get().c;
  assert.ok(audit >= 5);
});

test('manual_transfer mode nets cash-order commission off the restaurant payout', async () => {
  const s = await setup();
  t.config.payoutMode = 'manual_transfer';
  try {
    const period = payouts.lastFullWeek(NOW);
    const online = await deliveredPaid(s); // +9000
    const cod = await codOrder(s, 1);
    await advance(s, cod.id); // -1000 owed
    placeInWeek(online.id, period);
    t.db.prepare('UPDATE ledger_entries SET eligible_at = ? WHERE order_id = ?').run(`${period.periodStart}T13:00:00.000Z`, cod.id);
    const res = payouts.generateWeeklyPayouts(t.db, { now: NOW });
    assert.equal(res.created.find((c) => c.restaurantId === s.o.restaurant.id).amountCents, 8000);
  } finally { t.config.payoutMode = 'provider_settled'; }
});
