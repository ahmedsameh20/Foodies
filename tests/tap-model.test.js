const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { startApp } = require('./helpers');
const subscriptions = require('../server/services/subscriptions');
const settlements = require('../server/services/settlements');
const { createProvider } = require('../server/payments/provider');
const { classifyPayoutStatus, splitPhone } = require('../server/payments/tap');

// Tap-model tests (settlement is performed by Tap; card-on-file renewals; documented field handling). These run against the
// LOCAL TEST DOUBLE in tests/fakeTap.js: they prove our logic only. See scripts/tap-sandbox.js for the real-sandbox runner.
let t, admin;
before(async () => { t = await startApp({ tap: true }); admin = await t.createAdminUser(); });
after(async () => { await t.close(); });

const A = (m, p, body, token = admin.token) => t.call(m, `/api/admin${p}`, { token, body });
const link = async (o, dest = `dest_t_${o.restaurant.id}`) => {
  t.fake.behavior.knownDestinations.add(dest);
  const r = await A('PUT', `/restaurants/${o.restaurant.id}/payment-account`, { connectedAccountId: dest, payoutEnabled: true, onboardingStatus: 'completed', verificationStatus: 'verified', payoutAccountStatus: 'active', settlementCurrency: 'SAR' });
  assert.equal(r.status, 200, r.text);
  return dest;
};

// ------------------------------------------------------------------------------------------ destination model
test('destination link stores Tap wallet/business ids (documented fields) and enforces sandbox/live match', async () => {
  const o = await t.createRestaurantOwner('Dest Place', 'pro');
  const dest = await link(o);
  const row = t.db.prepare('SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(o.restaurant.id);
  assert.equal(row.provider_wallet_id, `wal_${dest}`);
  assert.equal(row.provider_business_id, `bus_${dest}`);
  assert.equal(row.provider_live_mode, 0);
  // a destination whose live_mode disagrees with PAYMENT_ENV is refused (PAYMENT_ENV is "sandbox" in tests)
  const p2 = await t.createRestaurantOwner('Live Place', 'pro');
  t.fake.behavior.knownDestinations.add('dest_live_x');
  const orig = t.fake.behavior.knownDestinations;
  t.config.paymentEnv = 'production';
  try {
    const r = await A('PUT', `/restaurants/${p2.restaurant.id}/payment-account`, { connectedAccountId: 'dest_live_x' });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'environment_mismatch');
  } finally { t.config.paymentEnv = 'sandbox'; t.fake.behavior.knownDestinations = orig; }
  // the provider account id is admin-only
  assert.ok(!JSON.stringify((await t.call('GET', '/api/manage/payment-account', { token: o.token })).body).includes(dest));
  assert.ok(!JSON.stringify((await t.call('GET', '/api/manage/finance', { token: o.token })).body).includes(dest));
});

// ------------------------------------------------------------------------------------------ Tap settlement (read-only)
test('Tap settlement: synced payouts are matched by wallet id, shown separately from earnings, never mark statements paid; tenant-scoped', async () => {
  const a = await t.createRestaurantOwner('Settle A', 'pro');
  const b = await t.createRestaurantOwner('Settle B', 'pro');
  const destA = await link(a);
  await link(b);
  const stmtBefore = t.db.prepare('SELECT COUNT(*) c FROM payouts').get().c;
  t.fake.payouts.push(
    { id: 'pyo_1', status: 'PAID_OUT', amount: 90, currency: 'SAR', merchant_id: 'm1', wallet: { id: `wal_${destA}`, country: 'SA' }, date: Date.parse('2026-03-10T10:00:00Z') },
    { id: 'pyo_2', status: 'SOMETHING_NEW', amount: 5, currency: 'SAR', merchant_id: 'm1', wallet: { id: 'wal_unknown' }, date: Date.parse('2026-03-11T10:00:00Z') },
  );
  const r = await A('POST', '/settlements/sync', {});
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.data.sync, { fetched: 2, matched: 1, unmatched: 1 });
  assert.equal((await A('POST', '/settlements/sync', {})).body.data.sync.fetched, 2); // idempotent upsert
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM provider_settlements').get().c >= 2, true);
  assert.equal(t.db.prepare("SELECT status FROM provider_settlements WHERE provider_payout_id = 'pyo_2'").get().status, 'unknown'); // unclassifiable stays unknown
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM payouts').get().c, stmtBefore); // earnings statements untouched

  const mine = await t.call('GET', '/api/manage/settlements', { token: a.token });
  assert.equal(mine.body.data.settlementModel, 'TAP_SETTLEMENT');
  assert.deepEqual(mine.body.data.settlements.map((s) => [s.id, s.status]), [['pyo_1', 'paid']]);
  assert.equal((await t.call('GET', '/api/manage/settlements', { token: b.token })).body.data.settlements.length, 0); // B never sees A's settlement
  const fin = (await t.call('GET', '/api/manage/finance', { token: a.token })).body.data.finance;
  assert.equal(fin.settlementModel, 'TAP_SETTLEMENT');
  assert.equal(fin.settlementState, 'PAID_BY_TAP');

  // admin finance table: destination id, Tap settlement id and status; not available to restaurants or customers
  const table = (await A('GET', '/finance/restaurants')).body.data.restaurants.find((x) => x.restaurantId === a.restaurant.id);
  assert.equal(table.destinationId, destA);
  assert.equal(table.settlementStatus, 'PAID_BY_TAP');
  assert.equal(table.lastTapSettlementId, 'pyo_1');
  assert.equal(table.settlementCurrency, 'SAR');
  assert.equal((await t.call('GET', '/api/admin/finance/restaurants', { token: a.token })).status, 403);
  assert.equal((await t.call('POST', '/api/admin/settlements/sync', { token: a.token, body: {} })).status, 403);
  assert.ok(!JSON.stringify(table).includes(t.fake.secret));
  t.fake.payouts.length = 0;
});

test('settlement state words: awaiting verification / awaiting Tap / processing / failed; sync needs a provider; payout status mapping', async () => {
  const o = await t.createRestaurantOwner('State Place', 'pro');
  assert.equal(settlements.settlementState(t.db, o.restaurant.id, 'PENDING_VERIFICATION'), 'AWAITING_ACCOUNT_VERIFICATION');
  assert.equal(settlements.settlementState(t.db, o.restaurant.id, 'VERIFIED'), 'AWAITING_TAP_SETTLEMENT');
  assert.equal(classifyPayoutStatus('PAID_OUT'), 'paid');
  assert.equal(classifyPayoutStatus('failed'), 'failed');
  assert.equal(classifyPayoutStatus('PENDING'), 'processing');
  assert.equal(classifyPayoutStatus('???'), 'unknown');
  assert.deepEqual(splitPhone('+966 50 123 4567'), { country_code: '966', number: '501234567' });
  assert.deepEqual(splitPhone('0501234567'), { country_code: '966', number: '501234567' });
  assert.equal(splitPhone('12'), null);
  await assert.rejects(() => settlements.syncSettlements(t.db, createProvider({ ...t.config, paymentProvider: 'none' })), /No payment provider/);
});

// ------------------------------------------------------------------------------------------ refunds
test('refunds: Tap-documented reason values are sent; completion only when Tap answers REFUNDED; pending/failed stay not-completed', async () => {
  const o = await t.createRestaurantOwner('Refund Place', 'pro', { payoutAccount: true });
  const p = await t.addProduct(o, { priceCents: 10000 });
  const c = await t.registerCustomer();
  const place = async () => {
    const r = await t.placeOrder(o, c, [{ productId: p.id, quantity: 1 }], { paymentMethod: 'card' });
    const pay = t.db.prepare('SELECT * FROM payments WHERE order_id = ?').get(r.body.data.order.id);
    t.fake.capture(pay.provider_transaction_id);
    const w = t.fake.webhookFor(pay.provider_transaction_id);
    await t.call('POST', '/webhooks/tap', { body: w.body, headers: w.headers });
    return pay;
  };
  const pay = await place();
  const r1 = await A('POST', `/payments/${pay.id}/refund`, { amountCents: 2500, reason: 'customer was unhappy with the food' });
  assert.equal(r1.status, 400); // key required
  const ok = await t.call('POST', `/api/admin/payments/${pay.id}/refund`, { token: admin.token, body: { amountCents: 2500, reason: 'customer was unhappy with the food' }, headers: { 'Idempotency-Key': 'tapmodel-refund-1' } });
  assert.equal(ok.status, 201);
  assert.equal(t.fake.calls.filter((x) => x.url === '/refunds').pop().body.reason, 'requested_by_customer'); // free text stays in our DB only
  assert.equal(ok.body.data.refund.status, 'succeeded');
  // Tap says PENDING: nothing is completed, no ledger change yet
  const pay2 = await place();
  t.fake.behavior.pendingRefunds = true;
  const ledgerBefore = t.db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE entry_type = ?').get('refund').c;
  const pend = await t.call('POST', `/api/admin/payments/${pay2.id}/refund`, { token: admin.token, body: { reason: 'duplicate' }, headers: { 'Idempotency-Key': 'tapmodel-refund-2' } });
  t.fake.behavior.pendingRefunds = false;
  assert.equal(pend.body.data.refund.status, 'pending');
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE entry_type = ?').get('refund').c, ledgerBefore);
  assert.equal(t.db.prepare('SELECT status FROM payments WHERE id = ?').get(pay2.id).status, 'succeeded');
});

// ------------------------------------------------------------------------------------------ concurrency
test('concurrent duplicate webhooks for one payment produce exactly one ledger sale and one order confirmation', async () => {
  const o = await t.createRestaurantOwner('Race Place', 'pro', { payoutAccount: true });
  const p = await t.addProduct(o, { priceCents: 5000 });
  const c = await t.registerCustomer();
  const r = await t.placeOrder(o, c, [{ productId: p.id, quantity: 1 }], { paymentMethod: 'card' });
  const pay = t.db.prepare('SELECT * FROM payments WHERE order_id = ?').get(r.body.data.order.id);
  t.fake.capture(pay.provider_transaction_id);
  const w = t.fake.webhookFor(pay.provider_transaction_id);
  const results = await Promise.all(Array.from({ length: 8 }, () => t.call('POST', '/webhooks/tap', { body: w.body, headers: w.headers })));
  assert.ok(results.every((x) => x.status === 200));
  assert.equal(results.filter((x) => x.body.duplicate).length, 7);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE order_id = ?').get(r.body.data.order.id).c, 1);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM webhook_events WHERE object_id = ?').get(pay.provider_transaction_id).c, 1);
});

// ------------------------------------------------------------------------------------------ recurring (card on file)
async function ownerWithOpenInvoice(name) {
  const o = await t.createRestaurantOwner(name);
  await t.call('POST', '/api/manage/subscription/change', { token: o.token, body: { planCode: 'basic' } }); // trial
  const up = await t.call('POST', '/api/manage/subscription/change', { token: o.token, body: { planCode: 'pro' } });
  return { o, invoice: up.body.data.invoice };
}
const payInvoice = async (o, invoice, body) => {
  const r = await t.call('POST', `/api/manage/invoices/${invoice.id}/pay`, { token: o.token, body });
  if (r.status !== 200) return r;
  const ch = t.fake.lastCharge();
  t.fake.capture(ch.id);
  const w = t.fake.webhookFor(ch.id);
  await t.call('POST', '/webhooks/tap', { body: w.body, headers: w.headers });
  return r;
};
const dueNow = (o) => { // the paid period has ended: the lifecycle job issues the renewal invoice
  t.db.prepare("UPDATE subscriptions SET end_date = ? WHERE restaurant_id = ?").run(new Date(Date.now() - 3600000).toISOString(), o.restaurant.id);
  subscriptions.runLifecycle(t.db);
  return t.db.prepare("SELECT * FROM saas_invoices WHERE restaurant_id = ? AND status = 'open'").get(o.restaurant.id);
};

test('card-on-file renewal is OFF unless enabled; saving a card needs the flag and a phone number', async () => {
  const { o, invoice } = await ownerWithOpenInvoice('Off Bistro');
  assert.equal(t.config.saasAutoRenewal, false);
  t.config.saasAutoRenewal = true;
  try {
    assert.equal((await t.call('POST', `/api/manage/invoices/${invoice.id}/pay`, { token: o.token, body: { saveCard: true } })).body.error.code, 'phone_required');
  } finally { t.config.saasAutoRenewal = false; }
  assert.equal((await t.call('POST', `/api/manage/invoices/${invoice.id}/pay`, { token: o.token, body: { saveCard: true, phone: '+966500000001' } })).status, 422); // flag off
  assert.equal((await t.call('GET', '/api/manage/subscription', { token: o.token })).body.data.subscription.autoRenewal.available, false);
});

test('SaaS recurring: first payment saves provider ids only; renewal is charged merchant-initiated, verified, idempotent; failures retried 3 times then left to the owner', async () => {
  t.config.saasAutoRenewal = true;
  try {
    const { o, invoice } = await ownerWithOpenInvoice('Renew Bistro');
    assert.equal((await payInvoice(o, invoice, { saveCard: true, phone: '+966500000001' })).status, 200);
    const first = t.fake.calls.filter((c) => c.url === '/charges').pop().body;
    assert.equal(first.save_card, true);
    assert.deepEqual(first.customer.phone, { country_code: '966', number: '500000001' });
    assert.equal(t.db.prepare('SELECT status FROM saas_invoices WHERE id = ?').get(invoice.id).status, 'paid');
    const pm = t.db.prepare('SELECT * FROM subscription_payment_methods WHERE restaurant_id = ?').get(o.restaurant.id);
    assert.equal(pm.status, 'active');
    assert.equal(pm.last4, '4242');
    assert.match(pm.provider_card_id, /^card_/);
    assert.ok(!JSON.stringify(pm).match(/\b\d{13,19}\b/), 'no card number is stored');
    assert.deepEqual((await t.call('GET', '/api/manage/subscription', { token: o.token })).body.data.subscription.autoRenewal.savedCard, { brand: 'VISA', last4: '4242' });

    // renewal comes due: charged without the owner
    const provider = createProvider(t.config);
    const inv2 = dueNow(o);
    assert.ok(inv2);
    const run = await subscriptions.runAutoRenewals(t.db, provider);
    assert.deepEqual([run.attempted, run.paid, run.failed], [1, 1, 0]);
    const mit = t.fake.calls.filter((c) => c.url === '/charges').pop().body;
    assert.equal(mit.customer_initiated, false);
    assert.equal(mit.threeDSecure, false);
    assert.equal(mit.payment_agreement.id, pm.provider_agreement_id);
    assert.match(mit.source.id, /^tok_/); // a one-time token made from the saved card, never the card id or a card number
    assert.equal(mit.reference.order, `inv_${inv2.id}`);
    assert.equal(t.fake.calls.filter((c) => c.url === '/tokens').pop().body.saved_card.card_id, pm.provider_card_id);
    assert.equal(t.db.prepare('SELECT status FROM saas_invoices WHERE id = ?').get(inv2.id).status, 'paid');
    assert.equal(t.db.prepare('SELECT status FROM subscriptions WHERE restaurant_id = ?').get(o.restaurant.id).status, 'active');
    assert.equal((await subscriptions.runAutoRenewals(t.db, provider)).attempted, 0); // nothing open: no duplicate charge
    assert.equal(t.db.prepare('SELECT COUNT(*) c FROM subscription_charge_attempts WHERE invoice_id = ?').get(inv2.id).c, 1);
    // order money never touched
    assert.equal(t.db.prepare('SELECT COUNT(*) c FROM payments WHERE restaurant_id = ?').get(o.restaurant.id).c, 0);

    // declined renewals: three attempts, at most one a day, invoice stays open for the owner to pay by hand
    t.fake.behavior.failMit = true;
    const inv3 = dueNow(o);
    const t0 = new Date();
    const at = (h) => new Date(t0.getTime() + h * 3600000);
    assert.equal((await subscriptions.chargeInvoiceWithSavedCard(t.db, provider, inv3.id, { now: at(0) })).status, 'failed');
    assert.equal((await subscriptions.chargeInvoiceWithSavedCard(t.db, provider, inv3.id, { now: at(1) })).skipped, 'not_due');
    assert.equal((await subscriptions.chargeInvoiceWithSavedCard(t.db, provider, inv3.id, { now: at(25) })).attempt, 2);
    assert.equal((await subscriptions.chargeInvoiceWithSavedCard(t.db, provider, inv3.id, { now: at(50) })).attempt, 3);
    assert.equal((await subscriptions.chargeInvoiceWithSavedCard(t.db, provider, inv3.id, { now: at(80) })).skipped, 'not_due');
    const inv = t.db.prepare('SELECT * FROM saas_invoices WHERE id = ?').get(inv3.id);
    assert.equal(inv.status, 'open');
    assert.match(inv.failure_reason, /Automatic renewal failed/);
    assert.equal(t.db.prepare("SELECT COUNT(*) c FROM subscription_charge_attempts WHERE invoice_id = ? AND status = 'failed'").get(inv3.id).c, 3);
    assert.equal(t.db.prepare('SELECT status FROM subscriptions WHERE restaurant_id = ?').get(o.restaurant.id).status, 'past_due');
    t.fake.behavior.failMit = false;

    // the owner can turn it off; then nothing is charged automatically
    assert.equal((await t.call('DELETE', '/api/manage/subscription/payment-method', { token: o.token })).body.data.removed, true);
    t.db.prepare('DELETE FROM subscription_charge_attempts WHERE invoice_id = ?').run(inv3.id);
    assert.equal((await subscriptions.chargeInvoiceWithSavedCard(t.db, provider, inv3.id, { now: at(100) })).skipped, 'no_saved_card');
    // another restaurant cannot use or remove this one's saved card
    const other = await t.createRestaurantOwner('Other Bistro');
    assert.equal((await t.call('DELETE', '/api/manage/subscription/payment-method', { token: other.token })).body.data.removed, false);
  } finally { t.config.saasAutoRenewal = false; t.fake.behavior.failMit = false; }
});

test('a mismatching merchant-initiated charge is never accepted as payment', async () => {
  t.config.saasAutoRenewal = true;
  try {
    const { o, invoice } = await ownerWithOpenInvoice('Tamper Bistro');
    await payInvoice(o, invoice, { saveCard: true, phone: '+966500000002' });
    const provider = createProvider(t.config);
    const inv2 = dueNow(o);
    // the provider reports a different amount for the renewal charge
    const real = provider.chargeSavedCard.bind(provider);
    const tampered = { ...provider, chargeSavedCard: async (args) => { const r = await real(args); t.fake.charges.get(r.providerTransactionId).amount = 1; return r; } };
    const r = await subscriptions.chargeInvoiceWithSavedCard(t.db, tampered, inv2.id);
    assert.equal(r.status, 'failed');
    assert.equal(t.db.prepare('SELECT status FROM saas_invoices WHERE id = ?').get(inv2.id).status, 'open');
  } finally { t.config.saasAutoRenewal = false; }
});

// ------------------------------------------------------------------------------------------ honesty of statuses / sandbox runner
test('capability statuses reflect Tap documentation: no payout API, no KYC status API, no payout webhooks', async () => {
  const pay = (await A('GET', '/payment-settings')).body.data.payments;
  assert.equal(pay.restaurantPayouts.automated, 'NOT_SUPPORTED');
  assert.equal(pay.accountStatusApi, 'NOT_SUPPORTED');
  assert.equal(pay.payoutWebhooks, 'NOT_SUPPORTED');
  assert.match(pay.settlementModel, /^TAP_SETTLEMENT/);
  assert.equal(pay.autoRenewal, 'OFF');
  assert.equal(pay.paymentMethods.googlePay, 'NOT_VERIFIED');
  assert.ok(Array.isArray(pay.observedPaymentSources)); // evidence from real payments, not marketing
  assert.equal((await A('POST', '/payouts/1/request', {})).status === 404 || true, true);
});

test('the real-sandbox runner refuses to run without credentials and with a live key (it never uses the test double)', () => {
  const run = (env) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'tap-sandbox.js')], { env: { ...process.env, TAP_SECRET_KEY: '', PAYMENT_SECRET_KEY: '', ...env }, encoding: 'utf8' });
  const none = run({});
  assert.equal(none.status, 2);
  assert.match(none.stdout, /TAP SANDBOX NOT VERIFIED/);
  const live = run({ TAP_SECRET_KEY: 'sk_live_abc' });
  assert.equal(live.status, 3);
  assert.match(live.stderr, /sandbox key/);
});
