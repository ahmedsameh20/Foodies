// Restaurant-managed coupon codes: management API, tenancy, server-side pricing and scopes, limits (total and per customer), concurrency,
// the redemption lifecycle (cancel, failed payment, duplicate webhooks, delivery), history and reporting.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const coupons = require('../server/services/coupons');
const payments = require('../server/services/payments');

let t;
before(async () => { t = await startApp({ tap: true }); });
after(async () => { await t.close(); });

const make = (o, body) => t.call('POST', '/api/manage/coupons', { token: o.token, body: { nameAr: 'كوبون', nameEn: 'Coupon', code: t.unique('CP').toUpperCase(), kind: 'percent', percent: 20, scope: 'order', ...body } });
const must = async (o, body) => { const r = await make(o, body); assert.equal(r.status, 201, r.text); return r.body.data.coupon; };
const quote = (o, c, items, extra = {}) => t.call('POST', `/api/public/restaurants/${o.restaurant.slug}/quote`, { token: c.token, body: { items, orderType: 'pickup', ...extra } });
const line = (d, quantity = 1) => ({ productId: d.id, quantity });
const place = (o, c, items, couponCode, extra = {}) => t.placeOrder(o, c, items, { couponCode, ...extra });
const live = (id) => t.db.prepare("SELECT COUNT(*) c FROM coupon_redemptions WHERE coupon_id = ? AND status != 'released'").get(id).c;
const usedCount = (id) => t.db.prepare('SELECT used_count u FROM coupons WHERE id = ?').get(id).u;
const seller = async (planCode = 'pro') => { const o = await t.createRestaurantOwner('Coupon Place', planCode, { payoutAccount: true }); return o; };

test('owner creates percentage and fixed coupons; codes are normalised and unique per restaurant', async () => {
  const o = await seller();
  const pct = await must(o, { code: '  welcome15 ', percent: 15, maxDiscountCents: 3000, minSubtotalCents: 10000, nameEn: 'Welcome' });
  assert.equal(pct.code, 'WELCOME15');
  assert.deepEqual([pct.kind, pct.percent, pct.maxDiscountCents, pct.minSubtotalCents, pct.maxUsesPerCustomer, pct.status, pct.usageLimit], ['percent', 15, 3000, 10000, 1, 'active', null]);
  const fixed = await must(o, { code: 'five-off', kind: 'fixed', amountCents: 500, maxDiscountCents: 99 });
  assert.deepEqual([fixed.code, fixed.kind, fixed.amountCents, fixed.maxDiscountCents], ['FIVE-OFF', 'fixed', 500, null]); // a cap only exists for percentages

  assert.equal((await make(o, { code: 'Welcome15' })).status, 409); // same code, other case
  const rival = await seller();
  assert.equal((await make(rival, { code: 'welcome15' })).status, 201); // another restaurant may use the same word

  const gen = (await t.call('GET', '/api/manage/coupons/generate-code', { token: o.token })).body.data.code;
  assert.match(gen, /^[A-Z2-9]{8}$/);

  for (const bad of [{ code: 'ab' }, { code: 'has space!' }, { code: 'x'.repeat(40) }, { percent: 0 }, { percent: 95 }, { scope: 'weird' }, { scope: 'category' }, { scope: 'product', productIds: [] },
    { kind: 'fixed', amountCents: 5000, minSubtotalCents: 1000 }, { maxUsesPerCustomer: 0 }, { startsAt: '2030-01-02T00:00:00Z', endsAt: '2030-01-01T00:00:00Z' }]) {
    assert.equal((await make(o, { code: t.unique('BAD').toUpperCase(), ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await make(o, { nameAr: undefined, nameEn: undefined })).status, 400);
});

test('only the owner of the restaurant manages its coupons; customers, staff and other restaurants are locked out', async () => {
  const o = await seller();
  const c = await must(o, {});
  const customer = await t.registerCustomer();
  const rival = await seller();
  assert.equal((await t.call('GET', '/api/manage/coupons', { token: customer.token })).status, 403);
  assert.equal((await t.call('POST', '/api/manage/coupons', { token: customer.token, body: { code: 'HACK' } })).status, 403);
  assert.equal((await t.call('GET', '/api/manage/coupons')).status, 401);
  assert.deepEqual((await t.call('GET', '/api/manage/coupons', { token: rival.token })).body.data.coupons, []);
  for (const [m, p, body] of [['GET', `/${c.id}`], ['PUT', `/${c.id}`, { percent: 90 }], ['DELETE', `/${c.id}`]]) {
    assert.equal((await t.call(m, `/api/manage/coupons${p}`, { token: rival.token, body })).status, 404, `${m} ${p}`);
  }
  // a coupon can not point at another restaurant's dish or category
  const theirs = await t.addProduct(rival);
  assert.equal((await make(o, { scope: 'product', productIds: [theirs.id] })).status, 400);
  const cat = (await t.call('POST', '/api/manage/categories', { token: rival.token, body: { nameAr: 'ع', nameEn: t.unique('Cat') } })).body.data.category;
  assert.equal((await make(o, { scope: 'category', categoryId: cat.id })).status, 400);
  // staff of the restaurant manage orders only
  const staff = await t.call('POST', '/api/manage/staff', { token: o.token, body: { name: 'Sam Staff', email: `${t.unique('st')}@t.test`, password: 'Passw0rd!' } });
  const login = await t.call('POST', '/api/auth/login', { body: { email: staff.body.data.staff.email, password: 'Passw0rd!' } });
  assert.equal((await t.call('GET', '/api/manage/coupons', { token: login.body.data.token })).status, 403);
});

test('a valid coupon is priced by the server: percentage with cap and minimum, fixed amount, the client price is ignored', async () => {
  const o = await seller();
  const d = await t.addProduct(o, { priceCents: 10000 });
  const c = await t.registerCustomer();
  const pct = await must(o, { code: 'AHMED20', percent: 20, minSubtotalCents: 5000, maxDiscountCents: 1500 });

  const q = await quote(o, c, [line(d)], { couponCode: ' ahmed20 ', discountCents: 9999, totalCents: 1 });
  assert.equal(q.status, 200, q.text);
  assert.deepEqual([q.body.data.quote.subtotalCents, q.body.data.quote.couponDiscountCents, q.body.data.quote.totalCents, q.body.data.quote.coupon.code], [10000, 1500, 8500, 'AHMED20']); // 20% = 2000, capped at 1500
  const small = await t.addProduct(o, { priceCents: 6000 });
  assert.equal((await quote(o, c, [line(small)], { couponCode: 'AHMED20' })).body.data.quote.couponDiscountCents, 1200); // below the cap
  const tiny = await t.addProduct(o, { priceCents: 4000 });
  const low = await quote(o, c, [line(tiny)], { couponCode: 'AHMED20' });
  assert.equal(low.status, 422);
  assert.equal(low.body.error.code, 'coupon_min_subtotal');
  assert.equal(low.body.error.details.minAmount, '50.00');
  assert.equal((await quote(o, c, [line(tiny, 2)], { couponCode: 'AHMED20' })).body.data.quote.couponDiscountCents, 1500); // 2 x 4000 = 8000 -> 1600, capped to 1500

  // placing the order stores exactly that, and totals stay consistent with tax / delivery / commission
  t.db.prepare('UPDATE restaurants SET tax_rate_bp = 1500, delivery_fee_cents = 1000 WHERE id = ?').run(o.restaurant.id);
  const qd = (await quote(o, c, [line(d)], { couponCode: 'AHMED20', orderType: 'delivery' })).body.data.quote;
  assert.deepEqual([qd.taxCents, qd.deliveryFeeCents, qd.totalCents], [1275, 1000, 8500 + 1275 + 1000]); // tax on the discounted 8500
  const placed = await place(o, c, [line(d)], 'AHMED20', { orderType: 'delivery', deliveryAddress: '12 Test Street', discountCents: 9999 });
  assert.equal(placed.status, 201, placed.text);
  const order = placed.body.data.order;
  assert.deepEqual([order.subtotalCents, order.discountCents, order.couponCode, order.couponDiscountCents, order.totalCents], [10000, 1500, 'AHMED20', 1500, qd.totalCents]);
  const row = t.db.prepare('SELECT commission_cents, restaurant_amount_cents, total_cents, tax_cents FROM orders WHERE id = ?').get(order.id);
  assert.equal(row.tax_cents, 1275);
  assert.equal(row.restaurant_amount_cents, row.total_cents - row.commission_cents); // settlement maths unchanged, on the discounted value
  assert.equal(t.db.prepare('SELECT amount_cents FROM payments WHERE order_id = ?').get(order.id).amount_cents, order.totalCents);
  // history for the customer and the restaurant
  assert.equal((await t.call('GET', `/api/me/orders/${order.id}`, { token: c.token })).body.data.order.couponCode, 'AHMED20');
  assert.equal((await t.call('GET', '/api/manage/orders', { token: o.token })).body.data.orders.find((x) => x.id === order.id).couponDiscountCents, 1500);

  // fixed amounts never exceed what they apply to and never leave a zero total
  const fixed = await must(o, { code: 'BIG', kind: 'fixed', amountCents: 5000, maxUsesPerCustomer: null });
  const cheap = await t.addProduct(o, { priceCents: 300 });
  assert.equal((await quote(o, c, [line(cheap)], { couponCode: 'BIG' })).body.data.quote.couponDiscountCents, 299);
  assert.equal(fixed.amountCents, 5000);
});

test('invalid, unknown, disabled, expired, scheduled and other restaurants\' coupons are rejected', async () => {
  const o = await seller();
  const d = await t.addProduct(o, { priceCents: 1000 });
  const c = await t.registerCustomer();
  const day = 86400000;
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  await must(o, { code: 'OFF1', isActive: false });
  await must(o, { code: 'OLD1', startsAt: iso(-3 * day), endsAt: iso(-day) });
  await must(o, { code: 'SOON1', startsAt: iso(day), endsAt: iso(3 * day) });
  const rival = await seller();
  await must(rival, { code: 'THEIRS1' });
  const codes = await Promise.all(['OFF1', 'OLD1', 'SOON1', 'THEIRS1', 'NOPE', '!!', ''].map(async (code) => (await quote(o, c, [line(d)], { couponCode: code || undefined })).status));
  assert.deepEqual(codes, [422, 422, 422, 422, 422, 422, 200]); // the empty code is simply "no coupon"
  const r = await quote(o, c, [line(d)], { couponCode: 'THEIRS1' });
  assert.equal(r.body.error.code, 'coupon_invalid');
  assert.equal(r.body.error.message, 'This coupon is invalid or has expired.');
  assert.equal((await place(o, c, [line(d)], 'OFF1')).status, 422); // placing the order checks again
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM orders WHERE restaurant_id = ?').get(o.restaurant.id).c, 0);
  assert.equal((await t.call('POST', `/api/public/restaurants/${o.restaurant.slug}/quote`, { body: { items: [line(d)], orderType: 'pickup' } })).status, 401);
});

test('scopes: whole order, whole menu, one category, selected dishes; automatic discounts do not stack unless allowed', async () => {
  const o = await seller();
  const cat = (await t.call('POST', '/api/manage/categories', { token: o.token, body: { nameAr: 'ب', nameEn: t.unique('Burgers') } })).body.data.category;
  const burger = await t.addProduct(o, { priceCents: 2000, categoryId: cat.id });
  const pizza = await t.addProduct(o, { priceCents: 3000 });
  const sale = await t.addProduct(o, { priceCents: 1000, discountedPriceCents: 800 }); // its own discounted price
  const extra = (await t.call('POST', '/api/manage/extras', { token: o.token, body: { nameAr: 'ماء', nameEn: 'Water', category: 'drinks', priceCents: 500 } })).body.data.extra;
  const c = await t.registerCustomer();
  const cart = [line(burger), line(pizza)];
  const off = async (body, items = cart, extras) => {
    const r = await quote(o, c, items, { couponCode: (await must(o, { maxUsesPerCustomer: null, ...body })).code, extras });
    assert.equal(r.status, 200, r.text);
    return r.body.data.quote.couponDiscountCents;
  };
  assert.equal(await off({ scope: 'order', percent: 10 }, cart, [{ extraId: extra.id, quantity: 2 }]), 600); // 10% of 2000+3000+1000
  assert.equal(await off({ scope: 'menu', percent: 10 }, cart, [{ extraId: extra.id, quantity: 2 }]), 500); // dishes only
  assert.equal(await off({ scope: 'category', categoryId: cat.id, percent: 10 }), 200);
  assert.equal(await off({ scope: 'product', productIds: [pizza.id], percent: 10 }), 300);
  // nothing in the cart qualifies
  const none = await must(o, { scope: 'product', productIds: [pizza.id] });
  const r = await quote(o, c, [line(burger)], { couponCode: none.code });
  assert.equal(r.body.error.code, 'coupon_not_applicable');

  // the already-discounted dish is not eligible, unless the coupon explicitly stacks
  const plain = await must(o, { scope: 'menu', percent: 50, maxUsesPerCustomer: null });
  assert.equal((await quote(o, c, [line(sale)], { couponCode: plain.code })).body.error.code, 'coupon_not_applicable');
  assert.equal((await quote(o, c, [line(sale), line(burger)], { couponCode: plain.code })).body.data.quote.couponDiscountCents, 1000);
  const stack = await must(o, { scope: 'menu', percent: 50, allowStacking: true, maxUsesPerCustomer: null });
  const q = (await quote(o, c, [line(sale)], { couponCode: stack.code })).body.data.quote;
  assert.deepEqual([q.couponDiscountCents, q.automaticDiscountCents, q.totalCents], [400, 200, 400]);
});

test('each customer can redeem a single-use coupon once; customers are independent; the total limit is separate; retries do not double count', async () => {
  const o = await seller();
  const d = await t.addProduct(o, { priceCents: 1000 });
  const a = await t.registerCustomer(); const b = await t.registerCustomer(); const c = await t.registerCustomer();
  const cp = await must(o, { code: 'ONCE', usageLimit: 2 }); // 2 in total, 1 per customer
  const total = async (cu) => { const r = await place(o, cu, [line(d)], 'ONCE'); return [r.status, r.body.data?.order?.totalCents ?? r.body.error.code]; };

  assert.deepEqual(await total(a), [201, 800]);
  assert.deepEqual(await total(a), [422, 'coupon_customer_limit']); // A used it
  assert.equal((await quote(o, a, [line(d)], { couponCode: 'ONCE' })).body.error.message, 'You have reached the usage limit for this coupon.');
  assert.deepEqual(await total(b), [201, 800]); // B is independent
  assert.deepEqual(await total(c), [422, 'coupon_exhausted']); // the total of 2 is gone although C never used it
  const row = coupons.describe(t.db, o.restaurant.id).find((x) => x.id === cp.id);
  assert.deepEqual([row.status, row.redemptions, row.uniqueCustomers, row.totalDiscountCents, row.remaining], ['fully_redeemed', 2, 2, 400, 0]);

  // limits are independent: unlimited total with 2 per customer, then no per-customer limit
  const many = await must(o, { code: 'TWICE', maxUsesPerCustomer: 2 });
  const results = [];
  for (let i = 0; i < 3; i++) results.push((await place(o, c, [line(d)], 'TWICE')).status);
  assert.deepEqual(results, [201, 201, 422]);
  const free = await must(o, { code: 'ALWAYS', maxUsesPerCustomer: null });
  assert.equal((await place(o, c, [line(d)], 'ALWAYS')).status, 201);
  assert.equal((await place(o, c, [line(d)], 'ALWAYS')).status, 201);
  assert.ok(many.id && free.id);

  // the same Idempotency-Key is one order and one redemption; the customer is always the signed-in account
  const once2 = await must(o, { code: 'KEYED', maxUsesPerCustomer: 3 });
  const key = { 'Idempotency-Key': t.unique('k') };
  const x = await t.placeOrder(o, a, [line(d)], { couponCode: 'KEYED' }, key);
  const y = await t.placeOrder(o, a, [line(d)], { couponCode: 'KEYED' }, key);
  assert.equal(x.body.data.order.id, y.body.data.order.id);
  assert.equal(live(once2.id), 1);
  const forged = await t.placeOrder(o, b, [line(d)], { couponCode: 'KEYED', customerId: a.user.id });
  assert.equal(t.db.prepare('SELECT customer_id FROM coupon_redemptions WHERE order_id = ?').get(forged.body.data.order.id).customer_id, b.user.id);
});

test('simultaneous checkouts cannot exceed the per-customer or the total limit', async () => {
  const o = await seller();
  const d = await t.addProduct(o, { priceCents: 1000 });
  const one = await must(o, { code: 'RACE1' });
  const c = await t.registerCustomer();
  const burst = await Promise.all(Array.from({ length: 8 }, () => place(o, c, [line(d)], 'RACE1')));
  assert.equal(burst.filter((r) => r.status === 201).length, 1);
  assert.ok(burst.filter((r) => r.status !== 201).every((r) => r.status === 422));
  assert.equal(live(one.id), 1);
  assert.equal(usedCount(one.id), 1);

  const lim = await must(o, { code: 'RACE3', usageLimit: 3 });
  const customers = await Promise.all(Array.from({ length: 7 }, () => t.registerCustomer()));
  const wave = await Promise.all(customers.map((cu) => place(o, cu, [line(d)], 'RACE3')));
  assert.equal(wave.filter((r) => r.status === 201).length, 3);
  assert.equal(live(lim.id), 3);
  assert.equal(usedCount(lim.id), 3);
});

test('redemption lifecycle: cancel, reject, declined / expired card payments and duplicate webhooks give the use back once; delivery keeps it', async () => {
  const o = await seller();
  const d = await t.addProduct(o, { priceCents: 1000 });
  const cp = await must(o, { code: 'LIFE', usageLimit: 5 });
  const c = await t.registerCustomer();
  const status = (id, s) => t.call('PATCH', `/api/manage/orders/${id}/status`, { token: o.token, body: { status: s } });
  const chargeOf = (id) => t.db.prepare('SELECT provider_transaction_id p FROM payments WHERE order_id = ?').get(id).p;
  const hook = (chargeId, st) => { const w = t.fake.webhookFor(chargeId, st); return t.call('POST', '/webhooks/tap', { body: w.body, headers: w.headers }); };

  const first = (await place(o, c, [line(d)], 'LIFE')).body.data.order;
  assert.equal(live(cp.id), 1);
  assert.equal((await t.call('POST', `/api/me/orders/${first.id}/cancel`, { token: c.token })).status, 200);
  assert.equal(live(cp.id), 0);
  assert.equal(coupons.releaseForOrder(t.db, first.id), 0); // a replay changes nothing
  assert.equal(usedCount(cp.id), 0);

  const second = (await place(o, c, [line(d)], 'LIFE')).body.data.order;
  assert.equal((await status(second.id, 'rejected')).status, 200);
  assert.equal(live(cp.id), 0);

  const card = (await place(o, c, [line(d)], 'LIFE', { paymentMethod: 'card' })).body.data.order;
  assert.equal(card.status, 'awaiting_payment');
  assert.equal(live(cp.id), 1); // held while the payment is pending...
  assert.equal((await place(o, c, [line(d)], 'LIFE')).status, 422); // ...so it can not be used twice meanwhile
  const ch = chargeOf(card.id);
  assert.equal((await hook(ch, 'DECLINED')).status, 200);
  assert.equal((await hook(ch, 'DECLINED')).status, 200); // duplicate delivery
  assert.equal(live(cp.id), 0);
  assert.equal(usedCount(cp.id), 0);
  assert.equal(t.db.prepare("SELECT COUNT(*) c FROM coupon_redemptions WHERE order_id = ? AND status = 'released'").get(card.id).c, 1);

  const stale = (await place(o, c, [line(d)], 'LIFE', { paymentMethod: 'card' })).body.data.order;
  t.db.prepare("UPDATE orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(stale.id);
  await payments.expireUnpaidOrders(t.db, require('../server/payments/provider').createProvider(t.config));
  assert.equal(live(cp.id), 0);

  const paid = (await place(o, c, [line(d)], 'LIFE', { paymentMethod: 'card' })).body.data.order;
  t.fake.capture(chargeOf(paid.id));
  await hook(chargeOf(paid.id), 'CAPTURED');
  await hook(chargeOf(paid.id), 'CAPTURED');
  assert.equal(t.db.prepare('SELECT status FROM orders WHERE id = ?').get(paid.id).status, 'pending');
  assert.equal(live(cp.id), 1);
  for (const s of ['confirmed', 'preparing', 'ready', 'delivered']) assert.equal((await status(paid.id, s)).status, 200, s);
  assert.equal(t.db.prepare('SELECT status FROM coupon_redemptions WHERE order_id = ?').get(paid.id).status, 'redeemed');
  assert.equal(live(cp.id), 1);
});

test('editing the cart revalidates the coupon; edits and deletion of a coupon never change past orders; redeemed coupons are disabled, not deleted', async () => {
  const o = await seller();
  const d = await t.addProduct(o, { priceCents: 3000 });
  const c = await t.registerCustomer();
  const cp = await must(o, { code: 'CART', minSubtotalCents: 5000, percent: 10, maxUsesPerCustomer: null });
  assert.equal((await quote(o, c, [line(d, 2)], { couponCode: 'CART' })).body.data.quote.couponDiscountCents, 600);
  assert.equal((await quote(o, c, [line(d, 1)], { couponCode: 'CART' })).body.error.code, 'coupon_min_subtotal'); // the cart shrank
  assert.equal((await quote(o, c, [line(d, 1)])).body.data.quote.couponDiscountCents, 0); // coupon removed

  const order = (await place(o, c, [line(d, 2)], 'CART')).body.data.order;
  assert.equal(order.couponDiscountCents, 600);
  // edit the coupon (new code, bigger discount) and disable it: the order keeps what was granted
  await t.call('PUT', `/api/manage/coupons/${cp.id}`, { token: o.token, body: { code: 'RENAMED', percent: 50, isActive: false } });
  const after = (await t.call('GET', `/api/me/orders/${order.id}`, { token: c.token })).body.data.order;
  assert.deepEqual([after.couponCode, after.couponDiscountCents, after.totalCents], ['CART', 600, order.totalCents]);
  assert.equal((await t.call('GET', `/api/manage/coupons/${cp.id}`, { token: o.token })).body.data.coupon.status, 'disabled');
  assert.equal((await t.call('DELETE', `/api/manage/coupons/${cp.id}`, { token: o.token })).status, 409);
  // an unused coupon can be deleted
  const spare = await must(o, { code: 'SPARE' });
  assert.equal((await t.call('DELETE', `/api/manage/coupons/${spare.id}`, { token: o.token })).status, 200);
  // a category used by a coupon can not silently disappear
  const cat = (await t.call('POST', '/api/manage/categories', { token: o.token, body: { nameAr: 'ف', nameEn: t.unique('Cat') } })).body.data.category;
  await must(o, { scope: 'category', categoryId: cat.id });
  assert.equal((await t.call('DELETE', `/api/manage/categories/${cat.id}`, { token: o.token })).status, 409);
});

test('redemption history, statistics and the owner report show what coupons granted', async () => {
  const o = await seller('pro');
  const d = await t.addProduct(o, { priceCents: 2000 });
  const a = await t.registerCustomer('Alia'); const b = await t.registerCustomer('Bassam');
  const cp = await must(o, { code: 'STATS', usageLimit: 10, percent: 10 });
  await place(o, a, [line(d)], 'STATS');
  await place(o, b, [line(d, 2)], 'STATS');
  const cancelled = (await place(o, (await t.registerCustomer()), [line(d)], 'STATS')).body.data.order;
  const rows = (await t.call('GET', '/api/manage/coupons', { token: o.token })).body.data.coupons;
  const s = rows.find((x) => x.id === cp.id);
  assert.deepEqual([s.redemptions, s.uniqueCustomers, s.totalDiscountCents, s.remaining, s.usageLimit], [3, 3, 800, 7, 10]);
  assert.equal((await t.call('PATCH', `/api/manage/orders/${cancelled.id}/status`, { token: o.token, body: { status: 'rejected' } })).status, 200);
  const detail = (await t.call('GET', `/api/manage/coupons/${cp.id}`, { token: o.token })).body.data;
  assert.deepEqual([detail.coupon.redemptions, detail.coupon.totalDiscountCents, detail.coupon.remaining], [2, 600, 8]);
  assert.equal(detail.redemptions.length, 3);
  assert.deepEqual(detail.redemptions.map((r) => r.status).sort(), ['released', 'reserved', 'reserved']);
  assert.ok(detail.redemptions.every((r) => r.orderNumber && r.discountCents > 0));
  assert.ok(!JSON.stringify(detail).includes('@')); // no customer emails / phones in the history
  const report = (await t.call('GET', '/api/manage/reports/summary?days=30', { token: o.token })).body.data;
  assert.deepEqual([report.couponOrders, report.couponDiscountCents], [2, 600]);
});
