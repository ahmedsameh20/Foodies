// Plans-first onboarding, registration without branches, branch management at scale, per-customer discount limits (with the redemption
// lifecycle) and category pictures.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp } = require('./helpers');
const payments = require('../server/services/payments');
const discounts = require('../server/services/discounts');

let t;
before(async () => { t = await startApp({ tap: true }); });
after(async () => { await t.close(); });

const regOwner = (extra = {}) => t.call('POST', '/api/auth/register-owner', { body: { name: 'Olive Owner', email: `${t.unique('own')}@t.test`, phone: '+966500000000', password: t.PASSWORD, ...extra } });
const planOf = (token) => t.call('GET', '/api/onboarding/plan', { token });
const onboard = (token, body = {}, key) => t.call('POST', '/api/onboarding/restaurant', { token, body: { name: t.unique('Place'), city: 'Riyadh', ...body }, headers: key ? { 'Idempotency-Key': key } : {} });

// ------------------------------------------------------------------------------------------------ plans first
test('plans are public, and a plan chosen before registering is kept on the account and validated by the server', async () => {
  const list = await t.call('GET', '/api/public/plans');
  assert.equal(list.status, 200);
  const dbPlans = t.db.prepare('SELECT code, price_cents FROM plans WHERE is_active = 1').all();
  assert.deepEqual(list.body.data.plans.map((p) => [p.code, p.priceCents]).sort(), dbPlans.map((p) => [p.code, p.price_cents]).sort());

  const r = await regOwner({ planCode: 'pro', priceCents: 1 }); // a client-sent price is ignored: only the code is read
  assert.equal(r.status, 201, r.text);
  const token = r.body.data.token;
  const chosen = await planOf(token);
  assert.equal(chosen.body.data.plan.code, 'pro');
  assert.equal(chosen.body.data.plan.priceCents, 7900);
  assert.equal(chosen.body.data.plans.length, dbPlans.length);

  // an unknown / retired code never blocks registration; the owner simply has to choose again
  const bogus = await regOwner({ planCode: 'nope' });
  assert.equal(bogus.status, 201);
  assert.equal((await planOf(bogus.body.data.token)).body.data.plan, null);

  // changing the plan before the restaurant exists
  assert.equal((await t.call('PUT', '/api/onboarding/plan', { token, body: { planCode: 'basic' } })).body.data.plan.code, 'basic');
  assert.equal((await t.call('PUT', '/api/onboarding/plan', { token, body: { planCode: 'nope' } })).status, 400);
  assert.equal((await planOf(token)).body.data.plan.code, 'basic');

  // customers have no use for it
  const c = await t.registerCustomer();
  assert.equal((await planOf(c.token)).status, 403);
  assert.equal((await t.call('GET', '/api/onboarding/plan')).status, 401);
});

test('the restaurant is created WITHOUT branches, with the retained plan priced by the server; retries never duplicate anything', async () => {
  const r = await regOwner({ planCode: 'basic' });
  const token = r.body.data.token;
  const key = t.unique('reg');
  const sameBody = { name: t.unique('Replay Place'), priceCents: 1 };
  const first = await onboard(token, sameBody, key);
  assert.equal(first.status, 201, first.text);
  const rid = first.body.data.restaurant.id;
  assert.equal(first.body.data.restaurant.branchCount, 0);

  const sub = t.db.prepare('SELECT s.status, s.price_cents, p.code FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.restaurant_id = ?').get(rid);
  assert.deepEqual({ ...sub }, { status: 'trialing', price_cents: 2900, code: 'basic' }); // the server's price and trial, from the retained plan
  assert.equal(t.db.prepare('SELECT pending_plan_code p FROM users WHERE email = ?').get(r.body.data.user.email).p, null);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM branches WHERE restaurant_id = ?').get(rid).c, 0);

  // refresh / retry with the same key returns the same restaurant; without a key a second restaurant is refused
  const replay = await onboard(token, sameBody, key);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.data.restaurant.id, rid);
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
  assert.equal((await onboard(token)).status, 409);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM subscriptions WHERE restaurant_id = ?').get(rid).c, 1);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM restaurants WHERE owner_id = (SELECT id FROM users WHERE email = ?)').get(r.body.data.user.email).c, 1);

  // afterwards the plan is changed from the dashboard, not here
  const after = await planOf(token);
  assert.equal(after.body.data.hasRestaurant, true);
  assert.equal((await t.call('PUT', '/api/onboarding/plan', { token, body: { planCode: 'pro' } })).status, 409);

  // an explicit planCode in the request is validated against the plans table too; the client price is ignored
  const r2 = await regOwner();
  const viaBody = await onboard(r2.body.data.token, { planCode: 'pro', priceCents: 1 });
  assert.equal(t.db.prepare('SELECT price_cents FROM subscriptions WHERE restaurant_id = ?').get(viaBody.body.data.restaurant.id).price_cents, 7900);
  const r3 = await regOwner();
  assert.equal((await onboard(r3.body.data.token, { planCode: 'nope' })).status, 400);
});

test('a paid plan without a trial is not active, and nothing is charged, until the payment is confirmed', async () => {
  t.db.prepare("UPDATE plans SET trial_days = 0 WHERE code = 'basic'").run();
  try {
    const r = await regOwner({ planCode: 'basic' });
    const token = r.body.data.token;
    const rid = (await onboard(token)).body.data.restaurant.id;
    assert.equal(t.db.prepare('SELECT status FROM subscriptions WHERE restaurant_id = ?').get(rid).status, 'expired');
    const sub = (await t.call('GET', '/api/manage/subscription', { token })).body.data;
    assert.equal(sub.subscription.active, false);
    assert.equal(sub.subscription.openInvoice.amountCents, 2900);
    // paying goes through the existing invoice checkout; repeating it never creates a second open invoice
    const pay = await t.call('POST', `/api/manage/invoices/${sub.subscription.openInvoice.id}/pay`, { token, body: {} });
    assert.equal(pay.status, 200, pay.text);
    assert.ok(pay.body.data.paymentUrl);
    await t.call('POST', `/api/manage/invoices/${sub.subscription.openInvoice.id}/pay`, { token, body: {} });
    assert.equal(t.db.prepare("SELECT COUNT(*) c FROM saas_invoices WHERE restaurant_id = ? AND status = 'open'").get(rid).c, 1);
    assert.equal(t.db.prepare('SELECT status FROM subscriptions WHERE restaurant_id = ?').get(rid).status, 'expired'); // still not active
  } finally { t.db.prepare("UPDATE plans SET trial_days = 14 WHERE code = 'basic'").run(); }
});

// ------------------------------------------------------------------------------------------------ branches after registration
test('branches are added later from the dashboard: 16 branches, each with its own location and its own stock', async () => {
  const o = await t.createRestaurantOwner();
  t.setPlan(o, 'business');
  const own = (path2, body, method = 'POST') => t.call(method, path2, { token: o.token, body });
  assert.deepEqual((await t.call('GET', '/api/manage/branches', { token: o.token })).body.data.branches, []); // an explicit, empty state

  const ids = [];
  for (let i = 0; i < 16; i++) {
    const r = await own('/api/manage/branches', { nameAr: `فرع ${i + 1}`, nameEn: `Branch ${i + 1}`, address: `${i} Main St`, latitude: 24 + i * 0.01, longitude: 46 + i * 0.01 });
    assert.equal(r.status, 201, r.text);
    ids.push(r.body.data.branch.id);
  }
  const list = (await t.call('GET', '/api/manage/branches', { token: o.token })).body.data.branches;
  assert.equal(list.length, 16);
  assert.equal(new Set(list.map((b) => `${b.latitude},${b.longitude}`)).size, 16); // 16 different locations
  assert.equal((await own('/api/manage/branches', { nameEn: 'No location', latitude: 24 }, 'POST')).status, 400); // a location is a pair

  const dish = await t.addProduct(o, { trackStock: true });
  const setStock = (branchId, quantity) => own(`/api/manage/stock/dishes/${dish.id}`, { branchId, quantity }, 'PATCH');
  assert.equal((await setStock(ids[0], 5)).status, 200);
  assert.equal((await setStock(ids[1], 9)).status, 200);
  const qty = async (branchId) => (await t.call('GET', `/api/manage/stock?branchId=${branchId}`, { token: o.token })).body.data.items.find((i) => i.id === dish.id).quantity;
  assert.deepEqual([await qty(ids[0]), await qty(ids[1]), await qty(ids[2])], [5, 9, 0]);

  // another owner cannot touch them
  const other = await t.createRestaurantOwner();
  assert.equal((await t.call('PUT', `/api/manage/branches/${ids[0]}`, { token: other.token, body: { nameEn: 'x' } })).status, 404);
});

test('a restaurant with no branches still shows its menu and accepts orders (stock lives on the dishes)', async () => {
  const o = await t.createRestaurantOwner();
  const d = await t.addProduct(o);
  const menu = await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`);
  assert.equal(menu.status, 200);
  assert.deepEqual(menu.body.data.branches, []);
  const c = await t.registerCustomer();
  assert.equal((await t.placeOrder(o, c, [{ productId: d.id, quantity: 1 }])).status, 201);
});

// ------------------------------------------------------------------------------------------------ discounts: per-customer limit
const rule = (o, body) => t.call('POST', '/api/manage/discounts', { token: o.token, body: { nameAr: 'خصم', nameEn: 'Sale', scope: 'restaurant', kind: 'percent', percent: 50, ...body } });
const order = (o, c, dish, extra) => t.placeOrder(o, c, [{ productId: dish.id, quantity: 1 }], extra);
const subtotal = async (o, c, dish, extra) => { const r = await order(o, c, dish, extra); assert.equal(r.status, 201, r.text); return r.body.data.order.subtotalCents; };
const menuPrice = async (o, c, dish) => (await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`, c ? { token: c.token } : {})).body.data.products.find((p) => p.id === dish.id).priceCents;
const live = (ruleId) => t.db.prepare("SELECT COUNT(*) c FROM discount_redemptions WHERE rule_id = ? AND status != 'released'").get(ruleId).c;
const usedCount = (ruleId) => t.db.prepare('SELECT used_count u FROM discount_rules WHERE id = ?').get(ruleId).u;

test('discount: each customer may use a single-use offer once; the same customer cannot repeat it; others are unaffected', async () => {
  const o = await t.createRestaurantOwner();
  const d = await t.addProduct(o, { priceCents: 1000 });
  const made = await rule(o, {});
  assert.equal(made.body.data.rule.maxUsesPerCustomer, 1); // the default for a new offer
  const ruleId = made.body.data.rule.id;
  const a = await t.registerCustomer(); const b = await t.registerCustomer(); const anon = null;

  assert.equal(await menuPrice(o, anon, d), 500);
  assert.equal(await subtotal(o, a, d), 500);   // A: first use
  assert.equal(await subtotal(o, a, d), 1000);  // A: the same offer again - not applied
  assert.equal(await menuPrice(o, a, d), 1000); // ...and A's menu shows the real price they would pay
  assert.equal(await menuPrice(o, b, d), 500);  // B still sees the offer
  assert.equal(await subtotal(o, b, d), 500);   // B: first use
  assert.equal(live(ruleId), 2);
  assert.equal(usedCount(ruleId), 2);

  // limits are edited independently: two uses per customer
  await t.call('PUT', `/api/manage/discounts/${ruleId}`, { token: o.token, body: { maxUsesPerCustomer: 2 } });
  assert.equal(await subtotal(o, a, d), 500);
  assert.equal(await subtotal(o, a, d), 1000);
  // a blank value means no per-customer limit
  const edited = await t.call('PUT', `/api/manage/discounts/${ruleId}`, { token: o.token, body: { maxUsesPerCustomer: null } });
  assert.equal(edited.body.data.rule.maxUsesPerCustomer, null);
  assert.equal(await subtotal(o, a, d), 500);
  assert.equal((await t.call('POST', '/api/manage/discounts', { token: o.token, body: { nameAr: 'x', nameEn: 'x', scope: 'restaurant', kind: 'percent', percent: 10, maxUsesPerCustomer: 0 } })).status, 400);
});

test('discount: the total limit and the per-customer limit are independent', async () => {
  const o = await t.createRestaurantOwner();
  const d = await t.addProduct(o, { priceCents: 1000 });
  const ruleId = (await rule(o, { usageLimit: 2 })).body.data.rule.id; // 2 orders in total, 1 per customer
  const [a, b, c] = [await t.registerCustomer(), await t.registerCustomer(), await t.registerCustomer()];
  assert.equal(await subtotal(o, a, d), 500);
  assert.equal(await subtotal(o, b, d), 500);
  assert.equal(await subtotal(o, c, d), 1000); // C has never used it, but the total of 2 is gone
  const row = (await t.call('GET', '/api/manage/discounts', { token: o.token })).body.data.rules.find((r) => r.id === ruleId);
  assert.deepEqual([row.status, row.usedCount, row.usageLimit, row.maxUsesPerCustomer], ['exhausted', 2, 2, 1]);

  // a total limit with no per-customer limit: one customer may take every remaining use
  const o2 = await t.createRestaurantOwner();
  const d2 = await t.addProduct(o2, { priceCents: 1000 });
  await rule(o2, { usageLimit: 2, maxUsesPerCustomer: null });
  assert.deepEqual([await subtotal(o2, a, d2), await subtotal(o2, a, d2), await subtotal(o2, a, d2)], [500, 500, 1000]);
});

test('discount: other independently eligible offers keep working after one is used up', async () => {
  const o = await t.createRestaurantOwner();
  const d1 = await t.addProduct(o, { priceCents: 1000 });
  const d2 = await t.addProduct(o, { priceCents: 2000 });
  await rule(o, { scope: 'product', productIds: [d1.id], percent: 50 });
  await rule(o, { scope: 'product', productIds: [d2.id], percent: 25 });
  const c = await t.registerCustomer();
  assert.equal(await subtotal(o, c, d1), 500);
  assert.equal(await subtotal(o, c, d1), 1000); // the dish-1 offer is used up for C
  assert.equal(await subtotal(o, c, d2), 1500); // the dish-2 offer is a different promotion: still available
  assert.equal(await subtotal(o, c, d2), 2000);
});

test('discount: simultaneous checkouts cannot exceed the per-customer or the total limit', async () => {
  const o = await t.createRestaurantOwner();
  const d = await t.addProduct(o, { priceCents: 1000 });
  const ruleId = (await rule(o, {})).body.data.rule.id;
  const c = await t.registerCustomer();
  const burst = await Promise.all(Array.from({ length: 8 }, () => order(o, c, d)));
  assert.ok(burst.every((r) => r.status === 201));
  assert.equal(burst.filter((r) => r.body.data.order.subtotalCents === 500).length, 1); // exactly one discounted order
  assert.equal(live(ruleId), 1);

  const o2 = await t.createRestaurantOwner();
  const d2 = await t.addProduct(o2, { priceCents: 1000 });
  const rule2 = (await rule(o2, { usageLimit: 3 })).body.data.rule.id;
  const customers = await Promise.all(Array.from({ length: 7 }, () => t.registerCustomer()));
  const wave = await Promise.all(customers.map((cu) => order(o2, cu, d2)));
  assert.equal(wave.filter((r) => r.body.data.order.subtotalCents === 500).length, 3);
  assert.equal(usedCount(rule2), 3);
  assert.equal(live(rule2), 3);
});

test('discount lifecycle: cancelled, rejected and failed-payment orders give the use back exactly once; delivered orders keep it', async () => {
  const o = await t.createRestaurantOwner('Life Cycle', 'pro', { payoutAccount: true });
  const d = await t.addProduct(o, { priceCents: 1000 });
  const ruleId = (await rule(o, { usageLimit: 5 })).body.data.rule.id;
  const c = await t.registerCustomer();
  const status = (id, s) => t.call('PATCH', `/api/manage/orders/${id}/status`, { token: o.token, body: { status: s } });

  // customer cancels a pending order -> the offer is available again
  const first = (await order(o, c, d)).body.data.order;
  assert.equal(first.subtotalCents, 500);
  assert.equal((await subtotal(o, c, d)), 1000);
  assert.equal((await t.call('POST', `/api/me/orders/${first.id}/cancel`, { token: c.token })).status, 200);
  assert.equal(live(ruleId), 0);
  assert.equal(await menuPrice(o, c, d), 500);
  // releasing again (retry / duplicate event) changes nothing
  assert.equal(discounts.releaseForOrder(t.db, first.id), 0);
  assert.equal(usedCount(ruleId), 0);

  // the restaurant rejects an order -> released as well
  const second = (await order(o, c, d)).body.data.order;
  assert.equal(second.subtotalCents, 500);
  assert.equal((await status(second.id, 'rejected')).status, 200);
  assert.equal(live(ruleId), 0);

  // a delivered order keeps its use
  const third = (await order(o, c, d)).body.data.order;
  for (const s of ['confirmed', 'preparing', 'ready', 'delivered']) assert.equal((await status(third.id, s)).status, 200, s);
  assert.equal(t.db.prepare('SELECT status FROM discount_redemptions WHERE order_id = ?').get(third.id).status, 'redeemed');
  assert.equal(await menuPrice(o, c, d), 1000);
  assert.equal(live(ruleId), 1);
});

test('discount lifecycle: a declined card payment frees the use; a duplicate webhook does not corrupt the counts; a paid order keeps it', async () => {
  const o = await t.createRestaurantOwner('Pay Disc', 'pro', { payoutAccount: true });
  const d = await t.addProduct(o, { priceCents: 1000 });
  const ruleId = (await rule(o, { usageLimit: 3 })).body.data.rule.id;
  const c = await t.registerCustomer();
  const chargeOf = (id) => t.db.prepare('SELECT provider_transaction_id p FROM payments WHERE order_id = ?').get(id).p;
  const hook = (chargeId, status) => { const w = t.fake.webhookFor(chargeId, status); return t.call('POST', '/webhooks/tap', { body: w.body, headers: w.headers }); };

  const unpaid = (await order(o, c, d, { paymentMethod: 'card' })).body.data.order;
  assert.equal(unpaid.status, 'awaiting_payment');
  assert.equal(unpaid.subtotalCents, 500);
  assert.equal(live(ruleId), 1); // held while the payment is pending
  assert.equal(await subtotal(o, c, d), 1000); // ...so it cannot be taken twice meanwhile

  const charge = chargeOf(unpaid.id);
  assert.equal((await hook(charge, 'DECLINED')).status, 200);
  assert.equal((await hook(charge, 'DECLINED')).status, 200); // delivered twice
  assert.equal(t.db.prepare('SELECT status FROM orders WHERE id = ?').get(unpaid.id).status, 'cancelled');
  assert.equal(live(ruleId), 0);
  assert.equal(usedCount(ruleId), 0); // the single use that was held came back once (the full-price COD order in between never counted)
  assert.equal(t.db.prepare("SELECT COUNT(*) c FROM discount_redemptions WHERE order_id = ? AND status = 'released'").get(unpaid.id).c, 1);

  // expiry of an unpaid order
  const again = (await order(o, c, d, { paymentMethod: 'card' })).body.data.order;
  assert.equal(again.subtotalCents, 500);
  t.db.prepare("UPDATE orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(again.id);
  await payments.expireUnpaidOrders(t.db, require('../server/payments/provider').createProvider(t.config));
  assert.equal(live(ruleId), 0);

  // a successful payment (and its duplicate webhook) keeps the use
  const paid = (await order(o, c, d, { paymentMethod: 'card' })).body.data.order;
  t.fake.capture(chargeOf(paid.id));
  await hook(chargeOf(paid.id), 'CAPTURED');
  await hook(chargeOf(paid.id), 'CAPTURED');
  assert.equal(t.db.prepare('SELECT status FROM orders WHERE id = ?').get(paid.id).status, 'pending');
  assert.equal(live(ruleId), 1);
  assert.equal(await menuPrice(o, c, d), 1000);
});

test('discount: a retried order request (same Idempotency-Key) is one order and one use; customers are told apart by their account', async () => {
  const o = await t.createRestaurantOwner();
  const d = await t.addProduct(o, { priceCents: 1000 });
  const ruleId = (await rule(o, { maxUsesPerCustomer: 3 })).body.data.rule.id;
  const c = await t.registerCustomer();
  const key = { 'Idempotency-Key': t.unique('ord') };
  const one = await order(o, c, d, undefined);
  const a = await t.placeOrder(o, c, [{ productId: d.id, quantity: 1 }], {}, key);
  const b = await t.placeOrder(o, c, [{ productId: d.id, quantity: 1 }], {}, key);
  assert.equal(a.body.data.order.id, b.body.data.order.id);
  assert.equal(live(ruleId), 2);
  assert.ok(one.body.data.order.id !== a.body.data.order.id);
  // a client-supplied customer id is never read: the session decides
  const other = await t.registerCustomer();
  const forged = await t.placeOrder(o, other, [{ productId: d.id, quantity: 1 }], { customerId: c.user.id, customer_id: c.user.id });
  assert.equal(t.db.prepare('SELECT customer_id FROM discount_redemptions WHERE order_id = ?').get(forged.body.data.order.id).customer_id, other.user.id);
});

// ------------------------------------------------------------------------------------------------ category pictures
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const putImage = (o, id, body, type = 'image/png') => t.call('PUT', `/api/manage/categories/${id}/image`, { token: o.token, body, raw: true, headers: { 'Content-Type': type } });
const newCategory = async (o, en = 'Burgers') => (await t.call('POST', '/api/manage/categories', { token: o.token, body: { nameAr: 'برجر', nameEn: `${en} ${t.unique('')}` } })).body.data.category;
const fileOf = (url) => path.join(t.config.uploadDir, ...url.replace(/^\/uploads\//, '').split('/'));

test('categories: a category can have a picture, replace it, remove it, or have none', async () => {
  const o = await t.createRestaurantOwner();
  const none = await newCategory(o);
  assert.equal(none.imageUrl, null);

  const cat = await newCategory(o, 'Pizza');
  const up = await putImage(o, cat.id, PNG);
  assert.equal(up.status, 200, up.text);
  const url1 = up.body.data.category.imageUrl;
  assert.match(url1, new RegExp(`^/uploads/${o.restaurant.id}/[a-f0-9]{24}\\.png$`));
  assert.ok(fs.existsSync(fileOf(url1)));
  assert.equal((await t.call('GET', url1)).status, 200); // served

  // shown wherever categories are listed: dashboard + the customer's menu
  assert.equal((await t.call('GET', '/api/manage/categories', { token: o.token })).body.data.categories.find((c) => c.id === cat.id).imageUrl, url1);
  const menu = (await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`)).body.data.categories;
  assert.equal(menu.find((c) => c.id === cat.id).imageUrl, url1);
  assert.equal(menu.find((c) => c.id === none.id).imageUrl, null); // no picture -> the page shows its placeholder

  // replacing removes the old file
  const url2 = (await putImage(o, cat.id, JPG, 'image/jpeg')).body.data.category.imageUrl;
  assert.notEqual(url2, url1);
  assert.ok(fs.existsSync(fileOf(url2)));
  assert.ok(!fs.existsSync(fileOf(url1)));
  // renaming keeps the picture
  await t.call('PUT', `/api/manage/categories/${cat.id}`, { token: o.token, body: { nameAr: 'بيتزا', nameEn: `Pizza ${t.unique('')}` } });
  assert.equal((await t.call('GET', '/api/manage/categories', { token: o.token })).body.data.categories.find((c) => c.id === cat.id).imageUrl, url2);

  // removing
  const removed = await t.call('DELETE', `/api/manage/categories/${cat.id}/image`, { token: o.token });
  assert.equal(removed.body.data.category.imageUrl, null);
  assert.ok(!fs.existsSync(fileOf(url2)));

  // deleting the category deletes its picture
  const url3 = (await putImage(o, cat.id, PNG)).body.data.category.imageUrl;
  assert.equal((await t.call('DELETE', `/api/manage/categories/${cat.id}`, { token: o.token })).status, 200);
  assert.ok(!fs.existsSync(fileOf(url3)));
});

test('categories: only real images up to 2 MB are accepted, and only by the owner of the category', async () => {
  const o = await t.createRestaurantOwner();
  const cat = await newCategory(o);
  assert.equal((await putImage(o, cat.id, Buffer.from('<svg onload=alert(1)>'), 'image/png')).status, 415); // content is checked, not the label
  assert.equal((await putImage(o, cat.id, PNG, 'image/gif')).status, 415);
  assert.equal((await putImage(o, cat.id, Buffer.alloc(0))).status, 415);
  const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
  assert.ok([400, 413].includes((await putImage(o, cat.id, big)).status));
  assert.equal((await t.call('GET', '/api/manage/categories', { token: o.token })).body.data.categories.find((c) => c.id === cat.id).imageUrl, null);

  // the picture cannot be set through the JSON endpoints (no arbitrary paths), and other restaurants are locked out
  const sneaky = await t.call('PUT', `/api/manage/categories/${cat.id}`, { token: o.token, body: { nameAr: 'ع', nameEn: `Sneaky ${t.unique('')}`, imageUrl: '/uploads/999/aaaaaaaaaaaaaaaaaaaaaaaa.png' } });
  assert.equal(sneaky.status, 200);
  assert.equal(t.db.prepare('SELECT image_url FROM categories WHERE id = ?').get(cat.id).image_url, null);

  const url = (await putImage(o, cat.id, PNG)).body.data.category.imageUrl;
  const rival = await t.createRestaurantOwner();
  assert.equal((await putImage(rival, cat.id, JPG, 'image/jpeg')).status, 404);
  assert.equal((await t.call('DELETE', `/api/manage/categories/${cat.id}/image`, { token: rival.token })).status, 404);
  assert.equal((await t.call('DELETE', `/api/manage/categories/${cat.id}`, { token: rival.token })).status, 404);
  assert.ok(fs.existsSync(fileOf(url)));
  // customers cannot upload
  const c = await t.registerCustomer();
  assert.equal((await putImage({ token: c.token }, cat.id, PNG)).status, 403);
  // a dish that uses the same file keeps it alive when the category goes
  await t.call('PUT', `/api/manage/products/${(await t.addProduct(o)).id}`, { token: o.token, body: { imageUrl: url } });
  await t.call('DELETE', `/api/manage/categories/${cat.id}/image`, { token: o.token });
  assert.ok(fs.existsSync(fileOf(url)));
});
