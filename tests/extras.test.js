// General (order-level) extras: restaurant-owned items a customer adds to an order without choosing a dish. Covers the owner API, tenancy,
// server-side pricing, stock, snapshots, mixed orders (dish + dish extras + general extras) and the per-account language preference.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

let t;
before(async () => { t = await startApp(); });
after(async () => { await t.close(); });

const extraBody = (over = {}) => ({
  nameAr: 'مياه معبأة', nameEn: 'Bottled water', descriptionAr: 'زجاجة 500 مل', descriptionEn: '500 ml bottle', category: 'drinks', priceCents: 300, ...over,
});
const createExtra = async (owner, over) => {
  const r = await t.call('POST', '/api/manage/extras', { token: owner.token, body: extraBody(over) });
  assert.equal(r.status, 201, r.text);
  return r.body.data.extra;
};
const dish = async (owner, over = {}) => (await t.call('POST', '/api/manage/products', {
  token: owner.token,
  body: { nameAr: 'برغر', nameEn: 'Burger', descriptionAr: 'برغر لحم', descriptionEn: 'Beef burger', originalPriceCents: 2500, ...over },
})).body.data;
const extraRow = (id) => t.db.prepare('SELECT * FROM restaurant_extras WHERE id = ?').get(id);

test('owner creates, lists, edits, switches and deletes general extras (bilingual, categories)', async () => {
  const o = await t.createRestaurantOwner();
  const x = await createExtra(o);
  assert.deepEqual([x.nameAr, x.nameEn, x.descriptionAr, x.descriptionEn, x.category, x.priceCents, x.isAvailable, x.trackStock, x.orderable],
    ['مياه معبأة', 'Bottled water', 'زجاجة 500 مل', '500 ml bottle', 'drinks', 300, true, false, true]);
  assert.equal(x.name, 'Bottled water'); // canonical / fallback text = English

  // descriptions are optional; every category is accepted
  for (const category of ['sides', 'sauces', 'other']) {
    const e = await createExtra(o, { nameAr: `ع ${category}`, nameEn: category, category, descriptionAr: undefined, descriptionEn: undefined, priceCents: 0 });
    assert.deepEqual([e.category, e.descriptionAr, e.priceCents], [category, '', 0]);
  }
  const list = await t.call('GET', '/api/manage/extras', { token: o.token });
  assert.equal(list.body.data.extras.length, 4);
  assert.deepEqual(list.body.data.categories, ['drinks', 'sides', 'sauces', 'other']);

  // validation: both names, a known category, a whole non-negative price
  const bad = async (over, field) => {
    const r = await t.call('POST', '/api/manage/extras', { token: o.token, body: extraBody(over) });
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.equal(r.body.error.details.field, field);
  };
  await bad({ nameAr: '' }, 'nameAr');
  await bad({ nameEn: undefined }, 'nameEn');
  await bad({ category: 'desserts' }, 'category');
  await bad({ priceCents: -1 }, 'priceCents');
  await bad({ priceCents: 1.5 }, 'priceCents');
  await bad({ maxQuantity: 0 }, 'maxQuantity');
  await bad({ maxQuantity: 51 }, 'maxQuantity');
  await bad({ imageUrl: 'javascript:alert(1)' }, 'imageUrl');

  // edit keeps what is not sent
  const up = await t.call('PUT', `/api/manage/extras/${x.id}`, { token: o.token, body: { priceCents: 350, category: 'other' } });
  assert.equal(up.status, 200, up.text);
  assert.deepEqual([up.body.data.extra.priceCents, up.body.data.extra.category, up.body.data.extra.nameAr], [350, 'other', 'مياه معبأة']);

  // availability
  assert.equal((await t.call('PATCH', `/api/manage/extras/${x.id}/availability`, { token: o.token, body: { isAvailable: false } })).status, 200);
  assert.equal(extraRow(x.id).is_available, 0);

  assert.equal((await t.call('DELETE', `/api/manage/extras/${x.id}`, { token: o.token })).status, 200);
  assert.equal(extraRow(x.id), undefined);
  assert.equal((await t.call('DELETE', `/api/manage/extras/${x.id}`, { token: o.token })).status, 404);
  assert.equal((await t.call('GET', '/api/manage/extras', { token: o.token })).body.data.extras.length, 3);
});

test('an owner only ever manages their own restaurant\'s extras; staff may switch and restock but not edit; customers are refused', async () => {
  const a = await t.createRestaurantOwner('A');
  const b = await t.createRestaurantOwner('B');
  const customer = await t.registerCustomer();
  const xa = await createExtra(a, { trackStock: true, stockQuantity: 5 });

  for (const [method, url, body] of [
    ['PUT', `/api/manage/extras/${xa.id}`, extraBody()], ['DELETE', `/api/manage/extras/${xa.id}`],
    ['PATCH', `/api/manage/extras/${xa.id}/availability`, { isAvailable: false }], ['PATCH', `/api/manage/extras/${xa.id}/stock`, { restockBy: 1 }],
  ]) {
    assert.equal((await t.call(method, url, { token: b.token, body })).status, 404, `owner B ${method} ${url}`);
    assert.equal((await t.call(method, url, { token: customer.token, body })).status, 403, `customer ${method} ${url}`);
  }
  assert.equal((await t.call('GET', '/api/manage/extras', { token: b.token })).body.data.extras.length, 0);
  assert.equal((await t.call('GET', '/api/manage/extras')).status, 401);
  assert.equal(extraRow(xa.id).stock_quantity, 5);

  // B's customer cannot order A's extra through B (ids are checked together with the restaurant)
  const r = await t.placeOrder(b, customer, [], { extras: [{ extraId: xa.id, quantity: 1 }] });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'invalid_extra');

  // staff: availability + stock yes, create / edit / delete no
  const s = await t.call('POST', '/api/manage/staff', { token: a.token, body: { name: 'Sam', email: `${t.unique('s')}@t.test`, password: 'Passw0rd!' } });
  const staff = (await t.call('POST', '/api/auth/login', { body: { email: s.body.data.staff.email, password: 'Passw0rd!' } })).body.data.token;
  assert.equal((await t.call('GET', '/api/manage/extras', { token: staff })).status, 200);
  assert.equal((await t.call('PATCH', `/api/manage/extras/${xa.id}/stock`, { token: staff, body: { restockBy: 2 } })).status, 200);
  assert.equal(extraRow(xa.id).stock_quantity, 7);
  assert.equal((await t.call('PATCH', `/api/manage/extras/${xa.id}/availability`, { token: staff, body: { isAvailable: false } })).status, 200);
  for (const [method, url, body] of [['POST', '/api/manage/extras', extraBody()], ['PUT', `/api/manage/extras/${xa.id}`, extraBody()], ['DELETE', `/api/manage/extras/${xa.id}`]]) {
    assert.equal((await t.call(method, url, { token: staff, body })).status, 403, `staff ${method} ${url}`);
  }
});

test('the public menu lists the extras that are switched on, in both languages, with no owner-only data leaking from other restaurants', async () => {
  const o = await t.createRestaurantOwner();
  const other = await t.createRestaurantOwner('Other');
  const water = await createExtra(o);
  const off = await createExtra(o, { nameAr: 'مخفي', nameEn: 'Hidden', isAvailable: false });
  await createExtra(other, { nameEn: 'Not mine', nameAr: 'ليس لي' });
  const pub = await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`);
  const ids = pub.body.data.extras.map((e) => e.id);
  assert.deepEqual(ids, [water.id]);
  assert.ok(!ids.includes(off.id));
  assert.deepEqual([pub.body.data.extras[0].nameAr, pub.body.data.extras[0].nameEn, pub.body.data.extras[0].category], ['مياه معبأة', 'Bottled water', 'drinks']);
});

test('mixed order: a dish with its own extras plus independent general extras are separate priced lines, totalled from the database', async () => {
  const o = await t.createRestaurantOwner();
  const c = await t.registerCustomer();
  const burger = await dish(o, { optionGroups: [{ nameAr: 'إضافات', nameEn: 'Extras', options: [{ nameAr: 'جبن', nameEn: 'Cheese', priceCents: 500, maxQuantity: 2 }] }] });
  const cheese = burger.optionGroups[0].options[0];
  const water = await createExtra(o, { priceCents: 300 });
  const fries = await createExtra(o, { nameAr: 'بطاطس', nameEn: 'French fries', category: 'sides', priceCents: 800 });
  const garlic = await createExtra(o, { nameAr: 'صلصة الثوم', nameEn: 'Garlic sauce', category: 'sauces', priceCents: 200 });

  const r = await t.placeOrder(o, c, [{ productId: burger.product.id, quantity: 1, options: [{ optionId: cheese.id, quantity: 1 }] }], {
    // the browser may send prices; they are ignored
    extras: [{ extraId: water.id, quantity: 2, priceCents: 1 }, { extraId: fries.id, quantity: 1 }, { extraId: garlic.id, quantity: 2 }, { extraId: water.id, quantity: 1 }],
  });
  assert.equal(r.status, 201, r.text);
  const order = r.body.data.order;
  // burger 25.00 + cheese 5.00 = 30.00 ; water 3 x 3.00 = 9.00 ; fries 8.00 ; garlic 2 x 2.00 = 4.00  -> 51.00
  assert.equal(order.subtotalCents, 3000 + 900 + 800 + 400);
  assert.equal(order.totalCents, 5100);
  assert.equal(order.items.length, 4);
  const byKind = (k) => order.items.filter((i) => i.kind === k);
  assert.equal(byKind('dish').length, 1);
  assert.equal(byKind('dish')[0].options[0].nameEn, 'Cheese'); // the dish extra stays attached to the dish
  const lines = Object.fromEntries(byKind('extra').map((i) => [i.nameEn, i]));
  assert.deepEqual([lines['Bottled water'].quantity, lines['Bottled water'].unitPriceCents, lines['Bottled water'].lineTotalCents, lines['Bottled water'].options.length], [3, 300, 900, 0]);
  assert.deepEqual([lines['French fries'].quantity, lines['French fries'].lineTotalCents, lines['French fries'].extraCategory], [1, 800, 'sides']);
  assert.deepEqual([lines['Garlic sauce'].quantity, lines['Garlic sauce'].lineTotalCents, lines['Garlic sauce'].productId], [2, 400, null]);
  // the dish line total is not inflated by the general extras (no double counting)
  assert.equal(byKind('dish')[0].lineTotalCents, 3000);
  assert.equal(order.items.reduce((s, i) => s + i.lineTotalCents, 0), order.subtotalCents);

  // snapshot: renaming / re-pricing / deleting the extras later never rewrites the order
  await t.call('PUT', `/api/manage/extras/${water.id}`, { token: o.token, body: { priceCents: 999, nameEn: 'Mineral water', nameAr: 'مياه معدنية' } });
  await t.call('DELETE', `/api/manage/extras/${fries.id}`, { token: o.token });
  const again = await t.call('GET', `/api/me/orders/${order.id}`, { token: c.token });
  const items = again.body.data.order.items;
  assert.equal(again.body.data.order.totalCents, 5100);
  const w = items.find((i) => i.nameEn === 'Bottled water');
  assert.deepEqual([w.unitPriceCents, w.lineTotalCents, w.nameAr], [300, 900, 'مياه معبأة']);
  const f = items.find((i) => i.nameEn === 'French fries');
  assert.deepEqual([f.lineTotalCents, f.extraId], [800, null]); // still there, just no longer linked

  // the restaurant sees the same separate lines
  const mine = await t.call('GET', '/api/manage/orders', { token: o.token });
  const seen = mine.body.data.orders.find((x) => x.id === order.id);
  assert.deepEqual(seen.items.map((i) => i.kind).sort(), ['dish', 'extra', 'extra', 'extra']);
});

test('an order can consist of general extras only, and still needs at least one line', async () => {
  const o = await t.createRestaurantOwner();
  const c = await t.registerCustomer();
  const water = await createExtra(o);
  const only = await t.placeOrder(o, c, [], { extras: [{ extraId: water.id, quantity: 2 }] });
  assert.equal(only.status, 201, only.text);
  assert.equal(only.body.data.order.totalCents, 600);
  const none = await t.placeOrder(o, c, [], { extras: [] });
  assert.equal(none.status, 400);
  assert.equal(none.body.error.details.reason, 'items_required');
  const junk = await t.placeOrder(o, c, [], { extras: [{ extraId: 'abc', quantity: 1 }] });
  assert.equal(junk.status, 400);
  const zero = await t.placeOrder(o, c, [], { extras: [{ extraId: water.id, quantity: 0 }] });
  assert.equal(zero.status, 400);
});

test('unavailable extras, quantities above the maximum and unknown ids are refused by the server', async () => {
  const o = await t.createRestaurantOwner();
  const c = await t.registerCustomer();
  const water = await createExtra(o, { maxQuantity: 3 });
  const off = await createExtra(o, { nameAr: 'مغلق', nameEn: 'Off', isAvailable: false });
  const place = (extras) => t.placeOrder(o, c, [], { extras });
  let r = await place([{ extraId: off.id, quantity: 1 }]);
  assert.deepEqual([r.status, r.body.error.code], [422, 'extra_unavailable']);
  assert.equal(r.body.error.details.nameAr, 'مغلق'); // lets the UI name it in the visitor's language
  r = await place([{ extraId: water.id, quantity: 4 }]);
  assert.deepEqual([r.status, r.body.error.code, r.body.error.details.max], [422, 'extra_quantity_exceeded', 3]);
  r = await place([{ extraId: water.id, quantity: 2 }, { extraId: water.id, quantity: 2 }]); // duplicates are added together before the check
  assert.equal(r.body.error.code, 'extra_quantity_exceeded');
  r = await place([{ extraId: 99999999, quantity: 1 }]);
  assert.deepEqual([r.status, r.body.error.code], [422, 'invalid_extra']);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM orders WHERE restaurant_id = ?').get(o.restaurant.id).c, 0);
});

test('extra stock: tracked extras are reserved atomically, cannot oversell, and return exactly once when the order is cancelled', async () => {
  const o = await t.createRestaurantOwner();
  const c = await t.registerCustomer();
  const cola = await createExtra(o, { nameAr: 'كولا', nameEn: 'Cola', trackStock: true, stockQuantity: 5 });
  const free = await createExtra(o, { nameAr: 'كاتشب', nameEn: 'Ketchup', category: 'sauces' }); // untracked = unlimited
  const stock = () => extraRow(cola.id).stock_quantity;

  const first = await t.placeOrder(o, c, [], { extras: [{ extraId: cola.id, quantity: 3 }, { extraId: free.id, quantity: 4 }] });
  assert.equal(first.status, 201, first.text);
  assert.equal(stock(), 2);
  assert.equal(extraRow(free.id).stock_quantity, 0); // unlimited extras are never touched

  const over = await t.placeOrder(o, c, [], { extras: [{ extraId: cola.id, quantity: 3 }] });
  assert.deepEqual([over.status, over.body.error.code, over.body.error.details.available], [422, 'insufficient_stock', 2]);
  assert.equal(stock(), 2);
  const rest = await t.placeOrder(o, c, [], { extras: [{ extraId: cola.id, quantity: 2 }] });
  assert.equal(rest.status, 201);
  assert.equal(stock(), 0);
  const gone = await t.placeOrder(o, c, [], { extras: [{ extraId: cola.id, quantity: 1 }] });
  assert.deepEqual([gone.status, gone.body.error.code], [422, 'out_of_stock']);
  assert.equal((await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`)).body.data.extras.find((e) => e.id === cola.id).orderable, false);

  // restaurant rejects the first order: its 3 units come back once, and cancelling again does nothing more
  const id = first.body.data.order.id;
  assert.equal((await t.call('PATCH', `/api/manage/orders/${id}/status`, { token: o.token, body: { status: 'rejected', reason: 'no' } })).status, 200);
  assert.equal(stock(), 3);
  assert.equal((await t.call('PATCH', `/api/manage/orders/${id}/status`, { token: o.token, body: { status: 'cancelled' } })).status, 409);
  assert.equal(stock(), 3);
  // customer cancels the second one
  assert.equal((await t.call('POST', `/api/me/orders/${rest.body.data.order.id}/cancel`, { token: c.token })).status, 200);
  assert.equal(stock(), 5);

  // an order that fails part-way (second line out of stock) takes nothing
  const dishOnly = await dish(o, { trackStock: true, stockQuantity: 0 });
  const mixed = await t.placeOrder(o, c, [{ productId: dishOnly.product.id, quantity: 1 }], { extras: [{ extraId: cola.id, quantity: 1 }] });
  assert.equal(mixed.status, 422);
  assert.equal(stock(), 5);

  // owner restocks with the atomic "add" and via the dashboard endpoint
  const re = await t.call('PATCH', `/api/manage/extras/${cola.id}/stock`, { token: o.token, body: { restockBy: 10 } });
  assert.equal(re.body.data.extra.stockQuantity, 15);
  assert.equal((await t.call('PATCH', `/api/manage/extras/${free.id}/stock`, { token: o.token, body: { restockBy: 1 } })).status, 409); // not tracked
});

test('the minimum order amount counts general extras, and they never appear under "top dishes"', async () => {
  const o = await t.createRestaurantOwner('Pro', 'pro');
  const c = await t.registerCustomer();
  await t.call('PUT', '/api/manage/restaurant', { token: o.token, body: { minOrderCents: 1000 } });
  const water = await createExtra(o);
  const d = await dish(o, { originalPriceCents: 1200 });
  assert.equal((await t.placeOrder(o, c, [], { extras: [{ extraId: water.id, quantity: 2 }] })).body.error.code, 'below_minimum'); // 6.00 < 10.00
  assert.equal((await t.placeOrder(o, c, [], { extras: [{ extraId: water.id, quantity: 4 }] })).status, 201); // 12.00
  assert.equal((await t.placeOrder(o, c, [{ productId: d.product.id, quantity: 1 }], { extras: [{ extraId: water.id, quantity: 1 }] })).status, 201);
  const adv = await t.call('GET', '/api/manage/reports/advanced', { token: o.token });
  assert.equal(adv.status, 200, adv.text);
  assert.deepEqual(adv.body.data.topProducts.map((p) => p.name), ['Burger']);
});

test('language preference is kept on the account and can only be ar or en', async () => {
  const c = await t.registerCustomer();
  assert.equal((await t.call('GET', '/api/auth/me', { token: c.token })).body.data.user.lang, null);
  const r = await t.call('PATCH', '/api/auth/me', { token: c.token, body: { lang: 'ar' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.data.user.lang, 'ar');
  assert.equal(r.body.data.user.name, c.user.name); // nothing else changed
  const login = await t.call('POST', '/api/auth/login', { body: { email: c.user.email, password: c.password } });
  assert.equal(login.body.data.user.lang, 'ar'); // adopted on another device
  const bad = await t.call('PATCH', '/api/auth/me', { token: c.token, body: { lang: 'fr' } });
  assert.deepEqual([bad.status, bad.body.error.details.field], [400, 'lang']);
  assert.equal((await t.call('PATCH', '/api/auth/me', { token: c.token, body: { name: 'New Name' } })).body.data.user.lang, 'ar'); // kept when not sent
});

test('restaurants can publish an Arabic and an English name and description; the canonical text remains the fallback', async () => {
  const o = await t.createRestaurantOwner('Grill');
  const up = await t.call('PUT', '/api/manage/restaurant', { token: o.token, body: { nameAr: 'مشويات الحي', nameEn: 'Local Grill', descriptionAr: 'مشويات طازجة' } });
  assert.equal(up.status, 200, up.text);
  assert.deepEqual([up.body.data.restaurant.nameAr, up.body.data.restaurant.nameEn, up.body.data.restaurant.descriptionAr, up.body.data.restaurant.descriptionEn], ['مشويات الحي', 'Local Grill', 'مشويات طازجة', '']);
  const pub = await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`);
  assert.equal(pub.body.data.restaurant.nameAr, 'مشويات الحي');
  assert.ok(pub.body.data.restaurant.name.startsWith('Grill')); // the original name is untouched
  const list = await t.call('GET', '/api/public/restaurants?q=' + encodeURIComponent('مشويات'));
  assert.ok(list.body.data.restaurants.some((r) => r.slug === o.restaurant.slug)); // the listing search also matches the Arabic name
  const c = await t.registerCustomer();
  const water = await createExtra(o);
  const placed = await t.placeOrder(o, c, [], { extras: [{ extraId: water.id, quantity: 1 }] });
  const detail = await t.call('GET', `/api/me/orders/${placed.body.data.order.id}`, { token: c.token });
  assert.deepEqual([detail.body.data.order.restaurantNameAr, detail.body.data.order.restaurantNameEn], ['مشويات الحي', 'Local Grill']);
});
