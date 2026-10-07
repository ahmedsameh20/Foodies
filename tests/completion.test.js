const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const payouts = require('../server/services/payouts');
const payments = require('../server/services/payments');
const finance = require('../server/services/finance');
const { createProvider, ProviderError, INTERFACE, paymentConfigStatus } = require('../server/payments/provider');
const { computeOrderTotals } = require('../server/services/money');

// Payment-architecture tests. Provider traffic uses the local Tap TEST DOUBLE (tests/fakeTap.js) and, for payout
// events, a stub adapter defined here: they prove OUR logic. They prove nothing about Tap's real behaviour.
let t, admin;
before(async () => { t = await startApp({ tap: true }); admin = await t.createAdminUser(); });
after(async () => { await t.close(); });

const NOW = new Date('2026-03-12T09:00:00Z');
const A = (m, p, body, token = admin.token, headers) => t.call(m, `/api/admin${p}`, { token, body, headers });
const payRow = (orderId) => t.db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);

async function seller({ payoutAccount = true, commissionBp = 1000, price = 10000 } = {}) {
  const o = await t.createRestaurantOwner('Finance Place', 'pro', { payoutAccount });
  t.db.prepare('UPDATE restaurants SET commission_bp_override = ? WHERE id = ?').run(commissionBp, o.restaurant.id);
  const p = await t.addProduct(o, { priceCents: price });
  const c = await t.registerCustomer();
  return { o, p, c };
}
async function paidOrder(s, { deliver = true } = {}) {
  const r = await t.placeOrder(s.o, s.c, [{ productId: s.p.id, quantity: 1 }], { paymentMethod: 'card' });
  assert.equal(r.status, 201, r.text);
  const id = r.body.data.order.id;
  const charge = payRow(id).provider_transaction_id;
  t.fake.capture(charge);
  const w = t.fake.webhookFor(charge);
  assert.equal((await t.call('POST', '/webhooks/tap', { body: w.body, headers: w.headers })).status, 200);
  if (deliver) for (const st of ['confirmed', 'preparing', 'ready', 'delivered']) await t.call('PATCH', `/api/manage/orders/${id}/status`, { token: s.o.token, body: { status: st } });
  return { id, charge };
}
const place = (s, id) => t.db.prepare('UPDATE ledger_entries SET eligible_at = ? WHERE order_id = ?').run(`${payouts.lastFullWeek(NOW).periodStart}T12:00:00.000Z`, id);

// ------------------------------------------------------------------------------------------------ commission
test('commission is configurable: percentage + fixed, per-restaurant overrides, capped at the food value, snapshotted per order', async () => {
  assert.equal(computeOrderTotals({ subtotalCents: 10000, commissionBp: 1000 }).commissionCents, 1000);
  assert.equal(computeOrderTotals({ subtotalCents: 10000, commissionBp: 1000, commissionFixedCents: 150 }).commissionCents, 1150);
  assert.equal(computeOrderTotals({ subtotalCents: 100, commissionBp: 1000, commissionFixedCents: 500 }).commissionCents, 100); // never more than the food
  const r = computeOrderTotals({ subtotalCents: 10000, commissionBp: 1000, commissionFixedCents: 150 });
  assert.equal(r.restaurantAmountCents, r.totalCents - r.commissionCents - r.platformFeeCents);

  const s = await seller({ commissionBp: null });
  t.db.prepare('UPDATE restaurants SET commission_bp_override = NULL WHERE id = ?').run(s.o.restaurant.id);
  assert.equal((await A('PUT', '/settings', { commissionBp: 800, commissionFixedCents: 100 })).status, 200);
  const o1 = await paidOrder(s, { deliver: false });
  const ord1 = t.db.prepare('SELECT * FROM orders WHERE id = ?').get(o1.id);
  assert.deepEqual([ord1.commission_bp, ord1.commission_fixed_cents, ord1.commission_cents], [800, 100, 900]);
  // restaurant-specific override (percentage and fixed) wins; old orders keep the rate they were placed with
  assert.equal((await A('PATCH', `/restaurants/${s.o.restaurant.id}`, { commissionBpOverride: 500, commissionFixedOverride: 0 })).status, 200);
  const o2 = await paidOrder(s, { deliver: false });
  assert.equal(t.db.prepare('SELECT commission_cents FROM orders WHERE id = ?').get(o2.id).commission_cents, 500);
  assert.equal(t.db.prepare('SELECT commission_cents FROM orders WHERE id = ?').get(o1.id).commission_cents, 900);
  // the amount sent to the provider for the restaurant reflects the dynamic commission
  const split = t.fake.calls.filter((c) => c.url === '/charges').pop().body.destinations.destination[0];
  assert.equal(split.amount, 95);
  assert.equal((await A('PUT', '/settings', { commissionBp: 1000, commissionFixedCents: 0 })).status, 200);
  assert.equal((await t.call('PUT', '/api/admin/settings', { token: s.o.token, body: { commissionBp: 0 } })).status, 403); // restaurants cannot set their own commission
});

// ------------------------------------------------------------------------------------------------ payout account lifecycle
test('payout account: NOT_ONBOARDED -> ONBOARDING -> PENDING_VERIFICATION -> VERIFIED, with REJECTED / SUSPENDED / DISABLED; no bank or card data accepted', async () => {
  const s = await seller({ payoutAccount: false });
  const rid = s.o.restaurant.id;
  const view = async () => (await t.call('GET', '/api/manage/payment-account', { token: s.o.token })).body.data.paymentAccount;
  assert.equal((await view()).status, 'NOT_ONBOARDED');
  assert.equal((await view()).displayStatus, 'NOT_STARTED');
  assert.equal((await view()).onlinePaymentsEnabled, false);
  assert.equal((await t.call('GET', `/api/public/restaurants/${s.o.restaurant.slug}`)).body.data.restaurant.paymentMethods.card, false);

  // sensitive fields are refused outright
  const form = { legalName: 'Finance Place LLC', registrationNumber: '1010123456', contactName: 'Olive Owner', contactPhone: '+966500000000', contactEmail: 'olive@example.com' };
  for (const bad of ['iban', 'cardNumber', 'cvv', 'bankPassword', 'accountNumber']) {
    assert.equal((await t.call('POST', '/api/manage/payment-account/apply', { token: s.o.token, body: { ...form, [bad]: 'x' } })).status, 400, bad);
  }
  assert.equal((await t.call('POST', '/api/manage/payment-account/apply', { token: s.o.token, body: { ...form, contactEmail: 'nope' } })).status, 400);
  assert.equal((await t.call('POST', '/api/manage/payment-account/apply', { token: s.c.token, body: form })).status, 403); // customers cannot
  const applied = await t.call('POST', '/api/manage/payment-account/apply', { token: s.o.token, body: form });
  assert.equal(applied.status, 201);
  assert.equal(applied.body.data.paymentAccount.status, 'ONBOARDING');
  assert.equal(applied.body.data.paymentAccount.displayStatus, 'PENDING');
  const apps = await A('GET', '/payment-applications');
  assert.ok(apps.body.data.applications.some((a) => a.restaurantId === rid && a.legalName === 'Finance Place LLC'));
  assert.equal((await t.call('GET', '/api/admin/payment-applications', { token: s.o.token })).status, 403);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM audit_logs WHERE action = ? AND target_id = ?').get('payment_account.application_submitted', String(rid)).c, 1);

  // an admin cannot declare it verified without the provider confirming the destination
  const claim = { connectedAccountId: 'dest_known', payoutEnabled: true, onboardingStatus: 'completed', verificationStatus: 'verified', payoutAccountStatus: 'active' };
  assert.equal((await A('PUT', `/restaurants/${rid}/payment-account`, { ...claim, connectedAccountId: 'dest_nope' })).status, 422);
  assert.equal((await A('PUT', `/restaurants/${rid}/payment-account`, { ...claim, iban: 'SA0380000000608010167519' })).status, 400);
  assert.equal((await A('PUT', `/restaurants/${rid}/payment-account`, { ...claim, maskedBank: 'SA0380000000608010167519' })).status, 400); // only a masked value
  // linked but not yet verified -> PENDING_VERIFICATION
  assert.equal((await A('PUT', `/restaurants/${rid}/payment-account`, { connectedAccountId: 'dest_known', onboardingStatus: 'in_progress', verificationStatus: 'pending' })).status, 200);
  assert.equal((await view()).status, 'PENDING_VERIFICATION');
  assert.equal((await view()).displayStatus, 'UNDER_REVIEW');
  assert.equal((await t.call('GET', `/api/public/restaurants/${s.o.restaurant.slug}`)).body.data.restaurant.paymentMethods.card, false);
  // provider-confirmed -> VERIFIED, card payments open, masked bank shown
  assert.equal((await A('PUT', `/restaurants/${rid}/payment-account`, { ...claim, maskedBank: '****1234', settlementCurrency: 'SAR' })).status, 200);
  const v = await view();
  assert.equal(v.status, 'VERIFIED');
  assert.equal(v.maskedBank, '****1234');
  assert.equal(v.settlementCurrency, 'SAR');
  assert.ok(v.lastVerifiedAt);
  assert.equal(v.onlinePaymentsEnabled, true);
  assert.equal((await t.call('GET', `/api/public/restaurants/${s.o.restaurant.slug}`)).body.data.restaurant.paymentMethods.card, true);
  assert.ok(!JSON.stringify(v).includes('dest_known'));
  assert.equal((await t.call('POST', '/api/manage/payment-account/apply', { token: s.o.token, body: form })).status, 409); // already verified
  // suspended / disabled / rejected close card payments again
  for (const [patch, expected] of [[{ payoutAccountStatus: 'restricted' }, 'SUSPENDED'], [{ disabled: true }, 'DISABLED'], [{ onboardingStatus: 'rejected', verificationStatus: 'rejected', rejectionReason: 'documents unreadable' }, 'REJECTED']]) {
    assert.equal((await A('PUT', `/restaurants/${rid}/payment-account`, { ...claim, ...(patch.disabled || patch.payoutAccountStatus ? {} : { payoutEnabled: false, payoutAccountStatus: 'inactive' }), ...patch })).status, 200, expected);
    assert.equal((await view()).status, expected);
    assert.equal((await t.call('GET', `/api/public/restaurants/${s.o.restaurant.slug}`)).body.data.restaurant.paymentMethods.card, false, expected);
    const r = await t.placeOrder(s.o, s.c, [{ productId: s.p.id, quantity: 1 }], { paymentMethod: 'card' });
    assert.equal(r.status, 422, expected);
  }
  assert.equal((await view()).rejectionReason, 'documents unreadable');
  // one provider account can belong to only one restaurant: it can never route restaurant B's money to restaurant A's account
  const other = await seller();
  const reuse = await A('PUT', `/restaurants/${other.o.restaurant.id}/payment-account`, claim);
  assert.equal(reuse.status, 409);
  assert.equal(reuse.body.error.code, 'destination_in_use');
});

test('payout accounts cannot be verified with no provider configured (no fake VERIFIED)', async () => {
  const none = await startApp({ tap: false });
  try {
    const a = await none.createAdminUser();
    const o = await none.createRestaurantOwner('No Provider', 'pro');
    const r = await none.call('PUT', `/api/admin/restaurants/${o.restaurant.id}/payment-account`, { token: a.token, body: { connectedAccountId: 'dest_x', payoutEnabled: true, onboardingStatus: 'completed', verificationStatus: 'verified', payoutAccountStatus: 'active' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'provider_confirmation_required');
    assert.equal((await none.call('POST', '/api/manage/payment-account/apply', { token: o.token, body: {} })).status, 409); // payments_not_enabled
    assert.equal((await none.call('GET', '/api/manage/payment-account', { token: o.token })).body.data.paymentAccount.onlinePaymentsEnabled, false);
  } finally { await none.close(); }
});

// ------------------------------------------------------------------------------------------------ payouts
test('payout eligibility: statements wait as pending until the account is VERIFIED, then become eligible; minimum payout carries forward', async () => {
  const s = await seller();
  const a = await paidOrder(s);
  place(s, a.id);
  const dest = `dest_e_${s.o.restaurant.id}`;
  t.fake.behavior.knownDestinations.add(dest);
  const claim = { connectedAccountId: dest, payoutEnabled: true, onboardingStatus: 'completed', verificationStatus: 'verified', payoutAccountStatus: 'active' };
  assert.equal((await A('PUT', `/restaurants/${s.o.restaurant.id}/payment-account`, { ...claim, disabled: true })).status, 200); // account disabled before the statement is created
  const res = payouts.generateWeeklyPayouts(t.db, { now: NOW });
  const mine = res.created.find((c) => c.restaurantId === s.o.restaurant.id);
  const row = () => t.db.prepare('SELECT * FROM payouts WHERE restaurant_id = ?').get(s.o.restaurant.id);
  assert.equal(row().status, 'pending');
  assert.equal(mine.amountCents, 9000);
  // account becomes verified by the provider -> statement is promoted
  await A('PUT', `/restaurants/${s.o.restaurant.id}/payment-account`, claim);
  assert.equal(row().status, 'eligible');
  assert.ok(t.db.prepare("SELECT COUNT(*) c FROM payout_events WHERE payout_id = ? AND to_status = 'eligible'").get(row().id).c >= 1);

  // minimum payout: below the threshold nothing is created and the earnings stay unassigned for the next week
  const m = await seller();
  const b = await paidOrder(m);
  t.db.prepare('UPDATE ledger_entries SET eligible_at = ? WHERE order_id = ?').run('2026-03-03T12:00:00.000Z', b.id);
  await A('PUT', '/settings', { minPayoutCents: 1000000 });
  try {
    const r2 = payouts.generateForRestaurant(t.db, m.o.restaurant.id, payouts.lastFullWeek(NOW));
    assert.equal(r2.skipped, 'below_minimum_payout');
    assert.equal(t.db.prepare('SELECT payout_id FROM ledger_entries WHERE order_id = ?').get(b.id).payout_id, null);
  } finally { await A('PUT', '/settings', { minPayoutCents: 0 }); }
  assert.ok(payouts.generateForRestaurant(t.db, m.o.restaurant.id, payouts.lastFullWeek(NOW)).payoutId);
});

test('provider payout lifecycle: request, events (processing/paid/failed/reversed), duplicate events, mismatches; Tap createPayout is NOT VERIFIED (501)', async () => {
  const s = await seller();
  const a = await paidOrder(s);
  place(s, a.id);
  payouts.generateWeeklyPayouts(t.db, { now: NOW });
  const id = t.db.prepare('SELECT id FROM payouts WHERE restaurant_id = ?').get(s.o.restaurant.id).id;
  const row = () => t.db.prepare('SELECT * FROM payouts WHERE id = ?').get(id);
  assert.equal(row().status, 'eligible');

  // the real Tap adapter does not claim payout capability
  const r501 = await A('POST', `/payouts/${id}/request`, {});
  assert.equal(r501.status, 501);
  assert.equal(r501.body.error.code, 'provider_capability_unavailable');
  assert.equal(row().status, 'eligible');

  // a stub provider that does implement it (test only)
  const stub = { name: 'tap', enabled: true, capabilities: {}, createPayout: async () => ({ providerPayoutId: 'po_123' }) };
  await payouts.requestPayout(t.db, stub, id, admin.user);
  assert.equal(row().status, 'requested');
  assert.equal(row().provider_payout_id, 'po_123');
  await assert.rejects(() => payouts.requestPayout(t.db, stub, id, admin.user), /eligible/); // cannot be requested twice

  const ev = (eventId, status, extra = {}) => payouts.applyProviderEvent(t.db, { eventId, providerPayoutId: 'po_123', status, ...extra });
  assert.equal(ev('e1', 'processing').applied, true);
  assert.equal(ev('e1', 'processing').duplicate, true); // duplicate delivery of the same event
  assert.equal(ev('e2', 'paid', { amountCents: 1, currency: 'SAR' }).mismatch, true); // wrong amount never marks paid
  assert.equal(row().status, 'processing');
  assert.equal(ev('e3', 'paid', { amountCents: 9000, currency: 'EUR' }).mismatch, true); // wrong currency
  assert.equal(ev('e4', 'paid', { amountCents: 9000, currency: 'SAR' }).applied, true);
  assert.equal(row().status, 'paid');
  assert.equal(row().confirmation_source, 'provider');
  assert.equal(t.db.prepare('SELECT payout_status FROM ledger_entries WHERE order_id = ?').get(a.id).payout_status, 'paid');
  assert.equal(ev('e5', 'processing').ignored, true); // paid cannot go backwards
  assert.equal(payouts.applyProviderEvent(t.db, { eventId: 'x', providerPayoutId: 'po_unknown', status: 'paid' }).unknown, true);
  // reversal releases the money back to the restaurant's unpaid earnings so it can be paid again
  assert.equal(ev('e6', 'reversed').applied, true);
  assert.equal(row().status, 'reversed');
  const le = t.db.prepare('SELECT payout_id, payout_status FROM ledger_entries WHERE order_id = ?').get(a.id);
  assert.deepEqual([le.payout_id, le.payout_status], [null, 'unpaid']);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM payout_events WHERE provider_event_id IS NOT NULL').get().c >= 5, true);
});

test('payout webhooks: invalid signature rejected, valid event applied once, authoritative re-fetch overrides the body', async () => {
  const s = await seller();
  const a = await paidOrder(s);
  place(s, a.id);
  payouts.generateWeeklyPayouts(t.db, { now: NOW });
  const id = t.db.prepare('SELECT id FROM payouts WHERE restaurant_id = ?').get(s.o.restaurant.id).id;
  t.db.prepare("UPDATE payouts SET status = 'requested', provider_payout_id = 'po_wh' WHERE id = ?").run(id);
  let remote = { status: 'paid', amountCents: 9000, currency: 'SAR' };
  const stub = {
    name: 'tap', enabled: true, capabilities: {},
    parsePayoutEvent: (_h, body) => (body.kind !== 'payout' ? null : body.sig !== 'good' ? { invalidSignature: true } : { eventId: body.eventId, providerPayoutId: 'po_wh', status: body.status, amountCents: body.amountCents, currency: 'SAR', raw: body }),
    getPayout: async () => remote,
    verifyWebhook: () => false,
  };
  const call = (body) => payments.handleWebhook(t.db, stub, { headers: {}, body });
  await assert.rejects(() => call({ kind: 'payout', sig: 'bad', eventId: 'w0' }), (e) => e.status === 401);
  // the body claims "paid" but the provider's own record says it is still processing: the provider wins
  remote = { status: 'processing', amountCents: 9000, currency: 'SAR' };
  assert.equal((await call({ kind: 'payout', sig: 'good', eventId: 'w1', status: 'paid', amountCents: 9000 })).status, 'processing');
  assert.equal(t.db.prepare('SELECT status FROM payouts WHERE id = ?').get(id).status, 'processing');
  remote = { status: 'paid', amountCents: 9000, currency: 'SAR' };
  assert.equal((await call({ kind: 'payout', sig: 'good', eventId: 'w2', status: 'paid', amountCents: 9000 })).status, 'paid');
  assert.equal((await call({ kind: 'payout', sig: 'good', eventId: 'w2', status: 'paid', amountCents: 9000 })).duplicate, true);
  assert.equal(t.db.prepare('SELECT confirmation_source c FROM payouts WHERE id = ?').get(id).c, 'provider');
  assert.equal(t.db.prepare("SELECT COUNT(*) c FROM webhook_events WHERE event_key = 'payout:w2'").get().c, 1);
  // the Tap adapter has no payout event parser: such events are never trusted
  assert.equal(typeof createProvider(t.config).parsePayoutEvent, 'undefined');
});

// ------------------------------------------------------------------------------------------------ restaurant finance dashboard
test('restaurant finance dashboard: balances, fees, refunds, paid out, next payout; tenant-scoped', async () => {
  const s = await seller();
  const other = await seller();
  const a = await paidOrder(s);       // delivered: available 9000
  await paidOrder(s, { deliver: false }); // paid, not delivered: pending 9000
  await paidOrder(other);
  const f = (await t.call('GET', '/api/manage/finance', { token: s.o.token })).body.data.finance;
  assert.equal(f.totalSalesCents, 20000);
  assert.equal(f.platformFeesCents, 2000);
  assert.equal(f.netEarningsCents, 18000);
  assert.equal(f.availableForPayoutCents, 9000);
  assert.equal(f.pendingBalanceCents, 9000);
  assert.equal(f.currentBalanceCents, 18000);
  assert.equal(f.paidOutCents, 0);
  assert.match(f.nextPayoutDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(`${f.nextPayoutDate}T00:00:00Z`).getUTCDay(), 1);
  assert.equal(f.payoutAccount.status, 'VERIFIED');
  // a refund shows up as refunds and reduces net
  const pay = payRow(a.id);
  assert.equal((await A('POST', `/payments/${pay.id}/refund`, { amountCents: 4000, reason: 'cold food' }, admin.token, { 'Idempotency-Key': 'fin-refund-0001' })).status, 201);
  const f2 = (await t.call('GET', '/api/manage/finance', { token: s.o.token })).body.data.finance;
  assert.equal(f2.refundsCents, 4000);
  assert.equal(f2.netEarningsCents, 18000 - 3600);
  assert.equal(f2.platformFeesCents, 2000 - 400);
  // another restaurant's numbers are its own; customers and staff-less callers are fenced off
  const fo = (await t.call('GET', '/api/manage/finance', { token: other.o.token })).body.data.finance;
  assert.equal(fo.totalSalesCents, 10000);
  assert.equal((await t.call('GET', '/api/manage/finance', { token: s.c.token })).status, 403);
  assert.equal((await t.call('GET', '/api/manage/finance')).status, 401);
  assert.equal((await t.call('GET', `/api/manage/finance?restaurantId=${other.o.restaurant.id}`, { token: s.o.token, headers: { 'X-Restaurant-Id': String(other.o.restaurant.id) } })).body.data.finance.totalSalesCents, 20000);
});

// ------------------------------------------------------------------------------------------------ reconciliation
test('reconciliation: clean when records agree; flags provider/database discrepancies; admin only', async () => {
  const s = await seller();
  const a = await paidOrder(s);
  const clean = (await A('POST', '/reconciliation/run', { days: 1 })).body.data.reconciliation;
  assert.equal(clean.providerChecked, true);
  assert.ok(clean.checked >= 1);
  assert.equal(clean.findings.filter((f) => f.severity === 'critical').length, 0, JSON.stringify(clean.findings));
  assert.equal((await t.call('POST', '/api/admin/reconciliation/run', { token: s.o.token, body: {} })).status, 403);

  // provider says a different amount / a payment we think is unpaid is captured / a paid one is not
  const paid = t.fake.charges.get(a.charge);
  paid.amount = 1; // 0.01 at provider
  const bad = await seller();
  const b = await t.placeOrder(bad.o, bad.c, [{ productId: bad.p.id, quantity: 1 }], { paymentMethod: 'card' });
  t.fake.capture(payRow(b.body.data.order.id).provider_transaction_id); // captured at the provider, webhook never arrived
  const c = await paidOrder(await seller());
  t.fake.setStatus(c.charge, 'FAILED'); // recorded paid, but the provider says failed
  t.db.prepare('UPDATE payments SET refunded_cents = 100 WHERE id = (SELECT id FROM payments WHERE order_id = ?)').run(c.id); // refunded without a refund row
  const r = (await A('POST', '/reconciliation/run', { days: 1 })).body.data.reconciliation;
  assert.equal(r.status, 'DISCREPANCIES');
  const types = r.findings.map((f) => f.type);
  for (const want of ['amount_mismatch', 'paid_at_provider_not_recorded', 'recorded_paid_not_captured', 'refund_discrepancy']) assert.ok(types.includes(want), `${want} in ${types}`);
  assert.ok(t.db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action = 'reconciliation.run'").get().c >= 2);
  paid.amount = 100; t.fake.setStatus(c.charge, 'CAPTURED');
  t.db.prepare('UPDATE payments SET refunded_cents = 0 WHERE order_id = ?').run(c.id);

  // without a provider only database invariants are checked, and it says so
  const none = await finance.reconcile(t.db, createProvider({ ...t.config, paymentProvider: 'none' }), {});
  assert.equal(none.providerChecked, false);
  assert.match(none.skippedReason, /No payment provider/);
});

// ------------------------------------------------------------------------------------------------ SaaS invoice refund + reports
test('SaaS invoice refund: idempotent, never above the amount, a full refund ends access; separate from order refunds', async () => {
  const o = await t.createRestaurantOwner('Refund Bistro');
  await t.call('POST', '/api/manage/subscription/change', { token: o.token, body: { planCode: 'basic' } }); // trial
  const up = await t.call('POST', '/api/manage/subscription/change', { token: o.token, body: { planCode: 'pro' } });
  const inv = up.body.data.invoice;
  const charge = t.fake.lastCharge();
  t.fake.capture(charge.id);
  const w = t.fake.webhookFor(charge.id);
  await t.call('POST', '/webhooks/tap', { body: w.body, headers: w.headers });
  assert.equal(t.db.prepare('SELECT status FROM subscriptions WHERE restaurant_id = ?').get(o.restaurant.id).status, 'active');
  const orderRefundsBefore = t.db.prepare('SELECT COUNT(*) c FROM refunds').get().c;
  const key = { 'Idempotency-Key': 'inv-refund-000001' };
  assert.equal((await A('POST', `/invoices/${inv.id}/refund`, { reason: 'x' }, o.token, key)).status, 403);
  assert.equal((await A('POST', `/invoices/${inv.id}/refund`, { reason: 'x' }, admin.token, {})).status, 400); // key required
  const part = await A('POST', `/invoices/${inv.id}/refund`, { amountCents: 1900, reason: 'goodwill' }, admin.token, key);
  assert.equal(part.status, 201);
  assert.equal(part.body.data.refund.status, 'succeeded');
  assert.equal(t.db.prepare('SELECT status FROM subscriptions WHERE restaurant_id = ?').get(o.restaurant.id).status, 'active'); // partial: still active
  const replay = await A('POST', `/invoices/${inv.id}/refund`, { amountCents: 1900, reason: 'goodwill' }, admin.token, key);
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
  assert.equal(t.fake.calls.filter((c) => c.url === '/refunds').length >= 1, true);
  assert.equal((await A('POST', `/invoices/${inv.id}/refund`, { amountCents: 6100, reason: 'too much' }, admin.token, { 'Idempotency-Key': 'inv-refund-000002' })).status, 422);
  assert.equal((await A('POST', `/invoices/${inv.id}/refund`, { reason: 'cancel plan' }, admin.token, { 'Idempotency-Key': 'inv-refund-000003' })).status, 201); // the remaining 6000
  assert.equal(t.db.prepare('SELECT status FROM subscriptions WHERE restaurant_id = ?').get(o.restaurant.id).status, 'cancelled');
  assert.equal(t.db.prepare('SELECT COALESCE(SUM(amount_cents),0) s FROM saas_invoice_refunds WHERE invoice_id = ? AND status = ?').get(inv.id, 'succeeded').s, 7900);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM refunds').get().c, orderRefundsBefore); // order refund ledger untouched
  // manual invoices cannot be refunded through the provider
  const m = await t.createRestaurantOwner('Manual Bistro');
  await t.call('POST', '/api/manage/subscription/change', { token: m.token, body: { planCode: 'basic' } });
  const up2 = await t.call('POST', '/api/manage/subscription/change', { token: m.token, body: { planCode: 'pro' } });
  await A('POST', `/invoices/${up2.body.data.invoice.id}/mark-paid`, { reference: 'WIRE-1' });
  assert.equal((await A('POST', `/invoices/${up2.body.data.invoice.id}/refund`, { reason: 'x' }, admin.token, { 'Idempotency-Key': 'inv-refund-000004' })).status, 422);
});

test('admin finance report, payment settings and system health: real numbers, no secrets, honest capability statuses', async () => {
  const rep = (await A('GET', '/reports/finance')).body.data;
  const get = (m) => rep.rows.find((r) => r.metric.startsWith(m)).value;
  for (const m of ['Total online payments', 'Marketplace GMV', 'Platform commission', 'Payment success rate', 'MRR', 'ARR', 'SaaS subscription revenue', 'Payouts failed']) assert.ok(get(m) !== undefined, m);
  assert.match(get('Total online payments'), /^\d+\.\d{2}$/);
  assert.equal((await t.call('GET', '/api/admin/reports/finance?format=csv', { token: admin.token })).status, 200);
  const ps = await A('GET', '/payment-settings');
  const pay = ps.body.data.payments;
  assert.equal(pay.provider, 'tap');
  assert.equal(pay.environment, 'sandbox');
  assert.equal(pay.restaurantPayouts.automated, 'NOT_SUPPORTED'); // Tap has no create-payout API
  assert.equal(pay.usdSettlement, 'NOT_VERIFIED');
  assert.equal(pay.paymentMethods.applePay, 'NOT_VERIFIED');
  assert.equal(pay.sandbox, 'CONFIGURED_NOT_TESTED');
  assert.ok(!JSON.stringify(ps.body).includes(t.fake.secret), 'the secret key is never exposed');
  assert.ok(!JSON.stringify((await A('GET', '/system')).body).includes(t.fake.secret));
  assert.equal((await t.call('GET', '/api/admin/payment-settings', { token: (await t.registerCustomer()).token })).status, 403);
  const settings = (await A('GET', '/settings')).body.data;
  assert.match(settings.payoutSchedule, /weekly/);
  assert.ok('commission_fixed_cents' in settings.settings && 'min_payout_cents' in settings.settings);
});

// ------------------------------------------------------------------------------------------------ provider abstraction + configuration
test('provider interface: every method exists; unverified capabilities throw a clear, typed error (never fake success)', async () => {
  const tap = createProvider(t.config);
  for (const m of INTERFACE) assert.equal(typeof tap[m], 'function', m);
  for (const m of ['createConnectedAccount', 'getOnboardingLink', 'getRefund']) {
    await assert.rejects(() => tap[m]({}), (e) => e instanceof ProviderError && e.code === 'capability_not_verified', m);
  }
  for (const m of ['getAccountStatus', 'createPayout', 'createSubscription', 'cancelSubscription']) { // documented as absent at Tap
    await assert.rejects(() => tap[m]({}), (e) => e instanceof ProviderError && e.code === 'not_supported', m);
  }
  const none = createProvider({ ...t.config, paymentProvider: 'none' });
  assert.equal(none.enabled, false);
  await assert.rejects(() => none.createCheckout({}), (e) => e.code === 'provider_disabled');
});

test('production configuration: missing provider or merchant id is MISCONFIGURED (card payments stay off), never silently faked', () => {
  const base = { isProd: true, appUrl: 'https://x.example', paymentEnv: 'production', payment: { secretKey: 'sk_live_x', merchantId: 'm_1' } };
  assert.equal(paymentConfigStatus({ ...base, paymentProvider: 'tap' }).state, 'CONFIGURED');
  assert.deepEqual(paymentConfigStatus({ ...base, paymentProvider: 'none' }).missing, ['PAYMENT_PROVIDER']);
  assert.equal(paymentConfigStatus({ ...base, paymentProvider: 'none' }).state, 'MISCONFIGURED');
  const noMerchant = { ...base, paymentProvider: 'tap', payment: { secretKey: 'sk_live_x', merchantId: '' } };
  assert.equal(paymentConfigStatus(noMerchant).state, 'MISCONFIGURED');
  assert.deepEqual(paymentConfigStatus(noMerchant).missing, ['TAP_MERCHANT_ID']);
  const p = createProvider(noMerchant);
  assert.equal(p.enabled, false);
  assert.match(p.misconfigured, /TAP_MERCHANT_ID/);
  assert.equal(paymentConfigStatus({ ...base, isProd: false, paymentProvider: 'none' }).state, 'DISABLED');
});
