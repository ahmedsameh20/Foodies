const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

let t;
before(async () => { t = await startApp(); });
after(async () => { await t.close(); });

const place = (rest, cust, items, extra) => t.placeOrder(rest, cust, items, extra);

test('menu management: categories + products CRUD, validation errors', async () => {
  const o = await t.createRestaurantOwner('Menu Maker');
  const cat = await t.call('POST', '/api/manage/categories', { token: o.token, body: { name: 'Starters' } });
  assert.equal(cat.status, 201);
  assert.equal((await t.call('POST', '/api/manage/categories', { token: o.token, body: { name: 'Starters' } })).status, 409);
  const p = await t.addProduct(o, { name: 'Soup', priceCents: 450, categoryId: cat.body.data.category.id, description: 'Hot' });
  assert.equal(p.priceCents, 450);
  const upd = await t.call('PUT', `/api/manage/products/${p.id}`, { token: o.token, body: { priceCents: 500, isAvailable: false } });
  assert.equal(upd.body.data.product.priceCents, 500);
  assert.equal(upd.body.data.product.isAvailable, false);
  for (const body of [{ name: '', priceCents: 1 }, { name: 'x', priceCents: -5 }, { name: 'x', priceCents: 1.5 }, { name: 'x', priceCents: 'abc' }, { name: 'x', priceCents: 1, imageUrl: 'javascript:alert(1)' }]) {
    const r = await t.call('POST', '/api/manage/products', { token: o.token, body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const pub = await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`);
  assert.equal(pub.body.data.products.length, 1);
  assert.equal((await t.call('DELETE', `/api/manage/categories/${cat.body.data.category.id}`, { token: o.token })).status, 200);
  const after = await t.call('GET', '/api/manage/products', { token: o.token });
  assert.equal(after.body.data.products[0].categoryId, null);
  assert.equal((await t.call('DELETE', `/api/manage/products/${p.id}`, { token: o.token })).status, 200);
});

test('order placement: totals computed on the server, client prices ignored, price snapshot preserved', async () => {
  const o = await t.createRestaurantOwner('Totals Cafe');
  await t.call('PUT', '/api/manage/restaurant', { token: o.token, body: { taxRateBp: 1000, deliveryFeeCents: 300 } });
  const p1 = await t.addProduct(o, { name: 'Pizza', priceCents: 1000 });
  const p2 = await t.addProduct(o, { name: 'Cola', priceCents: 250 });
  const c = await t.registerCustomer();
  const r = await place(o, c, [
    { productId: p1.id, quantity: 2, priceCents: 1, unitPriceCents: 1 }, { productId: p2.id, quantity: 1 }, { productId: p1.id, quantity: 1 },
  ], { orderType: 'delivery', deliveryAddress: '1 Main Street', totalCents: 1, subtotalCents: 1, commissionCents: 0, platformFeeCents: 0 });
  assert.equal(r.status, 201);
  const ord = r.body.data.order;
  assert.equal(ord.subtotalCents, 3 * 1000 + 250); // duplicate lines merged
  assert.equal(ord.taxCents, 325); // 10%
  assert.equal(ord.deliveryFeeCents, 300);
  assert.equal(ord.totalCents, 3250 + 325 + 300);
  assert.equal(ord.status, 'pending');
  assert.equal(ord.paymentStatus, 'cod_pending');
  assert.equal(ord.restaurantId, o.restaurant.id);
  assert.equal(ord.items.length, 2);

  // Later price change / deletion must not rewrite history.
  await t.call('PUT', `/api/manage/products/${p1.id}`, { token: o.token, body: { priceCents: 9999, name: 'Pizza v2' } });
  await t.call('DELETE', `/api/manage/products/${p2.id}`, { token: o.token });
  const hist = await t.call('GET', `/api/me/orders/${ord.id}`, { token: c.token });
  const names = hist.body.data.order.items.map((i) => `${i.name}:${i.unitPriceCents}`).sort();
  assert.deepEqual(names, ['Cola:250', 'Pizza:1000']);
  assert.equal(hist.body.data.order.totalCents, ord.totalCents);

  // pickup has no delivery fee
  const p3 = await t.addProduct(o, { priceCents: 100 });
  const pk = await place(o, c, [{ productId: p3.id, quantity: 1 }], { orderType: 'pickup' });
  assert.equal(pk.body.data.order.deliveryFeeCents, 0);
  assert.equal(pk.body.data.order.orderNumber, 2);
});

test('order validation: auth, quantity, unavailable item, empty cart, missing address, minimum, closed restaurant', async () => {
  const o = await t.createRestaurantOwner('Rules Diner');
  const p = await t.addProduct(o, { priceCents: 500 });
  const off = await t.addProduct(o, { priceCents: 500, isAvailable: false });
  const c = await t.registerCustomer();
  const url = `/api/public/restaurants/${o.restaurant.slug}/orders`;
  assert.equal((await t.call('POST', url, { body: t.orderBody([{ productId: p.id, quantity: 1 }]) })).status, 401);
  assert.equal((await t.call('POST', url, { token: o.token, body: t.orderBody([{ productId: p.id, quantity: 1 }]) })).status, 403); // owners can't order
  for (const items of [[], [{ productId: p.id, quantity: 0 }], [{ productId: p.id, quantity: -2 }], [{ productId: p.id, quantity: 1.5 }], [{ productId: p.id, quantity: 999 }], [{ productId: 'x', quantity: 1 }], 'nope']) {
    assert.equal((await place(o, c, items)).status, 400, JSON.stringify(items));
  }
  const un = await place(o, c, [{ productId: off.id, quantity: 1 }]);
  assert.equal(un.status, 422);
  assert.equal(un.body.error.code, 'item_unavailable');
  assert.equal((await place(o, c, [{ productId: 987654, quantity: 1 }])).status, 422);
  assert.equal((await place(o, c, [{ productId: p.id, quantity: 1 }], { orderType: 'delivery' })).status, 400); // address required
  assert.equal((await place(o, c, [{ productId: p.id, quantity: 1 }], { orderType: 'teleport' })).status, 400);
  assert.equal((await place(o, c, [{ productId: p.id, quantity: 1 }], { customerPhone: 'abc' })).status, 400);
  assert.equal((await place(o, c, [{ productId: p.id, quantity: 1 }], { paymentMethod: 'bitcoin' })).status, 400);

  await t.call('PUT', '/api/manage/restaurant', { token: o.token, body: { minOrderCents: 2000 } });
  assert.equal((await place(o, c, [{ productId: p.id, quantity: 1 }])).body.error.code, 'below_minimum');
  assert.equal((await place(o, c, [{ productId: p.id, quantity: 4 }])).status, 201);

  await t.call('PUT', '/api/manage/restaurant', { token: o.token, body: { acceptingOrders: false } });
  assert.equal((await place(o, c, [{ productId: p.id, quantity: 4 }])).body.error.code, 'not_accepting_orders');
});

test('order lifecycle: valid transitions only; pickup vs delivery; customer can cancel only while pending', async () => {
  const o = await t.createRestaurantOwner('Flow Kitchen');
  const p = await t.addProduct(o, { priceCents: 700 });
  const c = await t.registerCustomer();
  const ord = (await place(o, c, [{ productId: p.id, quantity: 1 }])).body.data.order;
  const set = (id, status, token = o.token, body = {}) => t.call('PATCH', `/api/manage/orders/${id}/status`, { token, body: { status, ...body } });

  assert.equal((await set(ord.id, 'delivered')).status, 409); // can't skip steps
  assert.equal((await set(ord.id, 'bogus')).status, 400);
  assert.equal((await set(ord.id, 'awaiting_payment')).status, 400);
  for (const s of ['confirmed', 'preparing', 'ready']) assert.equal((await set(ord.id, s)).status, 200, s);
  assert.equal((await set(ord.id, 'out_for_delivery')).status, 409); // pickup orders skip delivery
  const done = await set(ord.id, 'delivered');
  assert.equal(done.status, 200);
  assert.equal(done.body.data.order.paymentStatus, 'cash_collected');
  const detail = await t.call('GET', `/api/manage/orders/${ord.id}`, { token: o.token });
  assert.deepEqual(detail.body.data.history.map((h) => h.status), ['pending', 'confirmed', 'preparing', 'ready', 'delivered']);
  assert.equal((await set(ord.id, 'cancelled')).status, 409); // terminal

  // delivery orders go through out_for_delivery
  const d = (await place(o, c, [{ productId: p.id, quantity: 1 }], { orderType: 'delivery', deliveryAddress: '5 Long Road' })).body.data.order;
  for (const s of ['confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered']) assert.equal((await set(d.id, s)).status, 200, s);

  // rejection
  const rej = (await place(o, c, [{ productId: p.id, quantity: 1 }])).body.data.order;
  const rr = await set(rej.id, 'rejected', o.token, { reason: 'Out of stock' });
  assert.equal(rr.body.data.order.status, 'rejected');
  assert.equal(rr.body.data.order.paymentStatus, 'cancelled');

  const o2 = (await place(o, c, [{ productId: p.id, quantity: 1 }])).body.data.order;
  assert.equal((await t.call('POST', `/api/me/orders/${o2.id}/cancel`, { token: c.token })).body.data.order.status, 'cancelled');
  const o3 = (await place(o, c, [{ productId: p.id, quantity: 1 }])).body.data.order;
  await set(o3.id, 'confirmed');
  assert.equal((await t.call('POST', `/api/me/orders/${o3.id}/cancel`, { token: c.token })).status, 409);

  const filtered = await t.call('GET', '/api/manage/orders?status=delivered', { token: o.token });
  assert.equal(filtered.body.data.orders.length, 2);
  assert.equal((await t.call('GET', '/api/manage/orders?status=nope', { token: o.token })).status, 400);
  const mine = await t.call('GET', '/api/me/orders', { token: c.token });
  assert.equal(mine.body.data.orders.length, 5);
});

test('plan limits: Free allows 10 items then 402; a higher tier assigned by the platform lifts the cap', async () => {
  const o = await t.createRestaurantOwner('Limit Lane');
  for (let i = 0; i < 10; i++) await t.addProduct(o);
  const over = await t.call('POST', '/api/manage/products', { token: o.token, body: { name: 'Eleventh', priceCents: 1 } });
  assert.equal(over.status, 402);
  assert.equal(over.body.error.code, 'plan_limit_reached');
  assert.equal(over.body.error.details.limit, 10);

  t.setPlan(o, 'basic');
  assert.equal((await t.call('POST', '/api/manage/products', { token: o.token, body: { name: 'Eleventh', priceCents: 1 } })).status, 201);
  for (let i = 0; i < 89; i++) await t.addProduct(o); // 100 total = Starter (basic) cap
  assert.equal((await t.call('POST', '/api/manage/products', { token: o.token, body: { name: 'x', priceCents: 1 } })).status, 402);

  // owners cannot buy/change plans themselves: there is no self-service billing
  const self = await t.call('POST', '/api/manage/subscription', { token: o.token, body: { planCode: 'pro' } });
  assert.equal(self.status, 404);
  const view = await t.call('GET', '/api/manage/subscription', { token: o.token });
  assert.equal(view.body.data.subscription.plan.code, 'basic');
});

test('plan features: analytics needs Basic, advanced reports + CSV need Pro (enforced server-side)', async () => {
  const o = await t.createRestaurantOwner('Feature Fork');
  const get = (p) => t.call('GET', p, { token: o.token });
  assert.equal((await get('/api/manage/reports/summary')).status, 402);
  assert.equal((await get('/api/manage/reports/summary')).body.error.code, 'feature_not_in_plan');
  assert.equal((await get('/api/manage/reports/advanced')).status, 402);
  assert.equal((await get('/api/manage/reports/orders.csv')).status, 402);

  t.setPlan(o, 'basic');
  assert.equal((await get('/api/manage/reports/summary')).status, 200);
  assert.equal((await get('/api/manage/reports/advanced')).status, 402);

  t.setPlan(o, 'pro');
  assert.equal((await get('/api/manage/reports/advanced')).status, 200);
  assert.equal((await get('/api/manage/reports/orders.csv')).status, 200);
});

test('reports reflect real orders and exclude cancelled revenue', async () => {
  const o = await t.createRestaurantOwner('Report Roast', 'pro');
  const p = await t.addProduct(o, { name: 'Roast', priceCents: 1000 });
  const c = await t.registerCustomer();
  const a = (await place(o, c, [{ productId: p.id, quantity: 2 }])).body.data.order;
  const b = (await place(o, c, [{ productId: p.id, quantity: 1 }])).body.data.order;
  await t.call('PATCH', `/api/manage/orders/${b.id}/status`, { token: o.token, body: { status: 'cancelled' } });
  const s = (await t.call('GET', '/api/manage/reports/summary', { token: o.token })).body.data;
  assert.equal(s.orders, 2);
  assert.equal(s.cancelled, 1);
  assert.equal(s.revenueCents, a.totalCents);
  assert.equal(s.avgOrderCents, a.totalCents);
  const adv = (await t.call('GET', '/api/manage/reports/advanced', { token: o.token })).body.data;
  assert.deepEqual(adv.topProducts[0], { name: 'Roast', quantity: 2, revenueCents: 2000 });
  const csv = await t.call('GET', '/api/manage/reports/orders.csv', { token: o.token });
  assert.match(csv.text, /^order_number,created_at/);
  assert.equal(csv.text.trim().split('\n').length, 3);
});

test('staff and branch limits follow the plan', async () => {
  const o = await t.createRestaurantOwner('Team Table');
  const mk = (n) => t.call('POST', '/api/manage/staff', { token: o.token, body: { name: 'S', email: `${t.unique(n)}@t.test`, password: 'Passw0rd!' } });
  assert.equal((await mk('s')).status, 201);
  assert.equal((await mk('s')).status, 402); // Free: 1 staff
  assert.equal((await t.call('POST', '/api/manage/branches', { token: o.token, body: { name: 'Main' } })).status, 201);
  assert.equal((await t.call('POST', '/api/manage/branches', { token: o.token, body: { name: 'Second' } })).status, 402); // Free: 1 branch
  t.setPlan(o, 'basic');
  assert.equal((await mk('s')).status, 201);
  assert.equal((await t.call('POST', '/api/manage/branches', { token: o.token, body: { name: 'Second' } })).status, 201);
});

test('image upload accepts real images only', async () => {
  const o = await t.createRestaurantOwner('Upload Uno');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const ok = await t.call('POST', '/api/manage/uploads', { token: o.token, raw: true, body: png, headers: { 'Content-Type': 'image/png' } });
  assert.equal(ok.status, 201);
  assert.match(ok.body.data.url, new RegExp(`^/uploads/${o.restaurant.id}/[0-9a-f]+\\.png$`));
  const served = await fetch(t.base + ok.body.data.url);
  assert.equal(served.status, 200);
  const fake = await t.call('POST', '/api/manage/uploads', { token: o.token, raw: true, body: Buffer.from('<script>alert(1)</script>'), headers: { 'Content-Type': 'image/png' } });
  assert.equal(fake.status, 415);
  const wrongType = await t.call('POST', '/api/manage/uploads', { token: o.token, raw: true, body: png, headers: { 'Content-Type': 'text/html' } });
  assert.equal(wrongType.status, 415);
});

test('menu options / add-ons: priced on the server, validated per group, snapshotted on the order', async () => {
  const o = await t.createRestaurantOwner('Options Oven');
  const burger = await t.addProduct(o, { name: 'Burger', priceCents: 1000 });
  const g = await t.call('POST', `/api/manage/products/${burger.id}/option-groups`, { token: o.token, body: {
    name: 'Extras', minSelect: 0, maxSelect: 2, options: [{ name: 'Cheese', priceCents: 150 }, { name: 'Bacon', priceCents: 250 }, { name: 'Egg', priceCents: 100 }],
  } });
  assert.equal(g.status, 201);
  const sz = await t.call('POST', `/api/manage/products/${burger.id}/option-groups`, { token: o.token, body: {
    name: 'Size', minSelect: 1, maxSelect: 1, options: [{ name: 'Regular', priceCents: 0 }, { name: 'Large', priceCents: 300 }],
  } });
  const [cheese, bacon, egg] = g.body.data.group.options;
  const [regular, large] = sz.body.data.group.options;
  const c = await t.registerCustomer();
  const pub = await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`);
  assert.equal(pub.body.data.products[0].optionGroups.length, 2);

  // required group missing, too many chosen, foreign option
  assert.equal((await place(o, c, [{ productId: burger.id, quantity: 1 }])).body.error.code, 'invalid_option_count');
  assert.equal((await place(o, c, [{ productId: burger.id, quantity: 1, optionIds: [regular.id, cheese.id, bacon.id, egg.id] }])).body.error.code, 'invalid_option_count');
  assert.equal((await place(o, c, [{ productId: burger.id, quantity: 1, optionIds: [regular.id, 999999] }])).body.error.code, 'invalid_option');

  const r = await place(o, c, [{ productId: burger.id, quantity: 2, optionIds: [large.id, cheese.id, bacon.id], priceCents: 1 }]);
  assert.equal(r.status, 201);
  assert.equal(r.body.data.order.items[0].unitPriceCents, 1000 + 300 + 150 + 250);
  assert.equal(r.body.data.order.subtotalCents, 2 * 1700);
  assert.deepEqual(r.body.data.order.items[0].options.map((x) => x.name).sort(), ['Bacon', 'Cheese', 'Large']);

  // another restaurant's option cannot be smuggled in
  const o2 = await t.createRestaurantOwner('Other Oven');
  const p2 = await t.addProduct(o2, { priceCents: 100 });
  const g2 = await t.call('POST', `/api/manage/products/${p2.id}/option-groups`, { token: o2.token, body: { name: 'X', options: [{ name: 'Foreign', priceCents: 0 }] } });
  const foreign = g2.body.data.group.options[0];
  assert.equal((await place(o, c, [{ productId: burger.id, quantity: 1, optionIds: [regular.id, foreign.id] }])).body.error.code, 'invalid_option');
  assert.equal((await t.call('PUT', `/api/manage/option-groups/${g.body.data.group.id}`, { token: o2.token, body: { name: 'hax', options: [{ name: 'a' }] } })).status, 404);
  assert.equal((await t.call('GET', `/api/manage/products/${burger.id}/option-groups`, { token: o2.token })).status, 404);

  // editing options later does not change the stored order
  await t.call('PUT', `/api/manage/option-groups/${g.body.data.group.id}`, { token: o.token, body: { name: 'Extras', minSelect: 0, maxSelect: 1, options: [{ name: 'Truffle', priceCents: 900 }] } });
  const again = await t.call('GET', `/api/me/orders/${r.body.data.order.id}`, { token: c.token });
  assert.equal(again.body.data.order.items[0].unitPriceCents, 1700);
});

test('opening hours: a closed restaurant rejects orders and reports isOpenNow=false', async () => {
  const o = await t.createRestaurantOwner('Hours House');
  const p = await t.addProduct(o);
  const c = await t.registerCustomer();
  const closedAllWeek = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [{ open: '03:00', close: '03:01' }]]));
  const put = await t.call('PUT', '/api/manage/restaurant', { token: o.token, body: { openingHours: closedAllWeek, timezone: 'UTC' } });
  assert.equal(put.status, 200);
  const hhmm = new Date().toISOString().slice(11, 16);
  if (hhmm !== '03:00') {
    const r = await place(o, c, [{ productId: p.id, quantity: 1 }]);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'restaurant_closed');
    assert.equal((await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`)).body.data.restaurant.isOpenNow, false);
  }
  assert.equal((await t.call('PUT', '/api/manage/restaurant', { token: o.token, body: { openingHours: { mon: [{ open: '9:00', close: '10:00' }] } } })).status, 400);
  assert.equal((await t.call('PUT', '/api/manage/restaurant', { token: o.token, body: { timezone: 'Mars/Base' } })).status, 400);
  await t.call('PUT', '/api/manage/restaurant', { token: o.token, body: { openingHours: null } });
  assert.equal((await place(o, c, [{ productId: p.id, quantity: 1 }])).status, 201);
});

test('seed parser imports the legacy menus', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { parseLegacyMenu } = require('../server/services/seedData');
  const items = parseLegacyMenu(fs.readFileSync(path.join(__dirname, '..', 'legacy', 'dominos.html'), 'utf8'));
  assert.ok(items.length > 20);
  assert.ok(items.every((i) => i.priceCents > 0 && i.image.startsWith('/Images/Dishes/') && i.category));
});
