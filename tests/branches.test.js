// Branches (map locations), per-branch stock, branch-aware ordering, discount rules and multi-branch registration.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

let t;
before(async () => { t = await startApp(); });
after(async () => { await t.close(); });

const post = (owner, path, body) => t.call('POST', path, { token: owner.token, body });
const branchBody = (over = {}) => ({ name: t.unique('Branch'), address: '1 Main St', latitude: 24.7136, longitude: 46.6753, ...over });
async function newBranch(owner, over) {
  const r = await post(owner, '/api/manage/branches', branchBody(over));
  assert.equal(r.status, 201, r.text);
  return r.body.data.branch;
}
const bigOwner = async () => { const o = await t.createRestaurantOwner(); t.setPlan(o, 'business'); return o; };
const dish = async (owner, over = {}) => (await t.addProduct(owner, { trackStock: true, ...over }));
const setStock = (owner, kind, id, branchId, body) => t.call('PATCH', `/api/manage/stock/${kind}/${id}`, { token: owner.token, body: { branchId, ...body } });
const stockOf = (owner, branchId, id, kind = 'dish') => t.call('GET', `/api/manage/stock?branchId=${branchId}`, { token: owner.token })
  .then((r) => r.body.data.items.find((i) => i.id === id && i.kind === kind));

test('branches: map location is validated and saved, and a branch belongs to its own restaurant only', async () => {
  const o = await bigOwner();
  const b = await newBranch(o, { latitude: 21.5, longitude: 39.2, addressComponents: { city: 'Jeddah', road: 'King Rd' } });
  assert.deepEqual([b.latitude, b.longitude, b.addressComponents.city, b.isActive], [21.5, 39.2, 'Jeddah', true]);

  const list = await t.call('GET', '/api/manage/branches', { token: o.token });
  assert.equal(list.body.data.branches.find((x) => x.id === b.id).longitude, 39.2); // saved and reloaded

  for (const bad of [{ latitude: 91, longitude: 10 }, { latitude: 10, longitude: 181 }, { latitude: 10, longitude: null }, { latitude: 'x', longitude: 1 }]) {
    const r = await post(o, '/api/manage/branches', branchBody(bad));
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  // another owner can neither see, change nor delete it
  const other = await t.createRestaurantOwner();
  assert.equal((await t.call('GET', '/api/manage/branches', { token: other.token })).body.data.branches.length, 0);
  assert.equal((await t.call('PUT', `/api/manage/branches/${b.id}`, { token: other.token, body: { name: 'hijack' } })).status, 404);
  assert.equal((await t.call('DELETE', `/api/manage/branches/${b.id}`, { token: other.token })).status, 404);
  assert.equal((await t.call('GET', `/api/manage/stock?branchId=${b.id}`, { token: other.token })).status, 404);

  const upd = await t.call('PUT', `/api/manage/branches/${b.id}`, { token: o.token, body: { latitude: 22, longitude: 40, nameAr: 'فرع', nameEn: 'Branch' } });
  assert.deepEqual([upd.body.data.branch.latitude, upd.body.data.branch.nameAr], [22, 'فرع']);
});

test('branches: 15 branches can be configured for one restaurant (plan limit applies)', async () => {
  const o = await bigOwner();
  for (let i = 0; i < 15; i++) await newBranch(o, { latitude: 24 + i / 100, longitude: 46 + i / 100 });
  const list = await t.call('GET', '/api/manage/branches', { token: o.token });
  assert.equal(list.body.data.branches.length, 15);
  const free = await t.createRestaurantOwner(); // the free plan allows one branch
  await newBranch(free);
  assert.equal((await post(free, '/api/manage/branches', branchBody())).status, 402);
});

test('stock is independent per branch, edits never leak between branches, and the summary shows low / out', async () => {
  const o = await bigOwner();
  const a = await newBranch(o, { name: 'A' });
  const b = await newBranch(o, { name: 'B' });
  const burger = await dish(o);
  assert.equal((await setStock(o, 'dishes', burger.id, a.id, { quantity: 50 })).status, 200);
  assert.equal((await setStock(o, 'dishes', burger.id, b.id, { quantity: 15, lowStockThreshold: 20 })).status, 200);
  assert.equal((await stockOf(o, a.id, burger.id)).quantity, 50);
  assert.equal((await stockOf(o, b.id, burger.id)).quantity, 15);

  assert.equal((await setStock(o, 'dishes', burger.id, a.id, { restockBy: 5 })).body.data.item.quantity, 55);
  assert.equal((await stockOf(o, b.id, burger.id)).quantity, 15); // B untouched by changes at A

  const sum = (await t.call('GET', '/api/manage/stock/branches', { token: o.token })).body.data.branches;
  assert.equal(sum.find((x) => x.id === a.id).ok, 1);
  assert.equal(sum.find((x) => x.id === b.id).low, 1); // 15 <= its threshold of 20
  assert.equal((await stockOf(o, b.id, burger.id)).state, 'low');
  await setStock(o, 'dishes', burger.id, b.id, { quantity: 0 });
  assert.equal((await stockOf(o, b.id, burger.id)).state, 'out');

  // validation + tenancy of the stock endpoint
  assert.equal((await setStock(o, 'dishes', burger.id, a.id, { quantity: -1 })).status, 400);
  assert.equal((await setStock(o, 'dishes', burger.id, a.id, { quantity: 1, restockBy: 1 })).status, 400);
  const other = await t.createRestaurantOwner();
  const ob = await newBranch(other);
  assert.equal((await setStock(other, 'dishes', burger.id, ob.id, { quantity: 9 })).status, 404); // not their dish
  assert.equal((await setStock(other, 'dishes', burger.id, a.id, { quantity: 9 })).status, 404); // not their branch

  // general extras have independent branch stock too
  const x = (await post(o, '/api/manage/extras', { nameAr: 'مياه', nameEn: 'Water', category: 'drinks', priceCents: 300, trackStock: true })).body.data.extra;
  await setStock(o, 'extras', x.id, a.id, { quantity: 7 });
  await setStock(o, 'extras', x.id, b.id, { quantity: 1 });
  assert.equal((await stockOf(o, a.id, x.id, 'extra')).quantity, 7);
  assert.equal((await stockOf(o, b.id, x.id, 'extra')).quantity, 1);
});

test('orders use the stock of the fulfilling branch only; oversell, restore-once and no cross-branch fallback', async () => {
  const o = await bigOwner();
  const a = await newBranch(o, { name: 'A', latitude: 24.0, longitude: 46.0 });
  const b = await newBranch(o, { name: 'B', latitude: 21.0, longitude: 39.0 });
  const d = await dish(o);
  await setStock(o, 'dishes', d.id, a.id, { quantity: 3 });
  await setStock(o, 'dishes', d.id, b.id, { quantity: 10 });
  const c = await t.registerCustomer();
  const pub = (branchId) => t.call('GET', `/api/public/restaurants/${o.restaurant.slug}${branchId ? `?branchId=${branchId}` : ''}`);

  // the menu shows that branch's quantity
  assert.equal((await pub(a.id)).body.data.products.find((p) => p.id === d.id).stockQuantity, 3);
  assert.equal((await pub(b.id)).body.data.products.find((p) => p.id === d.id).stockQuantity, 10);
  assert.equal((await pub()).body.data.branches.length, 2);

  // several branches and no choice: the customer must pick one (no silent default)
  const none = await t.placeOrder(o, c, [{ productId: d.id, quantity: 1 }]);
  assert.equal(none.status, 422); assert.equal(none.body.error.code, 'branch_required');

  // too many for branch A, even though B has plenty
  const over = await t.placeOrder(o, c, [{ productId: d.id, quantity: 4 }], { branchId: a.id });
  assert.equal(over.status, 422); assert.equal(over.body.error.code, 'insufficient_stock');

  const ok = await t.placeOrder(o, c, [{ productId: d.id, quantity: 2 }], { branchId: a.id });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.body.data.order.branchId, a.id);
  assert.equal((await stockOf(o, a.id, d.id)).quantity, 1);
  assert.equal((await stockOf(o, b.id, d.id)).quantity, 10); // B untouched

  // nearest branch for a delivery with coordinates (B is closer to 21.1, 39.1)
  const near = await t.placeOrder(o, c, [{ productId: d.id, quantity: 1 }], { orderType: 'delivery', deliveryAddress: '12 Some Street', latitude: 21.1, longitude: 39.1 });
  assert.equal(near.status, 201, near.text);
  assert.equal(near.body.data.order.branchId, b.id);
  assert.equal((await stockOf(o, b.id, d.id)).quantity, 9);

  // a branch of another restaurant is refused
  const other = await t.createRestaurantOwner();
  const foreign = await newBranch(other);
  const bad = await t.placeOrder(o, c, [{ productId: d.id, quantity: 1 }], { branchId: foreign.id });
  assert.equal(bad.status, 422); assert.equal(bad.body.error.code, 'invalid_branch');

  // cancelling gives the units back to the SAME branch, exactly once, however often the restore runs
  const orderId = ok.body.data.order.id;
  const inv = require('../server/services/inventory');
  assert.equal(inv.restoreForOrder(t.db, orderId, o.restaurant.id), 2);
  assert.equal(inv.restoreForOrder(t.db, orderId, o.restaurant.id), 0);
  assert.equal((await stockOf(o, a.id, d.id)).quantity, 3);
  const cancel = await t.call('POST', `/api/me/orders/${orderId}/cancel`, { token: c.token });
  assert.equal(cancel.status, 200, cancel.text);
  assert.equal((await stockOf(o, a.id, d.id)).quantity, 3); // not restored a second time

  // no stock at a branch: not served from another branch
  await setStock(o, 'dishes', d.id, a.id, { quantity: 0 });
  const none2 = await t.placeOrder(o, c, [{ productId: d.id, quantity: 1 }], { branchId: a.id });
  assert.equal(none2.status, 422); assert.equal(none2.body.error.code, 'out_of_stock');
  // a branch can switch a dish off on its own
  await setStock(o, 'dishes', d.id, b.id, { isAvailable: false });
  const off = await t.placeOrder(o, c, [{ productId: d.id, quantity: 1 }], { branchId: b.id });
  assert.equal(off.status, 422); assert.equal(off.body.error.code, 'item_unavailable');
});

test('concurrent orders cannot oversell a branch', async () => {
  const o = await bigOwner();
  const a = await newBranch(o);
  const d = await dish(o);
  await setStock(o, 'dishes', d.id, a.id, { quantity: 3 });
  const customers = await Promise.all([1, 2, 3, 4, 5, 6].map(() => t.registerCustomer()));
  const results = await Promise.all(customers.map((c) => t.placeOrder(o, c, [{ productId: d.id, quantity: 1 }], { branchId: a.id })));
  assert.equal(results.filter((r) => r.status === 201).length, 3);
  assert.equal(results.filter((r) => r.status === 422).length, 3);
  assert.equal((await stockOf(o, a.id, d.id)).quantity, 0);
});

test('a single branch is used automatically; a restaurant without branches keeps dish-level stock', async () => {
  const plain = await t.createRestaurantOwner();
  const d0 = await dish(plain, { stockQuantity: 4 });
  const c = await t.registerCustomer();
  assert.equal((await t.placeOrder(plain, c, [{ productId: d0.id, quantity: 3 }])).status, 201);
  assert.equal(t.db.prepare('SELECT stock_quantity q FROM products WHERE id = ?').get(d0.id).q, 1);

  // the first branch takes over the stock that was kept on the dish
  const b1 = await newBranch(plain);
  assert.equal((await stockOf(plain, b1.id, d0.id)).quantity, 1);
  const r = await t.placeOrder(plain, c, [{ productId: d0.id, quantity: 1 }]); // no branchId: the only branch
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.data.order.branchId, b1.id);
  assert.equal((await stockOf(plain, b1.id, d0.id)).quantity, 0);
  // the dish form keeps working for a single branch: its quantity is the branch quantity
  assert.equal((await t.call('PUT', `/api/manage/products/${d0.id}`, { token: plain.token, body: { stockQuantity: 9 } })).status, 200);
  assert.equal((await stockOf(plain, b1.id, d0.id)).quantity, 9);
});

test('legacy stock is only reported (never guessed) when a restaurant already has several branches', async () => {
  const o = await bigOwner();
  const d = await dish(o, { stockQuantity: 12 }); // legacy quantity on the dish
  // two branches exist from before (inserted directly, like rows that pre-date the migration)
  t.db.prepare('INSERT INTO branches (restaurant_id, name) VALUES (?,?)').run(o.restaurant.id, 'Old A');
  t.db.prepare('INSERT INTO branches (restaurant_id, name) VALUES (?,?)').run(o.restaurant.id, 'Old B');
  const [ba, bb] = (await t.call('GET', '/api/manage/branches', { token: o.token })).body.data.branches;
  const sum = (await t.call('GET', '/api/manage/stock/branches', { token: o.token })).body.data;
  assert.equal(sum.legacy.ambiguous, true);
  assert.equal(sum.legacy.unassignedDishes, 1);
  assert.equal((await stockOf(o, ba.id, d.id)).quantity, 0);
  // the dish form cannot silently set a per-branch quantity
  assert.equal((await t.call('PUT', `/api/manage/products/${d.id}`, { token: o.token, body: { stockQuantity: 5 } })).status, 409);
  // the owner decides where the legacy stock goes
  const adopt = await post(o, '/api/manage/stock/adopt-legacy', { branchId: bb.id });
  assert.equal(adopt.body.data.adopted.dishes, 1);
  assert.equal((await stockOf(o, bb.id, d.id)).quantity, 12);
  assert.equal((await stockOf(o, ba.id, d.id)).quantity, 0);
  assert.equal((await t.call('GET', '/api/manage/stock/branches', { token: o.token })).body.data.legacy.ambiguous, false);
});

test('a branch with orders is deactivated, not deleted; deactivated branches are not offered', async () => {
  const o = await bigOwner();
  const a = await newBranch(o, { name: 'A' });
  await newBranch(o, { name: 'B' });
  const d = await t.addProduct(o); // untracked dish
  const c = await t.registerCustomer();
  assert.equal((await t.placeOrder(o, c, [{ productId: d.id, quantity: 1 }], { branchId: a.id })).status, 201);
  const del = await t.call('DELETE', `/api/manage/branches/${a.id}`, { token: o.token });
  assert.equal(del.status, 409); assert.equal(del.body.error.code, 'branch_has_orders');
  await t.call('PUT', `/api/manage/branches/${a.id}`, { token: o.token, body: { isActive: false } });
  const pub = await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`);
  assert.equal(pub.body.data.branches.length, 1);
  assert.equal((await t.placeOrder(o, c, [{ productId: d.id, quantity: 1 }], { branchId: a.id })).status, 422);
});

// ------------------------------------------------------------------------------------------------ discounts
const rule = (o, body) => t.call('POST', '/api/manage/discounts', { token: o.token, body: { nameAr: 'خصم', nameEn: 'Sale', ...body } });
const menu = async (o) => Object.fromEntries((await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`)).body.data.products.map((p) => [p.id, p]));

test('discount rules: dish, category and whole-menu scopes with deterministic precedence and no stacking', async () => {
  const o = await t.createRestaurantOwner();
  const cat = (await post(o, '/api/manage/categories', { nameAr: 'بيتزا', nameEn: 'Pizza' })).body.data.category;
  const burger = await t.addProduct(o, { priceCents: 2000 });
  const pizza = await t.addProduct(o, { priceCents: 3000, categoryId: cat.id });
  const pizza2 = await t.addProduct(o, { priceCents: 5000, categoryId: cat.id });
  const manual = await t.addProduct(o, { priceCents: 1000, discountedPriceCents: 800 });

  // 10 % over the whole menu
  const all = await rule(o, { scope: 'restaurant', kind: 'percent', percent: 10 });
  assert.equal(all.status, 201, all.text);
  let m = await menu(o);
  assert.deepEqual([m[burger.id].priceCents, m[burger.id].originalPriceCents, m[burger.id].hasDiscount], [1800, 2000, true]);
  assert.deepEqual([m[pizza.id].priceCents, m[pizza2.id].priceCents], [2700, 4500]);
  assert.equal(m[manual.id].priceCents, 800); // a dish's own discount is left alone, never stacked

  // 15 % off the Pizza category beats the menu-wide rule (more specific)
  await rule(o, { scope: 'category', categoryId: cat.id, kind: 'percent', percent: 15 });
  m = await menu(o);
  assert.deepEqual([m[pizza.id].priceCents, m[pizza2.id].priceCents, m[burger.id].priceCents], [2550, 4250, 1800]);

  // 20 % off one dish beats both
  const one = await rule(o, { scope: 'product', productIds: [pizza.id], kind: 'percent', percent: 20 });
  assert.equal(one.status, 201, one.text);
  m = await menu(o);
  assert.deepEqual([m[pizza.id].priceCents, m[pizza2.id].priceCents], [2400, 4250]);
  assert.equal(m[pizza.id].discountRuleId, one.body.data.rule.id);

  // the order snapshot uses exactly the displayed price
  const c = await t.registerCustomer();
  const r = await t.placeOrder(o, c, [{ productId: pizza.id, quantity: 2 }, { productId: burger.id, quantity: 1 }]);
  assert.equal(r.status, 201, r.text);
  const lines = r.body.data.order.items;
  assert.deepEqual(lines.map((l) => [l.baseUnitPriceCents, l.originalUnitPriceCents, l.lineTotalCents]), [[2400, 3000, 4800], [1800, 2000, 1800]]);
  assert.equal(r.body.data.order.subtotalCents, 6600);
  assert.equal(lines[0].discountRuleId, one.body.data.rule.id);

  // changing the broad rule updates every eligible dish without editing dishes
  await t.call('PUT', `/api/manage/discounts/${all.body.data.rule.id}`, { token: o.token, body: { percent: 50 } });
  m = await menu(o);
  assert.equal(m[burger.id].priceCents, 1000);
  assert.equal(t.db.prepare('SELECT price_cents p FROM products WHERE id = ?').get(burger.id).p, 2000); // the dish row itself never changed
  // listing explains who is affected
  const list = (await t.call('GET', '/api/manage/discounts', { token: o.token })).body.data.rules;
  assert.equal(list.find((x) => x.scope === 'restaurant').affectedCount, 1); // only the burger; the rest are taken by more specific rules / manual price
  // deleting a rule restores the list price
  await t.call('DELETE', `/api/manage/discounts/${all.body.data.rule.id}`, { token: o.token });
  assert.equal((await menu(o))[burger.id].priceCents, 2000);
});

test('discount rules: validation, fixed amounts, schedule, usage limit and tenant isolation', async () => {
  const o = await t.createRestaurantOwner();
  const d = await t.addProduct(o, { priceCents: 1000 });
  const bad = async (body, status = 400) => assert.equal((await rule(o, body)).status, status, JSON.stringify(body));
  await bad({ scope: 'restaurant', kind: 'percent', percent: 0 });
  await bad({ scope: 'restaurant', kind: 'percent', percent: 95 });
  await bad({ scope: 'restaurant', kind: 'percent', percent: 10.555 });
  await bad({ scope: 'restaurant', kind: 'fixed', amountCents: 0 });
  await bad({ scope: 'product', productIds: [d.id], kind: 'fixed', amountCents: 1000 });   // would make the price zero
  await bad({ scope: 'product', productIds: [d.id], kind: 'fixed', amountCents: 5000 });   // negative price
  await bad({ scope: 'product', productIds: [], kind: 'percent', percent: 5 });
  await bad({ scope: 'product', productIds: [999999], kind: 'percent', percent: 5 });
  await bad({ scope: 'category', kind: 'percent', percent: 5 });
  await bad({ scope: 'category', categoryId: 999999, kind: 'percent', percent: 5 });
  await bad({ scope: 'restaurant', kind: 'percent', percent: 5, nameEn: '' });
  await bad({ scope: 'restaurant', kind: 'percent', percent: 5, startsAt: '2030-01-02T00:00:00Z', endsAt: '2030-01-01T00:00:00Z' });
  await bad({ scope: 'restaurant', kind: 'percent', percent: 5, startsAt: 'not a date' });
  await bad({ scope: 'weird', kind: 'percent', percent: 5 });

  // another restaurant's dishes / categories cannot be targeted
  const other = await t.createRestaurantOwner();
  const foreign = await t.addProduct(other, { priceCents: 1000 });
  await bad({ scope: 'product', productIds: [foreign.id], kind: 'percent', percent: 5 });

  // a fixed amount; dishes cheaper than the amount are skipped, never priced at zero or below
  const cheap = await t.addProduct(o, { priceCents: 150 });
  const fixed = await rule(o, { scope: 'restaurant', kind: 'fixed', amountCents: 200 });
  assert.equal(fixed.status, 201, fixed.text);
  let m = await menu(o);
  assert.deepEqual([m[d.id].priceCents, m[cheap.id].priceCents], [800, 150]);
  await t.call('DELETE', `/api/manage/discounts/${fixed.body.data.rule.id}`, { token: o.token });

  // not yet started / already ended / inactive rules are not applied
  const future = await rule(o, { scope: 'restaurant', kind: 'percent', percent: 50, startsAt: new Date(Date.now() + 86400000).toISOString() });
  const past = await rule(o, { scope: 'restaurant', kind: 'percent', percent: 50, startsAt: new Date(Date.now() - 2 * 86400000).toISOString(), endsAt: new Date(Date.now() - 86400000).toISOString() });
  const off = await rule(o, { scope: 'restaurant', kind: 'percent', percent: 50, isActive: false });
  m = await menu(o);
  assert.equal(m[d.id].priceCents, 1000);
  const statuses = (await t.call('GET', '/api/manage/discounts', { token: o.token })).body.data.rules.map((r) => r.status).sort();
  assert.deepEqual(statuses, ['expired', 'inactive', 'scheduled']);
  for (const r of [future, past, off]) await t.call('DELETE', `/api/manage/discounts/${r.body.data.rule.id}`, { token: o.token });

  // usage limit: the offer ends after N orders
  const lim = await rule(o, { scope: 'restaurant', kind: 'percent', percent: 50, usageLimit: 2, maxUsesPerCustomer: null }); // null = no per-customer limit: this test is about the TOTAL limit
  const c = await t.registerCustomer();
  assert.equal((await t.placeOrder(o, c, [{ productId: d.id, quantity: 1 }])).body.data.order.subtotalCents, 500);
  assert.equal((await t.placeOrder(o, c, [{ productId: d.id, quantity: 1 }])).body.data.order.subtotalCents, 500);
  assert.equal((await t.placeOrder(o, c, [{ productId: d.id, quantity: 1 }])).body.data.order.subtotalCents, 1000); // exhausted
  assert.equal((await t.call('GET', '/api/manage/discounts', { token: o.token })).body.data.rules.find((r) => r.id === lim.body.data.rule.id).status, 'exhausted');

  // rules are invisible to and untouchable by other restaurants and by staff/customers
  const x = await rule(o, { scope: 'restaurant', kind: 'percent', percent: 10 });
  const xid = x.body.data.rule.id;
  assert.equal((await t.call('GET', '/api/manage/discounts', { token: other.token })).body.data.rules.length, 0);
  assert.equal((await t.call('PUT', `/api/manage/discounts/${xid}`, { token: other.token, body: { percent: 90 } })).status, 404);
  assert.equal((await t.call('DELETE', `/api/manage/discounts/${xid}`, { token: other.token })).status, 404);
  assert.equal((await menu(other))[foreign.id].priceCents, 1000);
  assert.equal((await t.call('GET', '/api/manage/discounts', { token: c.token })).status, 403);
});

// ------------------------------------------------------------------------------------------------ registration with branches
async function newOwnerToken() {
  const email = `${t.unique('owner')}@t.test`;
  const r = await t.call('POST', '/api/auth/register-owner', { body: { name: 'Olive', email, phone: '+966500000000', password: t.PASSWORD } });
  return r.body.data.token;
}
const regBody = (branches, over = {}) => ({ name: t.unique('Chain'), city: 'Riyadh', latitude: 24.7, longitude: 46.7, ...(branches ? { branches } : {}), ...over });

test('registration creates the restaurant and every map-selected branch atomically', async () => {
  const token = await newOwnerToken();
  const branches = Array.from({ length: 15 }, (_, i) => ({ name: `Branch ${i + 1}`, address: `Street ${i + 1}`, phone: '+966500000001', latitude: 24 + i / 10, longitude: 46 + i / 10, addressComponents: { city: 'Riyadh' } }));
  const r = await t.call('POST', '/api/onboarding/restaurant', { token, body: regBody(branches) });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.data.restaurant.branchCount, 15);
  const rows = t.db.prepare('SELECT * FROM branches WHERE restaurant_id = ? ORDER BY id').all(r.body.data.restaurant.id);
  assert.equal(rows.length, 15);
  assert.deepEqual([rows[14].latitude, rows[14].longitude, rows[3].name], [25.4, 47.4, 'Branch 4']);
  const rest = t.db.prepare('SELECT latitude, longitude FROM restaurants WHERE id = ?').get(r.body.data.restaurant.id);
  assert.deepEqual([rest.latitude, rest.longitude], [24.7, 46.7]);
  // saved and reloaded through the dashboard API
  const me = await t.call('GET', '/api/manage/branches', { token });
  assert.equal(me.body.data.branches.length, 15);
});

test('registration is all-or-nothing: an invalid branch creates nothing and the owner can retry', async () => {
  const token = await newOwnerToken();
  const good = { name: 'Ok', latitude: 24.7, longitude: 46.7 };
  const cases = [
    [{ ...good, latitude: 95 }, 'latitude'], [{ name: 'No location' }, 'latitude'], [{ ...good, longitude: undefined }, 'longitude'], [{ ...good, name: '' }, 'name'],
  ];
  for (const [badBranch, field] of cases) {
    const r = await t.call('POST', '/api/onboarding/restaurant', { token, body: regBody([good, badBranch]) });
    assert.equal(r.status, 400, JSON.stringify(badBranch));
    assert.match(r.body.error.details.field, new RegExp(`branches\\[1\\]\\.${field}`));
  }
  assert.equal((await t.call('POST', '/api/onboarding/restaurant', { token, body: regBody([good, good]) })).status, 400); // the same branch twice
  assert.equal((await t.call('POST', '/api/onboarding/restaurant', { token, body: regBody(null, { latitude: 24.7, longitude: undefined }) })).status, 400);
  const me = await t.call('GET', '/api/auth/me', { token });
  assert.equal(me.body.data.user.restaurantId ?? null, null); // nothing was created
  const ok = await t.call('POST', '/api/onboarding/restaurant', { token, body: regBody([good]) });
  assert.equal(ok.status, 201, ok.text);
});

test('registration retries do not duplicate the restaurant or its branches', async () => {
  const token = await newOwnerToken();
  const body = regBody([{ name: 'Main', latitude: 24.7, longitude: 46.7 }, { name: 'Second', latitude: 24.8, longitude: 46.8 }]);
  const key = `reg-${t.unique('k')}`;
  const first = await t.call('POST', '/api/onboarding/restaurant', { token, body, headers: { 'Idempotency-Key': key } });
  const again = await t.call('POST', '/api/onboarding/restaurant', { token, body, headers: { 'Idempotency-Key': key } });
  assert.equal(first.status, 201); assert.equal(again.status, 201);
  assert.equal(again.body.data.restaurant.id, first.body.data.restaurant.id);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM branches WHERE restaurant_id = ?').get(first.body.data.restaurant.id).c, 2);
  // without a key, a repeated request is refused outright
  const plain = await t.call('POST', '/api/onboarding/restaurant', { token, body });
  assert.equal(plain.status, 409); assert.equal(plain.body.error.code, 'already_onboarded');
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM branches WHERE restaurant_id = ?').get(first.body.data.restaurant.id).c, 2);
});

test('the map library is served from our own origin (strict CSP, no CDN) and the new pages are wired', async () => {
  const js = await fetch(t.base + '/vendor/leaflet/leaflet.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(t.base + '/vendor/leaflet/leaflet.css')).status, 200);
  const csp = (await fetch(t.base + '/')).headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  // OpenStreetMap tiles answer 403 to requests without a Referer, so the app must not send `Referrer-Policy: no-referrer`
  assert.equal((await fetch(t.base + '/')).headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.doesNotMatch(csp, /unpkg|cdn/);
  for (const f of ['map-picker.js', 'branch-editor.js', 'menu-import.js', 'menu-stock.js', 'menu-discounts.js', 'locales/en/mgmt.js', 'locales/ar/mgmt.js']) {
    assert.equal((await fetch(`${t.base}/js/${f}`)).status, 200, f);
  }
  // registration page keeps the existing single-page wizard entry
  assert.match(await (await fetch(t.base + '/onboarding.html')).text(), /onboarding\.js/);
});

test('address search is configurable and degrades gracefully; the map config is public', async () => {
  const cfg = await t.call('GET', '/api/public/config');
  assert.match(cfg.body.data.map.tileUrl, /\{z\}\/\{x\}\/\{y\}/);
  const token = await newOwnerToken();
  assert.equal((await t.call('GET', '/api/geo/search?q=ab', { token })).status, 400);
  assert.equal((await t.call('GET', '/api/geo/search?q=riyadh')).status, 401);
  assert.equal((await t.call('GET', '/api/geo/reverse?lat=999&lon=1', { token })).status, 400);
  const saved = t.config.geocoder.url;
  try {
    t.config.geocoder.url = '';
    const off = await t.call('GET', '/api/geo/search?q=riyadh', { token });
    assert.equal(off.status, 503); assert.equal(off.body.error.code, 'geocoder_disabled');
    t.config.geocoder.url = 'http://127.0.0.1:9'; // nothing listens there: a network failure must not become a 500
    const down = await t.call('GET', '/api/geo/search?q=jeddah+road', { token });
    assert.equal(down.status, 503); assert.equal(down.body.error.code, 'geocoder_unavailable');
  } finally { t.config.geocoder.url = saved; }
});
