const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

let t, A, B, prodA, prodB, orderA, custA, custB, staffA;

before(async () => {
  t = await startApp();
  A = await t.createRestaurantOwner('Alpha Grill', 'pro');
  B = await t.createRestaurantOwner('Bravo Bistro', 'pro');
  prodA = await t.addProduct(A, { name: 'Alpha Burger', priceCents: 1200 });
  prodB = await t.addProduct(B, { name: 'Bravo Pasta', priceCents: 1500 });
  custA = await t.registerCustomer('Customer A');
  custB = await t.registerCustomer('Customer B');
  const o = await t.call('POST', `/api/public/restaurants/${A.restaurant.slug}/orders`, {
    token: custA.token, body: t.orderBody([{ productId: prodA.id, quantity: 2 }]),
  });
  assert.equal(o.status, 201);
  orderA = o.body.data.order;
  const s = await t.call('POST', '/api/manage/staff', { token: A.token, body: { name: 'Sam Staff', email: `${t.unique('s')}@t.test`, password: 'Passw0rd!' } });
  assert.equal(s.status, 201);
  const login = await t.call('POST', '/api/auth/login', { body: { email: s.body.data.staff.email, password: 'Passw0rd!' } });
  staffA = { token: login.body.data.token, id: s.body.data.staff.id };
});
after(async () => { await t.close(); });

test('B cannot read, update, toggle or delete A\'s product by guessing its id', async () => {
  const get = await t.call('GET', '/api/manage/products', { token: B.token });
  assert.ok(!get.body.data.products.some((p) => p.id === prodA.id), 'A product must not appear in B list');
  const put = await t.call('PUT', `/api/manage/products/${prodA.id}`, { token: B.token, body: { name: 'HACKED', priceCents: 1 } });
  assert.equal(put.status, 404);
  const patch = await t.call('PATCH', `/api/manage/products/${prodA.id}/availability`, { token: B.token, body: { isAvailable: false } });
  assert.equal(patch.status, 404);
  const del = await t.call('DELETE', `/api/manage/products/${prodA.id}`, { token: B.token });
  assert.equal(del.status, 404);
  const row = t.db.prepare('SELECT name, price_cents, is_available FROM products WHERE id = ?').get(prodA.id);
  assert.deepEqual({ ...row }, { name: 'Alpha Burger', price_cents: 1200, is_available: 1 });
});

test('a restaurantId in the body, query or header is ignored: data always lands in the caller\'s own tenant', async () => {
  const idA = A.restaurant.id;
  const r = await t.call('POST', `/api/manage/products?restaurantId=${idA}`, {
    token: B.token, headers: { 'X-Restaurant-Id': String(idA) },
    body: { name: 'Sneaky', priceCents: 100, restaurantId: idA, restaurant_id: idA },
  });
  assert.equal(r.status, 201);
  const row = t.db.prepare('SELECT restaurant_id FROM products WHERE id = ?').get(r.body.data.product.id);
  assert.equal(row.restaurant_id, B.restaurant.id);
  const list = await t.call('GET', `/api/manage/products?restaurantId=${idA}`, { token: B.token });
  assert.ok(list.body.data.products.every((p) => p.name !== 'Alpha Burger'));
  const upd = await t.call('PUT', '/api/manage/restaurant', { token: B.token, body: { id: idA, name: 'Bravo Renamed' } });
  assert.equal(upd.status, 200);
  assert.equal(t.db.prepare('SELECT name FROM restaurants WHERE id = ?').get(idA).name.startsWith('Alpha Grill'), true);
});

test('B cannot see or change A\'s orders', async () => {
  const list = await t.call('GET', '/api/manage/orders', { token: B.token });
  assert.equal(list.body.data.orders.length, 0);
  const one = await t.call('GET', `/api/manage/orders/${orderA.id}`, { token: B.token });
  assert.equal(one.status, 404);
  const patch = await t.call('PATCH', `/api/manage/orders/${orderA.id}/status`, { token: B.token, body: { status: 'confirmed' } });
  assert.equal(patch.status, 404);
  assert.equal(t.db.prepare('SELECT status FROM orders WHERE id = ?').get(orderA.id).status, 'pending');
});

test('B cannot see A\'s customers, reports, staff or subscription', async () => {
  const cust = await t.call('GET', '/api/manage/customers', { token: B.token });
  assert.equal(cust.body.data.customers.length, 0);
  const sum = await t.call('GET', '/api/manage/reports/summary', { token: B.token });
  assert.equal(sum.body.data.orders, 0);
  assert.equal(sum.body.data.revenueCents, 0);
  const staff = await t.call('GET', '/api/manage/staff', { token: B.token });
  assert.equal(staff.body.data.staff.length, 0);
  const del = await t.call('DELETE', `/api/manage/staff/${staffA.id}`, { token: B.token });
  assert.equal(del.status, 404);
  const csv = await t.call('GET', '/api/manage/reports/orders.csv', { token: B.token });
  assert.equal(csv.status, 200);
  assert.ok(!csv.text.includes('Customer A'));
});

test('A\'s own view does contain its data (control for the isolation tests)', async () => {
  const list = await t.call('GET', '/api/manage/orders', { token: A.token });
  assert.equal(list.body.data.orders.length, 1);
  const cust = await t.call('GET', '/api/manage/customers', { token: A.token });
  assert.equal(cust.body.data.customers.length, 1);
});

test('B cannot attach a category belonging to A (API check and DB composite FK)', async () => {
  const catA = await t.call('POST', '/api/manage/categories', { token: A.token, body: { name: 'Mains' } });
  const r = await t.call('POST', '/api/manage/products', { token: B.token, body: { name: 'X', priceCents: 1, categoryId: catA.body.data.category.id } });
  assert.equal(r.status, 400);
  // Even a direct SQL insert that bypasses the API is rejected by the database.
  assert.throws(() => t.db.prepare('INSERT INTO products (restaurant_id, category_id, name, price_cents) VALUES (?,?,?,?)')
    .run(B.restaurant.id, catA.body.data.category.id, 'raw', 1), /FOREIGN KEY/i);
  const putCat = await t.call('PUT', `/api/manage/categories/${catA.body.data.category.id}`, { token: B.token, body: { name: 'Pwned' } });
  assert.equal(putCat.status, 404);
  const delCat = await t.call('DELETE', `/api/manage/categories/${catA.body.data.category.id}`, { token: B.token });
  assert.equal(delCat.status, 404);
});

test('database refuses order items that point at another tenant\'s order or product', async () => {
  assert.throws(() => t.db.prepare(
    'INSERT INTO order_items (order_id, restaurant_id, product_id, product_name, unit_price_cents, quantity, line_total_cents) VALUES (?,?,?,?,?,?,?)')
    .run(orderA.id, B.restaurant.id, null, 'x', 1, 1, 1), /FOREIGN KEY/i);
  assert.throws(() => t.db.prepare(
    'INSERT INTO order_items (order_id, restaurant_id, product_id, product_name, unit_price_cents, quantity, line_total_cents) VALUES (?,?,?,?,?,?,?)')
    .run(orderA.id, A.restaurant.id, prodB.id, 'x', 1, 1, 1), /FOREIGN KEY/i);
});

test('a cart containing B\'s product cannot be ordered from A', async () => {
  const r = await t.call('POST', `/api/public/restaurants/${A.restaurant.slug}/orders`, {
    token: custA.token, body: t.orderBody([{ productId: prodA.id, quantity: 1 }, { productId: prodB.id, quantity: 1 }]),
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'invalid_item');
});

test('customers only see their own orders', async () => {
  const mineB = await t.call('GET', '/api/me/orders', { token: custB.token });
  assert.equal(mineB.body.data.orders.length, 0);
  const peek = await t.call('GET', `/api/me/orders/${orderA.id}`, { token: custB.token });
  assert.equal(peek.status, 404);
  const cancel = await t.call('POST', `/api/me/orders/${orderA.id}/cancel`, { token: custB.token });
  assert.equal(cancel.status, 404);
  const mineA = await t.call('GET', `/api/me/orders/${orderA.id}`, { token: custA.token });
  assert.equal(mineA.status, 200);
  assert.equal(mineA.body.data.order.items[0].name, 'Alpha Burger');
});

test('role-based access: customers, staff and anonymous users are fenced off', async () => {
  for (const path of ['/api/manage/orders', '/api/manage/products', '/api/manage/restaurant']) {
    assert.equal((await t.call('GET', path, { token: custA.token })).status, 403, `customer on ${path}`);
    assert.equal((await t.call('GET', path)).status, 401, `anon on ${path}`);
  }
  // staff: operational access yes, owner-only no
  assert.equal((await t.call('GET', '/api/manage/orders', { token: staffA.token })).status, 200);
  assert.equal((await t.call('GET', '/api/manage/products', { token: staffA.token })).status, 200);
  for (const [m, p, b] of [
    ['POST', '/api/manage/products', { name: 'x', priceCents: 1 }],
    ['PUT', '/api/manage/restaurant', { name: 'x' }],
    ['GET', '/api/manage/subscription'],
    ['GET', '/api/manage/earnings'],
    ['GET', '/api/manage/payouts'],
    ['GET', '/api/manage/payments'],
    ['GET', '/api/manage/staff'],
    ['POST', '/api/manage/staff', { name: 'x', email: 'x@t.test', password: 'Passw0rd!' }],
    ['GET', '/api/manage/customers'],
    ['GET', '/api/manage/reports/summary'],
  ]) {
    const r = await t.call(m, p, { token: staffA.token, body: b });
    assert.equal(r.status, 403, `staff ${m} ${p}`);
  }
  // staff can run orders and 86 an item
  assert.equal((await t.call('PATCH', `/api/manage/products/${prodA.id}/availability`, { token: staffA.token, body: { isAvailable: false } })).status, 200);
  await t.call('PATCH', `/api/manage/products/${prodA.id}/availability`, { token: staffA.token, body: { isAvailable: true } });
  // nobody but a super admin reaches platform admin APIs
  for (const tok of [A.token, staffA.token, custA.token]) {
    assert.equal((await t.call('GET', '/api/admin/stats', { token: tok })).status, 403);
    assert.equal((await t.call('GET', '/api/admin/restaurants', { token: tok })).status, 403);
    assert.equal((await t.call('PATCH', `/api/admin/restaurants/${B.restaurant.id}`, { token: tok, body: { isActive: false } })).status, 403);
  }
});

test('public endpoints never leak private fields', async () => {
  const r = await t.call('GET', `/api/public/restaurants/${A.restaurant.slug}`);
  assert.equal(r.status, 200);
  const dump = JSON.stringify(r.body);
  assert.ok(!dump.includes('@t.test'), 'no email addresses');
  assert.ok(!/password|subscription|provider/i.test(dump));
  const list = await t.call('GET', '/api/public/restaurants');
  assert.ok(!JSON.stringify(list.body).includes('@t.test'));
  assert.equal((await t.call('GET', '/api/public/restaurants/does-not-exist')).status, 404);
});

test('a token for one tenant cannot be upgraded by editing claims (role/tenant come from the database)', async () => {
  const jwt = require('jsonwebtoken');
  const forged = jwt.sign({ sub: custA.user.id, role: 'owner', restaurantId: A.restaurant.id }, 'wrong-secret');
  assert.equal((await t.call('GET', '/api/manage/orders', { token: forged })).status, 401);
  const withRightSecretButFakeClaims = jwt.sign({ sub: custA.user.id, role: 'owner', restaurantId: A.restaurant.id }, process.env.AUTH_SECRET);
  assert.equal((await t.call('GET', '/api/manage/orders', { token: withRightSecretButFakeClaims })).status, 403);
});
