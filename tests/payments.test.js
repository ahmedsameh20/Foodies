const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const payments = require('../server/services/payments');

// These tests run the REAL Tap adapter against a local test double of Tap's documented API (tests/fakeTap.js).
// They prove our integration logic; they do not prove anything about a live Tap account.
let t;
before(async () => { t = await startApp({ tap: true }); });
after(async () => { await t.close(); });

async function setup({ commissionBp = null, price = 10000, payoutAccount = true } = {}) {
  const o = await t.createRestaurantOwner('Pay Place', 'pro', { payoutAccount });
  if (commissionBp !== null) t.db.prepare('UPDATE restaurants SET commission_bp_override = ? WHERE id = ?').run(commissionBp, o.restaurant.id);
  const p = await t.addProduct(o, { priceCents: price });
  const c = await t.registerCustomer();
  return { o, p, c };
}
const card = (s, extra = {}, headers = {}) => t.placeOrder(s.o, s.c, [{ productId: s.p.id, quantity: 1 }], { paymentMethod: 'card', ...extra }, headers);
const payRow = (orderId) => t.db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);
const orderRow = (id) => t.db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const sendWebhook = (chargeId, status) => {
  const w = t.fake.webhookFor(chargeId, status);
  return t.call('POST', '/webhooks/tap', { body: w.body, headers: w.headers });
};

test('card checkout: hosted payment URL, order hidden from the restaurant until the provider confirms', async () => {
  const s = await setup();
  const r = await card(s);
  assert.equal(r.status, 201);
  assert.match(r.body.data.paymentUrl, /^https:\/\/checkout\.fake-tap\.test\/chg_/);
  assert.equal(r.body.data.order.status, 'awaiting_payment');
  const chargeId = payRow(r.body.data.order.id).provider_transaction_id;

  // the adapter sent exactly what Tap's docs describe, and never any card data
  const call = t.fake.calls.find((c) => c.method === 'POST' && c.url === '/charges');
  assert.equal(call.body.amount, 100); // 10000 cents -> 100.00
  assert.equal(call.body.currency, 'SAR');
  assert.equal(call.body.source.id, 'src_all');
  assert.match(call.body.post.url, /\/webhooks\/tap$/);
  assert.ok(call.body.redirect.url.includes(`order.html?id=${r.body.data.order.id}`));
  assert.ok(!JSON.stringify(call.body).match(/card_number|cvv|pan/i));

  // not visible to the restaurant, not payable yet, nothing in the ledger
  assert.equal((await t.call('GET', '/api/manage/orders', { token: s.o.token })).body.data.orders.length, 0);
  assert.equal((await t.call('GET', `/api/manage/orders/${r.body.data.order.id}`, { token: s.o.token })).status, 404);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE order_id = ?').get(r.body.data.order.id).c, 0);
  assert.equal((await t.call('PATCH', `/api/manage/orders/${r.body.data.order.id}/status`, { token: s.o.token, body: { status: 'confirmed' } })).status, 404);

  // the browser claiming "paid" changes nothing: the server asks the provider
  const refresh = await t.call('POST', `/api/me/orders/${r.body.data.order.id}/refresh-payment`, { token: s.c.token, body: { paid: true, status: 'paid' } });
  assert.equal(refresh.body.data.order.status, 'awaiting_payment');
});

test('verified webhook confirms the order, creates the ledger sale; duplicates are harmless', async () => {
  const s = await setup({ commissionBp: 1000 });
  const r = await card(s);
  const id = r.body.data.order.id;
  const chargeId = payRow(id).provider_transaction_id;
  t.fake.capture(chargeId);

  const w1 = await sendWebhook(chargeId);
  assert.equal(w1.status, 200);
  assert.equal(orderRow(id).status, 'pending');
  assert.equal(orderRow(id).payment_status, 'paid');
  assert.equal(payRow(id).status, 'succeeded');
  assert.equal((await t.call('GET', '/api/manage/orders', { token: s.o.token })).body.data.orders.length, 1);

  const sale = t.db.prepare("SELECT * FROM ledger_entries WHERE order_id = ? AND entry_type = 'sale'").get(id);
  assert.equal(sale.gross_amount_cents, 10000);
  assert.equal(sale.platform_commission_cents, 1000); // 10% of the food value
  assert.equal(sale.restaurant_amount_cents, 9000);
  assert.equal(sale.eligible_at, null); // payable only after delivery

  // duplicate delivery of the same event, and a replay of the same signed body
  const w2 = await sendWebhook(chargeId);
  assert.equal(w2.status, 200);
  assert.equal(w2.body.duplicate, true);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE order_id = ?').get(id).c, 1);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM webhook_events WHERE object_id = ?').get(chargeId).c, 1);
  // markPaid called directly again (e.g. return-page refresh racing the webhook) is also a no-op
  assert.equal(payments.markPaid(t.db, payRow(id).id).changed, false);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE order_id = ?').get(id).c, 1);
});

test('forged / unsigned / tampered webhooks are rejected and change nothing', async () => {
  const s = await setup();
  const r = await card(s);
  const id = r.body.data.order.id;
  const chargeId = payRow(id).provider_transaction_id;
  t.fake.capture(chargeId);
  const good = t.fake.webhookFor(chargeId);

  const noSig = await t.call('POST', '/webhooks/tap', { body: good.body });
  assert.equal(noSig.status, 401);
  const badSig = await t.call('POST', '/webhooks/tap', { body: good.body, headers: { hashstring: 'a'.repeat(64) } });
  assert.equal(badSig.status, 401);
  const tampered = await t.call('POST', '/webhooks/tap', { body: { ...good.body, amount: 0.01 }, headers: good.headers });
  assert.equal(tampered.status, 401);
  const wrongProvider = await t.call('POST', '/webhooks/stripe', { body: good.body, headers: good.headers });
  assert.equal(wrongProvider.status, 404);
  assert.equal(orderRow(id).status, 'awaiting_payment');
  assert.equal(payRow(id).status, 'pending');
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM webhook_events WHERE object_id = ?').get(chargeId).c, 0);
});

test('a correctly signed webhook still cannot confirm a payment the provider reports as unpaid', async () => {
  const s = await setup();
  const r = await card(s);
  const id = r.body.data.order.id;
  const chargeId = payRow(id).provider_transaction_id;
  // webhook CLAIMS captured, but the provider's own record (checked via API) says INITIATED
  const w = t.fake.webhookFor(chargeId);
  w.body.status = 'CAPTURED';
  const crypto = require('node:crypto');
  const msg = `x_id${w.body.id}x_amount${w.body.amount.toFixed(2)}x_currency${w.body.currency}x_gateway_reference${w.body.reference.gateway}x_payment_reference${w.body.reference.payment}x_status${w.body.status}x_created${w.body.transaction.created}`;
  const hashstring = crypto.createHmac('sha256', t.fake.secret).update(msg).digest('hex');
  const res = await t.call('POST', '/webhooks/tap', { body: w.body, headers: { hashstring } });
  assert.equal(res.status, 200);
  assert.equal(orderRow(id).status, 'awaiting_payment');
  assert.equal(payRow(id).status, 'pending');
});

test('amount / reference mismatch between provider and our records is never accepted', async () => {
  const s = await setup();
  const r = await card(s);
  const id = r.body.data.order.id;
  const chargeId = payRow(id).provider_transaction_id;
  t.fake.capture(chargeId);
  t.fake.charges.get(chargeId).amount = 1.0; // provider says only $1.00 was captured
  const res = await sendWebhook(chargeId);
  assert.equal(res.status, 200);
  assert.equal(orderRow(id).status, 'awaiting_payment');
  assert.equal(t.db.prepare('SELECT status FROM webhook_events WHERE object_id = ?').get(chargeId).status, 'failed');
});

test('failed / cancelled payment cancels the awaiting order without any ledger entry', async () => {
  const s = await setup();
  const r = await card(s);
  const id = r.body.data.order.id;
  const chargeId = payRow(id).provider_transaction_id;
  assert.equal((await sendWebhook(chargeId, 'DECLINED')).status, 200);
  assert.equal(orderRow(id).status, 'cancelled');
  assert.equal(orderRow(id).payment_status, 'failed');
  assert.equal(payRow(id).status, 'failed');
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE order_id = ?').get(id).c, 0);
  assert.equal((await t.call('GET', '/api/manage/orders', { token: s.o.token })).body.data.orders.length, 0);
});

test('return-page refresh asks the provider and confirms a payment whose webhook never arrived', async () => {
  const s = await setup();
  const r = await card(s);
  const id = r.body.data.order.id;
  t.fake.capture(payRow(id).provider_transaction_id);
  const refresh = await t.call('POST', `/api/me/orders/${id}/refresh-payment`, { token: s.c.token });
  assert.equal(refresh.body.data.order.status, 'pending');
  assert.equal(payRow(id).status, 'succeeded');
  // and another customer cannot trigger it for this order
  const other = await t.registerCustomer();
  assert.equal((await t.call('POST', `/api/me/orders/${id}/refresh-payment`, { token: other.token })).status, 404);
});

test('unpaid card orders expire; a late payment after expiry is refunded automatically', async () => {
  const s = await setup();
  const r = await card(s);
  const id = r.body.data.order.id;
  t.db.prepare("UPDATE orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);
  const swept = await payments.expireUnpaidOrders(t.db, { ...require('../server/payments/provider').createProvider(t.config) });
  assert.equal(swept.cancelled, 1);
  assert.equal(orderRow(id).status, 'cancelled');
  assert.equal(orderRow(id).cancel_reason, 'payment_expired');

  // customer paid at the very last second; webhook arrives after cancellation
  t.fake.capture(payRow(id).provider_transaction_id);
  const w = await sendWebhook(payRow(id).provider_transaction_id);
  assert.equal(w.status, 200);
  assert.equal(payRow(id).status, 'refunded');
  assert.equal(payRow(id).refunded_cents, payRow(id).amount_cents);
  const net = t.db.prepare('SELECT COALESCE(SUM(restaurant_amount_cents),0) s FROM ledger_entries WHERE order_id = ?').get(id).s;
  assert.equal(net, 0);

  // an order that the provider says is still pending at expiry time is simply cancelled
  const r2 = await card(s);
  t.db.prepare("UPDATE orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(r2.body.data.order.id);
  const again = await payments.expireUnpaidOrders(t.db, require('../server/payments/provider').createProvider(t.config));
  assert.equal(again.cancelled, 1);
});

test('provider outage at checkout cancels the order cleanly and tells the customer; no money state is created', async () => {
  const s = await setup();
  t.fake.behavior.failCharges = true;
  try {
    const r = await card(s);
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, 'payment_provider_error');
    const o = t.db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC').get(s.c.user.id);
    assert.equal(o.status, 'cancelled');
    assert.equal(payRow(o.id).status, 'failed');
    assert.equal(t.db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE order_id = ?').get(o.id).c, 0);
  } finally { t.fake.behavior.failCharges = false; }
});

test('card is unavailable (cash still works) when the restaurant has no verified payout account', async () => {
  const s = await setup({ payoutAccount: false });
  const r = await card(s);
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'card_unavailable');
  const cod = await t.placeOrder(s.o, s.c, [{ productId: s.p.id, quantity: 1 }], {});
  assert.equal(cod.status, 201);
  const pub = await t.call('GET', `/api/public/restaurants/${s.o.restaurant.slug}`);
  assert.deepEqual(pub.body.data.restaurant.paymentMethods, { card: false, cod: true });
});

test('checkout is idempotent: the same Idempotency-Key never creates a second order or charge', async () => {
  const s = await setup();
  const key = 'idem-key-abcdef-1234';
  const before = t.fake.calls.filter((c) => c.url === '/charges').length;
  const [a, b] = await Promise.all([card(s, {}, { 'Idempotency-Key': key }), card(s, {}, { 'Idempotency-Key': key })]);
  const winners = [a, b].filter((r) => r.status === 201);
  assert.equal(winners.length, 1);
  assert.equal([a, b].filter((r) => r.status === 409).length, 1); // the concurrent duplicate is refused
  const again = await card(s, {}, { 'Idempotency-Key': key });
  assert.equal(again.status, 201);
  assert.equal(again.headers.get('idempotent-replay'), 'true');
  assert.equal(again.body.data.order.id, winners[0].body.data.order.id);
  assert.equal(again.body.data.paymentUrl, winners[0].body.data.paymentUrl);
  assert.equal(t.fake.calls.filter((c) => c.url === '/charges').length - before, 1);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM orders WHERE customer_id = ?').get(s.c.user.id).c, 1);
  // same key, different cart -> rejected
  const conflict = await t.placeOrder(s.o, s.c, [{ productId: s.p.id, quantity: 3 }], { paymentMethod: 'card' }, { 'Idempotency-Key': key });
  assert.equal(conflict.status, 422);
  assert.equal(conflict.body.error.code, 'idempotency_conflict');
  assert.equal((await card(s, {}, { 'Idempotency-Key': 'bad key!' })).status, 400);
});

test('destination split: the restaurant share is routed to its connected account, commission stays with the platform', async () => {
  const s = await setup({ commissionBp: 2000, price: 5000 });
  t.config.paymentFeeBorneBy = 'platform';
  await card(s);
  const call = t.fake.calls.filter((c) => c.method === 'POST' && c.url === '/charges').pop();
  assert.equal(call.body.amount, 50);
  assert.deepEqual(call.body.destinations.destination, [{ id: `dest_${s.o.restaurant.id}`, amount: 40, currency: 'SAR' }]); // 80% of 50.00
});

test('commission math is exact in integer cents, including rounding and the platform service fee', async () => {
  const { computeOrderTotals, mulDiv, toDecimalString, fromDecimalString, proportionalShare } = require('../server/services/money');
  const x = computeOrderTotals({ subtotalCents: 3333, taxRateBp: 1500, deliveryFeeCents: 250, serviceFee: { bp: 300, fixedCents: 50 }, commissionBp: 1250 });
  assert.equal(x.taxCents, 500); // 3333 * 15% = 499.95 -> 500
  assert.equal(x.platformFeeCents, 100 + 50); // 99.99 -> 100, + 50
  assert.equal(x.commissionCents, 417); // 416.625 -> 417
  assert.equal(x.totalCents, 3333 + 500 + 250 + 150);
  assert.equal(x.restaurantAmountCents, x.totalCents - 417 - 150);
  assert.equal(mulDiv(1, 1, 2), 1); // half rounds up
  assert.equal(toDecimalString(1999), '19.99');
  assert.equal(toDecimalString(5), '0.05');
  assert.equal(fromDecimalString('19.9'), 1990);
  assert.equal(fromDecimalString('1e3'), null);
  // refunds in three parts add up exactly to the whole
  let before = 0; let total = 0;
  for (const part of [3333, 3333, 3334]) { total += proportionalShare(417, 10000, before, before + part); before += part; }
  assert.equal(total, 417);
});
