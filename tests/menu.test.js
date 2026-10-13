// Registration phone numbers, bilingual dishes, original/discounted prices, stock, extras, special instructions, and the exact price
// formula (unit price + extras x extra quantity) x dish quantity - all enforced by the backend.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { startApp } = require('./helpers');

let t;
before(async () => { t = await startApp(); });
after(async () => { await t.close(); });

const PHONE = '+966500000000';
const localized = (over = {}) => ({
  nameAr: 'برغر', nameEn: 'Burger', descriptionAr: 'برغر لحم مشوي', descriptionEn: 'Grilled beef burger', originalPriceCents: 3000, ...over,
});
const createDish = async (owner, body = localized()) => {
  const r = await t.call('POST', '/api/manage/products', { token: owner.token, body });
  assert.equal(r.status, 201, r.text);
  return r.body.data;
};
const bilingualGroup = (over = {}) => ({
  nameAr: 'إضافات', nameEn: 'Extras', minSelect: 0, maxSelect: 2,
  options: [
    { nameAr: 'جبن إضافي', nameEn: 'Extra cheese', priceCents: 500, maxQuantity: 1 },
    { nameAr: 'طماطم إضافية', nameEn: 'Extra tomatoes', priceCents: 200, maxQuantity: 3 },
  ],
  ...over,
});
const dishRow = (id) => t.db.prepare('SELECT * FROM products WHERE id = ?').get(id);
const stockOf = (id) => dishRow(id).stock_quantity;

// ------------------------------------------------------------------------------------------------------------ registration
test('registration: a mobile number is required for customers and restaurant owners and is stored in international form', async () => {
  for (const [route, label] of [['/api/auth/register', 'customer'], ['/api/auth/register-owner', 'owner']]) {
    const base = { name: 'Ahmed', email: `${t.unique(label)}@t.test`, password: 'Passw0rd!' };
    const missing = await t.call('POST', route, { body: base });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.details.field, 'phone');
    assert.equal(missing.body.error.details.reason, 'required');
    for (const bad of ['12345', '+0123456789', 'abcdefghij', '+9665', '+966500000000000000']) {
      const r = await t.call('POST', route, { body: { ...base, phone: bad } });
      assert.equal(r.status, 400, bad);
      assert.equal(r.body.error.details.reason, 'invalid_mobile', bad);
    }
    // what people really type is normalised: spaces, dashes, a 00 prefix and Arabic-Indic digits
    const ok = await t.call('POST', route, { body: { ...base, phone: '٠٠٩٦٦ ٥٠ ٠٠٠ ٠٠٠٠' } });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.body.data.user.phone, '+966500000000');
    assert.equal(t.db.prepare('SELECT phone FROM users WHERE email = ?').get(base.email).phone, '+966500000000');
  }
});

test('restaurant owner: contact details live on the account; the restaurant keeps its own separate business phone and email', async () => {
  const email = `${t.unique('own')}@t.test`;
  const reg = await t.call('POST', '/api/auth/register-owner', { body: { name: 'Ahmed', email, phone: '+966 50 000 0000', password: 'Passw0rd!' } });
  const token = reg.body.data.token;
  const me = await t.call('GET', '/api/auth/me', { token });
  assert.deepEqual([me.body.data.user.name, me.body.data.user.email, me.body.data.user.phone], ['Ahmed', email, '+966500000000']);
  // the owner corrects name / mobile while registering the restaurant; the business contact is stored separately
  const r = await t.call('POST', '/api/onboarding/restaurant', { token, body: { name: 'Ahmed Grill', ownerName: 'Ahmed Alharbi', ownerPhone: '+966511111111', phone: '+966122222222', email: 'info@ahmedgrill.test' } });
  assert.equal(r.status, 201, r.text);
  const row = t.db.prepare('SELECT r.phone AS rphone, r.email AS remail, u.name, u.phone AS uphone FROM restaurants r JOIN users u ON u.id = r.owner_id WHERE r.id = ?').get(r.body.data.restaurant.id);
  assert.deepEqual({ ...row }, { rphone: '+966122222222', remail: 'info@ahmedgrill.test', name: 'Ahmed Alharbi', uphone: '+966511111111' });
  // an invalid owner mobile is refused and creates nothing
  const t2 = (await t.call('POST', '/api/auth/register-owner', { body: { name: 'B', email: `${t.unique('o2')}@t.test`, phone: PHONE, password: 'Passw0rd!' } })).body.data.token;
  const bad = await t.call('POST', '/api/onboarding/restaurant', { token: t2, body: { name: 'Bad Phone Grill', ownerPhone: '123' } });
  assert.equal(bad.status, 400);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM restaurants WHERE name = 'Bad Phone Grill'").get().n, 0);
});

test('accounts created before mobile numbers were required keep working, and can add theirs', async () => {
  const email = `${t.unique('legacy')}@t.test`;
  t.db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES (?,?,?, 'customer')").run(email, bcrypt.hashSync('Passw0rd!', 4), 'Old Customer');
  const login = await t.call('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.data.user.phone, null);
  assert.equal(login.body.data.user.phoneMissing, true);
  const token = login.body.data.token;
  assert.equal((await t.call('PATCH', '/api/auth/me', { token, body: { phone: 'nope' } })).status, 400);
  const set = await t.call('PATCH', '/api/auth/me', { token, body: { phone: '+971 50 123 4567' } });
  assert.equal(set.body.data.user.phone, '+971501234567');
  assert.equal(set.body.data.user.phoneMissing, false);
  // a legacy OWNER without a number must supply one to register the restaurant
  const oemail = `${t.unique('legacyo')}@t.test`;
  t.db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES (?,?,?, 'owner')").run(oemail, bcrypt.hashSync('Passw0rd!', 4), 'Old Owner');
  const otoken = (await t.call('POST', '/api/auth/login', { body: { email: oemail, password: 'Passw0rd!' } })).body.data.token;
  const need = await t.call('POST', '/api/onboarding/restaurant', { token: otoken, body: { name: 'Legacy Kitchen' } });
  assert.equal(need.status, 400);
  assert.equal(need.body.error.details.field, 'ownerPhone');
  assert.equal((await t.call('POST', '/api/onboarding/restaurant', { token: otoken, body: { name: 'Legacy Kitchen', ownerPhone: PHONE } })).status, 201);
});

test('a signed-in user can only read and change their own profile', async () => {
  const a = await t.registerCustomer();
  const b = await t.registerCustomer();
  await t.call('PATCH', '/api/auth/me', { token: a.token, body: { name: 'Renamed A', userId: b.user.id, id: b.user.id, phone: '+966522222222' } });
  assert.equal(t.db.prepare('SELECT name FROM users WHERE id = ?').get(a.user.id).name, 'Renamed A');
  assert.notEqual(t.db.prepare('SELECT name FROM users WHERE id = ?').get(b.user.id).name, 'Renamed A');
  assert.equal((await t.call('PATCH', '/api/auth/me', { body: { name: 'x' } })).status, 401);
});

// ------------------------------------------------------------------------------------------------------------ bilingual dishes
test('bilingual dishes: both languages are required, stored and returned; legacy single-language dishes keep working', async () => {
  const o = await t.createRestaurantOwner('Bilingual Bistro');
  for (const missing of ['nameAr', 'nameEn', 'descriptionAr', 'descriptionEn']) {
    const r = await t.call('POST', '/api/manage/products', { token: o.token, body: localized({ [missing]: '' }) });
    assert.equal(r.status, 400, missing);
    assert.equal(r.body.error.details.field, missing);
  }
  const { product } = await createDish(o);
  assert.deepEqual([product.nameAr, product.nameEn, product.descriptionAr, product.descriptionEn], ['برغر', 'Burger', 'برغر لحم مشوي', 'Grilled beef burger']);
  assert.equal(product.name, 'Burger'); // canonical fallback text
  assert.deepEqual(product.missingTranslations, []);

  // a dish created the old way (one name) is still there, orderable and flagged as missing translations
  const old = await t.addProduct(o, { name: 'Legacy Soup', priceCents: 450 });
  assert.equal(old.name, 'Legacy Soup');
  assert.equal(old.nameAr, '');
  assert.deepEqual(old.missingTranslations, ['ar', 'en']);
  const pub = await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`);
  const byName = Object.fromEntries(pub.body.data.products.map((p) => [p.name, p]));
  assert.equal(byName.Burger.nameAr, 'برغر');
  assert.equal(byName.Burger.descriptionEn, 'Grilled beef burger');
  assert.equal(byName['Legacy Soup'].priceCents, 450);
  const c = await t.registerCustomer();
  assert.equal((await t.placeOrder(o, c, [{ productId: old.id, quantity: 1 }])).status, 201);

  // completing a legacy dish's translations; a legacy-style name update is refused once the dish has localized text
  const upd = await t.call('PUT', `/api/manage/products/${old.id}`, { token: o.token, body: { nameAr: 'شوربة', nameEn: 'Soup', descriptionAr: 'شوربة ساخنة', descriptionEn: 'Hot soup' } });
  assert.equal(upd.status, 200, upd.text);
  assert.equal(upd.body.data.product.priceCents, 450); // price untouched
  assert.equal((await t.call('PUT', `/api/manage/products/${old.id}`, { token: o.token, body: { name: 'Renamed' } })).status, 400);

  // the order keeps both language snapshots
  const order = await t.placeOrder(o, c, [{ productId: product.id, quantity: 1 }]);
  assert.deepEqual([order.body.data.order.items[0].nameAr, order.body.data.order.items[0].nameEn], ['برغر', 'Burger']);
});

test('bilingual categories', async () => {
  const o = await t.createRestaurantOwner('Cat Cafe');
  const r = await t.call('POST', '/api/manage/categories', { token: o.token, body: { nameAr: 'المشروبات', nameEn: 'Drinks' } });
  assert.equal(r.status, 201);
  assert.equal((await t.call('POST', '/api/manage/categories', { token: o.token, body: { nameAr: 'فقط عربي' } })).status, 400);
  const pub = await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`);
  assert.deepEqual([pub.body.data.categories[0].nameAr, pub.body.data.categories[0].nameEn], ['المشروبات', 'Drinks']);
});

// ------------------------------------------------------------------------------------------------------------ pricing
test('pricing: no discount uses the original price; a discount is validated; the discounted price is what is charged', async () => {
  const o = await t.createRestaurantOwner('Price Place');
  const c = await t.registerCustomer();
  const plain = (await createDish(o, localized({ originalPriceCents: 3000 }))).product;
  assert.deepEqual([plain.priceCents, plain.originalPriceCents, plain.discountedPriceCents, plain.hasDiscount], [3000, 3000, null, false]);

  for (const discountedPriceCents of [0, -100, 3000, 3500, 10.5, 'abc']) {
    const r = await t.call('POST', '/api/manage/products', { token: o.token, body: localized({ originalPriceCents: 3000, discountedPriceCents }) });
    assert.equal(r.status, 400, String(discountedPriceCents));
  }
  assert.equal((await t.call('POST', '/api/manage/products', { token: o.token, body: localized({ originalPriceCents: -1 }) })).status, 400);
  assert.equal((await t.call('POST', '/api/manage/products', { token: o.token, body: localized({ originalPriceCents: 12.5 }) })).status, 400);
  assert.equal((await t.call('POST', '/api/manage/products', { token: o.token, body: localized({ originalPriceCents: undefined }) })).status, 400);

  const sale = (await createDish(o, localized({ nameEn: 'Sale Burger', originalPriceCents: 3000, discountedPriceCents: 2500 }))).product;
  assert.deepEqual([sale.priceCents, sale.originalPriceCents, sale.discountedPriceCents, sale.hasDiscount, sale.discountPercent], [2500, 3000, 2500, true, 17]);
  const pub = await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`);
  const shown = pub.body.data.products.find((p) => p.id === sale.id);
  assert.deepEqual([shown.priceCents, shown.originalPriceCents], [2500, 3000]);

  // the order is charged the discounted price - and a client-supplied price is ignored
  const order = await t.placeOrder(o, c, [{ productId: sale.id, quantity: 2, priceCents: 1, unitPriceCents: 1, originalPriceCents: 1 }]);
  assert.equal(order.status, 201, order.text);
  const line = order.body.data.order.items[0];
  assert.deepEqual([line.unitPriceCents, line.lineTotalCents, line.baseUnitPriceCents, line.originalUnitPriceCents], [2500, 5000, 2500, 3000]);
  assert.equal(order.body.data.order.subtotalCents, 5000);
  const plainOrder = await t.placeOrder(o, c, [{ productId: plain.id, quantity: 1 }]);
  assert.equal(plainOrder.body.data.order.items[0].unitPriceCents, 3000);
  assert.equal(plainOrder.body.data.order.items[0].originalUnitPriceCents, null);

  // changing the discount, lowering the original under it, and removing it
  assert.equal((await t.call('PUT', `/api/manage/products/${sale.id}`, { token: o.token, body: { originalPriceCents: 2000 } })).status, 400); // 2500 would exceed 2000
  const removed = await t.call('PUT', `/api/manage/products/${sale.id}`, { token: o.token, body: { discountedPriceCents: null } });
  assert.deepEqual([removed.body.data.product.priceCents, removed.body.data.product.hasDiscount], [3000, false]);
  assert.equal(dishRow(sale.id).original_price_cents, null);
  // history is untouched by later price changes
  const hist = await t.call('GET', `/api/me/orders/${order.body.data.order.id}`, { token: c.token });
  assert.equal(hist.body.data.order.items[0].unitPriceCents, 2500);
  // a legacy client sending only priceCents sets the price and clears any discount
  await t.call('PUT', `/api/manage/products/${sale.id}`, { token: o.token, body: { discountedPriceCents: 2400 } });
  const legacyPut = await t.call('PUT', `/api/manage/products/${sale.id}`, { token: o.token, body: { priceCents: 3100 } });
  assert.deepEqual([legacyPut.body.data.product.priceCents, legacyPut.body.data.product.hasDiscount], [3100, false]);
});

test('price formula: (discounted price + extras x extra quantity) x dish quantity, extras counted exactly once', async () => {
  const o = await t.createRestaurantOwner('Formula Fries');
  const c = await t.registerCustomer();
  const burger = (await createDish(o, localized({ originalPriceCents: 3000, discountedPriceCents: 2500, optionGroups: [bilingualGroup()] })));
  const [cheese, tomatoes] = burger.optionGroups[0].options;
  assert.deepEqual([cheese.nameAr, cheese.nameEn, cheese.priceCents, cheese.maxQuantity, tomatoes.maxQuantity], ['جبن إضافي', 'Extra cheese', 500, 1, 3]);

  const r = await t.placeOrder(o, c, [{ productId: burger.product.id, quantity: 2, options: [{ optionId: cheese.id, quantity: 1 }, { optionId: tomatoes.id, quantity: 2 }] }]);
  assert.equal(r.status, 201, r.text);
  const line = r.body.data.order.items[0];
  assert.equal(line.unitPriceCents, 2500 + 500 + 2 * 200); // 34.00 for one burger with its extras
  assert.equal(line.lineTotalCents, 2 * 3400); // 68.00 for two
  assert.equal(r.body.data.order.subtotalCents, 6800);
  assert.deepEqual(line.options.map((x) => [x.nameEn, x.nameAr, x.quantity, x.priceCents]).sort(), [['Extra cheese', 'جبن إضافي', 1, 500], ['Extra tomatoes', 'طماطم إضافية', 2, 200]].sort());

  // several lines of the same dish with different extras are priced independently
  const two = await t.placeOrder(o, c, [
    { productId: burger.product.id, quantity: 1, options: [{ optionId: cheese.id, quantity: 1 }] },
    { productId: burger.product.id, quantity: 1 },
  ]);
  assert.deepEqual(two.body.data.order.items.map((i) => i.lineTotalCents), [3000, 2500]);
  assert.equal(two.body.data.order.subtotalCents, 5500);
  // identical lines are merged, not double charged
  const merged = await t.placeOrder(o, c, [
    { productId: burger.product.id, quantity: 1, options: [{ optionId: cheese.id, quantity: 1 }] },
    { productId: burger.product.id, quantity: 2, options: [{ optionId: cheese.id, quantity: 1 }] },
  ]);
  assert.equal(merged.body.data.order.items.length, 1);
  assert.equal(merged.body.data.order.subtotalCents, 3 * 3000);
  // legacy optionIds still work (quantity 1 each) and duplicates are not charged twice
  const legacy = await t.placeOrder(o, c, [{ productId: burger.product.id, quantity: 1, optionIds: [cheese.id, cheese.id] }]);
  assert.equal(legacy.status, 422); // two cheeses exceed its maximum of 1
  assert.equal(legacy.body.error.code, 'option_quantity_exceeded');
});

// ------------------------------------------------------------------------------------------------------------ extras
test('extras: restaurant-defined, bilingual, priced by the owner; selection limits are enforced on the server', async () => {
  const o = await t.createRestaurantOwner('Extras Express');
  const c = await t.registerCustomer();
  const dish = await createDish(o, localized({ optionGroups: [
    bilingualGroup({ minSelect: 0, maxSelect: 1, options: [
      { nameAr: 'جبن', nameEn: 'Cheese', priceCents: 500, maxQuantity: 2 },
      { nameAr: 'صلصة', nameEn: 'Sauce', priceCents: 100, maxQuantity: 1, isAvailable: false },
      { nameAr: 'لحم', nameEn: 'Meat', priceCents: 1000, maxQuantity: 1 },
    ] }),
    bilingualGroup({ nameAr: 'الحجم', nameEn: 'Size', minSelect: 1, maxSelect: 1, options: [{ nameAr: 'عادي', nameEn: 'Regular', priceCents: 0 }, { nameAr: 'كبير', nameEn: 'Large', priceCents: 300 }] }),
  ] }));
  const [extras, size] = dish.optionGroups;
  const [cheese, sauce, meat] = extras.options;
  const [regular, large] = size.options;
  const order = (options, quantity = 1) => t.placeOrder(o, c, [{ productId: dish.product.id, quantity, options }]);

  assert.equal((await order([])).body.error.code, 'invalid_option_count'); // the required size group
  assert.equal((await order([{ optionId: regular.id, quantity: 1 }, { optionId: cheese.id, quantity: 3 }])).body.error.code, 'option_quantity_exceeded');
  assert.equal((await order([{ optionId: regular.id, quantity: 1 }, { optionId: sauce.id, quantity: 1 }])).body.error.code, 'option_unavailable'); // disabled by the owner
  assert.equal((await order([{ optionId: regular.id, quantity: 1 }, { optionId: cheese.id, quantity: 1 }, { optionId: meat.id, quantity: 1 }])).body.error.code, 'invalid_option_count'); // max 1 distinct
  assert.equal((await order([{ optionId: regular.id, quantity: 2 }])).body.error.code, 'option_quantity_exceeded');
  assert.equal((await order([{ optionId: 999999, quantity: 1 }])).body.error.code, 'invalid_option');
  assert.equal((await order([{ optionId: regular.id, quantity: 0 }])).status, 400);
  assert.equal((await order([{ optionId: regular.id, quantity: 21 }])).status, 400);

  const ok = await order([{ optionId: large.id, quantity: 1 }, { optionId: cheese.id, quantity: 2 }]);
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.body.data.order.items[0].unitPriceCents, 3000 + 300 + 1000);

  // an extra's price chosen by the customer is ignored; another dish's extras cannot be borrowed
  const forged = await t.placeOrder(o, c, [{ productId: dish.product.id, quantity: 1, options: [{ optionId: large.id, quantity: 1, priceCents: 0, price: 0 }] }]);
  assert.equal(forged.body.data.order.items[0].unitPriceCents, 3300);
  const other = await createDish(o, localized({ nameEn: 'Fries', nameAr: 'بطاطس' }));
  assert.equal((await t.placeOrder(o, c, [{ productId: other.product.id, quantity: 1, options: [{ optionId: cheese.id, quantity: 1 }] }])).body.error.code, 'invalid_option');
});

test('extras can be edited in place (ids and order history are preserved), reordered and removed; deleting an ordered dish is allowed', async () => {
  const o = await t.createRestaurantOwner('Edit Eats');
  const c = await t.registerCustomer();
  const dish = await createDish(o, localized({ optionGroups: [bilingualGroup()] }));
  const [g] = dish.optionGroups;
  const [cheese, tomatoes] = g.options;
  const first = await t.placeOrder(o, c, [{ productId: dish.product.id, quantity: 1, options: [{ optionId: cheese.id, quantity: 1 }], instructions: 'well done' }]);
  assert.equal(first.status, 201);

  // reorder, reprice, rename, drop one - all in one atomic save of the dish
  const saved = await t.call('PUT', `/api/manage/products/${dish.product.id}`, { token: o.token, body: { optionGroups: [{
    id: g.id, nameAr: 'إضافات', nameEn: 'Add-ons', minSelect: 0, maxSelect: 1,
    options: [{ id: cheese.id, nameAr: 'جبن', nameEn: 'Cheese', priceCents: 900, maxQuantity: 2, isAvailable: true }],
  }] } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.data.optionGroups[0].options.length, 1);
  assert.equal(saved.body.data.optionGroups[0].options[0].id, cheese.id); // same id
  assert.equal(saved.body.data.optionGroups[0].options[0].priceCents, 900);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM options WHERE id = ?').get(tomatoes.id).n, 0);

  // the past order did not change
  const hist = await t.call('GET', `/api/me/orders/${first.body.data.order.id}`, { token: c.token });
  const item = hist.body.data.order.items[0];
  assert.equal(item.unitPriceCents, 3500);
  assert.deepEqual(item.options.map((x) => [x.nameEn, x.priceCents]), [['Extra cheese', 500]]);
  assert.equal(item.instructions, 'well done');

  // ids from another dish / restaurant cannot be injected through the dish form
  const o2 = await t.createRestaurantOwner('Other Eats');
  const d2 = await createDish(o2, localized({ optionGroups: [bilingualGroup()] }));
  const inject = await t.call('PUT', `/api/manage/products/${dish.product.id}`, { token: o.token, body: { optionGroups: [{ id: d2.optionGroups[0].id, nameAr: 'س', nameEn: 'x', options: [{ nameAr: 'ص', nameEn: 'y', priceCents: 0 }] }] } });
  assert.equal(inject.status, 400);
  assert.equal(inject.body.error.details.reason, 'invalid_id');
  assert.ok(t.db.prepare('SELECT 1 FROM option_groups WHERE id = ?').get(d2.optionGroups[0].id));

  // validation of the group itself
  for (const bad of [
    { nameAr: 'ع', nameEn: 'E', options: [] },
    { nameAr: 'ع', nameEn: 'E', minSelect: 3, maxSelect: 2, options: [{ nameAr: 'أ', nameEn: 'a' }, { nameAr: 'ب', nameEn: 'b' }, { nameAr: 'ج', nameEn: 'c' }] },
    { nameAr: 'ع', nameEn: 'E', options: [{ nameAr: 'أ', nameEn: 'a', priceCents: -1 }] },
    { nameAr: 'ع', nameEn: 'E', options: [{ nameAr: 'أ', nameEn: 'a', maxQuantity: 0 }] },
    { nameAr: 'ع', nameEn: 'E', options: [{ nameAr: 'أ' }] },
  ]) {
    assert.equal((await t.call('PUT', `/api/manage/products/${dish.product.id}`, { token: o.token, body: { optionGroups: [bad] } })).status, 400, JSON.stringify(bad));
  }

  // deleting a dish that has been ordered keeps the order readable
  assert.equal((await t.call('DELETE', `/api/manage/products/${dish.product.id}`, { token: o.token })).status, 200);
  const after = await t.call('GET', `/api/me/orders/${first.body.data.order.id}`, { token: c.token });
  assert.equal(after.body.data.order.items[0].nameEn, 'Burger');
  assert.equal(after.body.data.order.items[0].options[0].nameEn, 'Extra cheese');
});

// ------------------------------------------------------------------------------------------------------------ special instructions
test('special instructions: stored per order line, shown to the restaurant, and never change a price', async () => {
  const o = await t.createRestaurantOwner('Notes Noodles');
  const c = await t.registerCustomer();
  const dish = await createDish(o, localized({ originalPriceCents: 2000 }));
  const other = await createDish(o, localized({ nameEn: 'Salad', nameAr: 'سلطة', originalPriceCents: 1000 }));
  const r = await t.placeOrder(o, c, [
    { productId: dish.product.id, quantity: 1, instructions: 'Please add more onions' },
    { productId: dish.product.id, quantity: 1, instructions: 'No pickles, please — أضف المزيد من البصل' },
    { productId: dish.product.id, quantity: 1 },
    { productId: other.product.id, quantity: 1, instructions: 'Cut in half' },
  ]);
  assert.equal(r.status, 201, r.text);
  const items = r.body.data.order.items;
  assert.equal(items.length, 4); // different instructions never merge into one line
  assert.deepEqual(items.map((i) => i.instructions), ['Please add more onions', 'No pickles, please — أضف المزيد من البصل', '', 'Cut in half']);
  assert.equal(r.body.data.order.subtotalCents, 3 * 2000 + 1000); // free text added nothing
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM order_item_options WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)').get(r.body.data.order.id).n, 0);

  // the restaurant sees exactly what was asked
  const seen = await t.call('GET', `/api/manage/orders/${r.body.data.order.id}`, { token: o.token });
  assert.equal(seen.body.data.order.items[0].instructions, 'Please add more onions');
  const list = await t.call('GET', '/api/manage/orders', { token: o.token });
  assert.equal(list.body.data.orders.find((x) => x.id === r.body.data.order.id).items[1].instructions, 'No pickles, please — أضف المزيد من البصل');

  assert.equal((await t.placeOrder(o, c, [{ productId: dish.product.id, quantity: 1, instructions: 'x'.repeat(301) }])).status, 400);
  assert.equal((await t.placeOrder(o, c, [{ productId: dish.product.id, quantity: 1, instructions: { $ne: 1 } }])).status, 400);
  // markup is stored as plain text (the pages escape it); control characters are dropped
  const odd = await t.placeOrder(o, c, [{ productId: dish.product.id, quantity: 1, instructions: '<b>hi</b>\u0000\u0007 ok' }]);
  assert.equal(odd.body.data.order.items[0].instructions, '<b>hi</b> ok');
});

// ------------------------------------------------------------------------------------------------------------ stock
test('stock: tracked dishes cannot be oversold; unavailable and out-of-stock dishes are refused; unlimited stays the default', async () => {
  const o = await t.createRestaurantOwner('Stock Shack');
  const c = await t.registerCustomer();
  const legacy = await t.addProduct(o, { name: 'Always Available', priceCents: 100 });
  assert.equal(legacy.trackStock, false);
  assert.equal((await t.placeOrder(o, c, [{ productId: legacy.id, quantity: 50 }])).status, 201); // unlimited: nothing is deducted

  const dish = (await createDish(o, localized({ trackStock: true, stockQuantity: 5 }))).product;
  assert.deepEqual([dish.trackStock, dish.stockQuantity, dish.orderable], [true, 5, true]);
  const pub = (id) => t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`).then((r) => r.body.data.products.find((p) => p.id === id));
  assert.equal((await pub(dish.id)).stockQuantity, 5);

  const over = await t.placeOrder(o, c, [{ productId: dish.id, quantity: 6 }]);
  assert.equal(over.status, 422);
  assert.equal(over.body.error.code, 'insufficient_stock');
  assert.equal(over.body.error.details.available, 5);
  assert.equal(stockOf(dish.id), 5); // a refused order takes nothing

  // the same dish on several lines counts against the same stock
  const split = await t.placeOrder(o, c, [{ productId: dish.id, quantity: 3 }, { productId: dish.id, quantity: 3, instructions: 'second line' }]);
  assert.equal(split.body.error.code, 'insufficient_stock');
  assert.equal(stockOf(dish.id), 5);

  assert.equal((await t.placeOrder(o, c, [{ productId: dish.id, quantity: 5 }])).status, 201);
  assert.equal(stockOf(dish.id), 0);
  const soldOut = await t.placeOrder(o, c, [{ productId: dish.id, quantity: 1 }]);
  assert.equal(soldOut.body.error.code, 'out_of_stock');
  const shown = await pub(dish.id);
  assert.deepEqual([shown.orderable, shown.soldOut, shown.stockQuantity], [false, true, 0]);

  // switched off by the owner
  const off = await t.call('PATCH', `/api/manage/products/${legacy.id}/availability`, { token: o.token, body: { isAvailable: false } });
  assert.equal(off.status, 200);
  assert.equal((await t.placeOrder(o, c, [{ productId: legacy.id, quantity: 1 }])).body.error.code, 'item_unavailable');

  // restock without recreating the dish: absolute and atomic "add"
  const add = await t.call('PATCH', `/api/manage/products/${dish.id}/stock`, { token: o.token, body: { restockBy: 4 } });
  assert.equal(add.body.data.product.stockQuantity, 4);
  assert.equal((await t.call('PATCH', `/api/manage/products/${dish.id}/stock`, { token: o.token, body: { quantity: 10 } })).body.data.product.stockQuantity, 10);
  assert.equal((await t.placeOrder(o, c, [{ productId: dish.id, quantity: 2 }])).status, 201);
  assert.equal(stockOf(dish.id), 8);
  for (const body of [{ quantity: -1 }, { quantity: 1.5 }, { restockBy: 0 }, { quantity: 1, restockBy: 1 }, {}]) {
    assert.equal((await t.call('PATCH', `/api/manage/products/${dish.id}/stock`, { token: o.token, body })).status, 400, JSON.stringify(body));
  }
  assert.equal(stockOf(dish.id), 8);
  // restocking a dish that does not track stock is refused rather than silently ignored
  assert.equal((await t.call('PATCH', `/api/manage/products/${legacy.id}/stock`, { token: o.token, body: { restockBy: 3 } })).status, 409);
  // turning tracking on for an existing dish
  const turnOn = await t.call('PATCH', `/api/manage/products/${legacy.id}/stock`, { token: o.token, body: { trackStock: true, quantity: 2 } });
  assert.deepEqual([turnOn.body.data.product.trackStock, turnOn.body.data.product.stockQuantity], [true, 2]);
});

test('stock: concurrent orders for the last units cannot oversell', async () => {
  const o = await t.createRestaurantOwner('Race Rolls');
  const dish = (await createDish(o, localized({ trackStock: true, stockQuantity: 3 }))).product;
  const customers = await Promise.all(Array.from({ length: 8 }, () => t.registerCustomer()));
  const results = await Promise.all(customers.map((c) => t.placeOrder(o, c, [{ productId: dish.id, quantity: 1 }])));
  const created = results.filter((r) => r.status === 201).length;
  assert.equal(created, 3);
  assert.deepEqual([...new Set(results.filter((r) => r.status !== 201).map((r) => r.body.error.code))], ['out_of_stock']);
  assert.equal(stockOf(dish.id), 0);
  assert.equal(t.db.prepare('SELECT COALESCE(SUM(quantity),0) AS n FROM order_items WHERE product_id = ?').get(dish.id).n, 3);

  // the database itself refuses to go below zero, and reserve() is all-or-nothing
  const inventory = require('../server/services/inventory');
  t.db.prepare('UPDATE products SET stock_quantity = 1 WHERE id = ?').run(dish.id);
  assert.equal(inventory.reserve(t.db, o.restaurant.id, null, dish.id, 2), false);
  assert.equal(inventory.reserve(t.db, o.restaurant.id, null, dish.id, 1), true);
  assert.equal(inventory.reserve(t.db, o.restaurant.id, null, dish.id, 1), false);
  assert.throws(() => t.db.prepare('UPDATE products SET stock_quantity = -1 WHERE id = ?').run(dish.id), /CHECK|constraint/i);
});

test('stock: cancelling or rejecting an order puts the units back exactly once; delivered orders keep them consumed', async () => {
  const o = await t.createRestaurantOwner('Restore Ribs');
  const c = await t.registerCustomer();
  const dish = (await createDish(o, localized({ trackStock: true, stockQuantity: 10 }))).product;
  const place = async (qty) => (await t.placeOrder(o, c, [{ productId: dish.id, quantity: qty }])).body.data.order;

  const a = await place(4);
  assert.equal(stockOf(dish.id), 6);
  // the customer cancels a pending order
  assert.equal((await t.call('POST', `/api/me/orders/${a.id}/cancel`, { token: c.token })).status, 200);
  assert.equal(stockOf(dish.id), 10);
  // cancelling again is not a valid transition, and calling the restore again does nothing
  assert.equal((await t.call('POST', `/api/me/orders/${a.id}/cancel`, { token: c.token })).status, 409);
  const inventory = require('../server/services/inventory');
  assert.equal(inventory.restoreForOrder(t.db, a.id, o.restaurant.id), 0);
  assert.equal(stockOf(dish.id), 10);

  // the restaurant declines one order and cancels another that it had accepted
  const b = await place(3);
  assert.equal((await t.call('PATCH', `/api/manage/orders/${b.id}/status`, { token: o.token, body: { status: 'rejected', reason: 'sorry' } })).status, 200);
  assert.equal(stockOf(dish.id), 10);
  const d = await place(2);
  await t.call('PATCH', `/api/manage/orders/${d.id}/status`, { token: o.token, body: { status: 'confirmed' } });
  assert.equal(stockOf(dish.id), 8);
  await t.call('PATCH', `/api/manage/orders/${d.id}/status`, { token: o.token, body: { status: 'cancelled', reason: 'oven broke' } });
  assert.equal(stockOf(dish.id), 10);

  // a delivered order is final: the food was consumed
  const e = await place(5);
  for (const status of ['confirmed', 'preparing', 'ready', 'delivered']) {
    assert.equal((await t.call('PATCH', `/api/manage/orders/${e.id}/status`, { token: o.token, body: { status } })).status, 200, status);
  }
  assert.equal(stockOf(dish.id), 5);
  assert.equal((await t.call('PATCH', `/api/manage/orders/${e.id}/status`, { token: o.token, body: { status: 'cancelled', reason: 'late' } })).status, 409);
  assert.equal(stockOf(dish.id), 5);

  // a dish that is deleted while an order is open: cancelling the order must not fail or invent stock elsewhere
  const f = await place(1);
  await t.call('DELETE', `/api/manage/products/${dish.id}`, { token: o.token });
  assert.equal((await t.call('PATCH', `/api/manage/orders/${f.id}/status`, { token: o.token, body: { status: 'rejected', reason: 'gone' } })).status, 200);
});

test('stock: an unpaid online order holds stock and gives it back when the payment fails or expires', async () => {
  const payments = require('../server/services/payments');
  const o = await t.createRestaurantOwner('Card Cafe', undefined, { payoutAccount: true });
  const c = await t.registerCustomer();
  const dish = (await createDish(o, localized({ trackStock: true, stockQuantity: 6 }))).product;
  // simulate a card order that is awaiting payment (the provider round-trip is covered by payments.test.js)
  const { createOrder } = require('../server/services/orders');
  const restaurant = t.db.prepare('SELECT * FROM restaurants WHERE id = ?').get(o.restaurant.id);
  const customer = t.db.prepare('SELECT * FROM users WHERE id = ?').get(c.user.id);
  const provider = { enabled: true, name: 'tap' };
  const created = createOrder(t.db, { restaurant, customer, provider, input: {
    items: [{ productId: dish.id, quantity: 4, options: [], instructions: '' }], orderType: 'pickup', paymentMethod: 'card',
    customerName: 'C', customerPhone: '+966500000001', deliveryAddress: null, notes: null,
  } });
  assert.equal(created.order.status, 'awaiting_payment');
  assert.equal(stockOf(dish.id), 2);
  payments.failPayment(t.db, created.paymentId, 'declined');
  assert.equal(stockOf(dish.id), 6);
  payments.failPayment(t.db, created.paymentId, 'declined again'); // idempotent
  assert.equal(stockOf(dish.id), 6);
});

// ------------------------------------------------------------------------------------------------------------ security
test('tenancy and roles: one restaurant cannot touch another\'s dishes, stock, prices or extras; customers cannot reach the dashboard API', async () => {
  const a = await t.createRestaurantOwner('Alpha');
  const b = await t.createRestaurantOwner('Beta');
  const c = await t.registerCustomer();
  const dish = await createDish(a, localized({ trackStock: true, stockQuantity: 5, optionGroups: [bilingualGroup()] }));
  const id = dish.product.id;
  const gid = dish.optionGroups[0].id;

  for (const [method, url, body] of [
    ['GET', `/api/manage/products/${id}`], ['PUT', `/api/manage/products/${id}`, { discountedPriceCents: 1000 }], ['DELETE', `/api/manage/products/${id}`],
    ['PATCH', `/api/manage/products/${id}/stock`, { quantity: 999 }], ['PATCH', `/api/manage/products/${id}/availability`, { isAvailable: false }],
    ['GET', `/api/manage/products/${id}/option-groups`], ['POST', `/api/manage/products/${id}/option-groups`, bilingualGroup()],
    ['PUT', `/api/manage/option-groups/${gid}`, bilingualGroup()], ['DELETE', `/api/manage/option-groups/${gid}`],
  ]) {
    const r = await t.call(method, url, { token: b.token, body });
    assert.equal(r.status, 404, `${method} ${url} -> ${r.status}`);
  }
  assert.deepEqual([stockOf(id), dishRow(id).is_available, dishRow(id).price_cents], [5, 1, 3000]);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM option_groups WHERE id = ?').get(gid).n, 1);
  // B cannot attach A's category or send a restaurant id
  const cat = await t.call('POST', '/api/manage/categories', { token: a.token, body: { nameAr: 'أ', nameEn: 'A-only' } });
  const attach = await t.call('POST', '/api/manage/products', { token: b.token, body: localized({ categoryId: cat.body.data.category.id }) });
  assert.equal(attach.status, 400);

  for (const [method, url, body] of [
    ['GET', '/api/manage/products'], ['POST', '/api/manage/products', localized()], ['PATCH', `/api/manage/products/${id}/stock`, { quantity: 1 }], ['POST', '/api/manage/categories', { nameAr: 'أ', nameEn: 'x' }],
  ]) {
    assert.equal((await t.call(method, url, { token: c.token, body })).status, 403, `${method} ${url}`);
    assert.equal((await t.call(method, url, { body })).status, 401, `${method} ${url} anonymous`);
  }
  // staff: may switch dishes off and adjust stock, may not change text, prices, extras or delete
  const s = await t.call('POST', '/api/manage/staff', { token: a.token, body: { name: 'Sam', email: `${t.unique('s')}@t.test`, password: 'Passw0rd!' } });
  const staff = (await t.call('POST', '/api/auth/login', { body: { email: s.body.data.staff.email, password: 'Passw0rd!' } })).body.data.token;
  assert.equal((await t.call('PATCH', `/api/manage/products/${id}/stock`, { token: staff, body: { restockBy: 2 } })).status, 200);
  assert.equal((await t.call('PATCH', `/api/manage/products/${id}/availability`, { token: staff, body: { isAvailable: false } })).status, 200);
  for (const [method, url, body] of [['PUT', `/api/manage/products/${id}`, { discountedPriceCents: 1 }], ['DELETE', `/api/manage/products/${id}`], ['POST', '/api/manage/products', localized()], ['PUT', `/api/manage/option-groups/${gid}`, bilingualGroup()]]) {
    assert.equal((await t.call(method, url, { token: staff, body })).status, 403, `staff ${method} ${url}`);
  }
  assert.equal(stockOf(id), 7);
  // a customer cannot order A's dish through B
  assert.equal((await t.placeOrder(b, c, [{ productId: id, quantity: 1 }])).body.error.code, 'invalid_item');
});

// ------------------------------------------------------------------------------------------------------------ existing data
test('migrations 006, 007 and 008 on a database that already holds restaurants, dishes, extras, branches and orders keeps everything working', async () => {
  const { openDb } = require('../server/db');
  const { createApp } = require('../server/app');
  const { createProvider } = require('../server/payments/provider');
  const { ensurePlans } = require('../server/services/seedData');
  const dir = path.join(__dirname, '..', 'server', 'migrations');
  const db = openDb(':memory:');
  const apply = (file) => {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const off = /^--\s*migrate:foreign_keys=off/m.test(sql);
    if (off) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN'); db.exec(sql); db.exec('COMMIT');
    if (off) db.exec('PRAGMA foreign_keys = ON');
  };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const before006 = files.filter((f) => f < '006');
  assert.ok(before006.length >= 5);
  for (const f of before006) apply(f);
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')))');
  for (const f of before006) db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(f);
  ensurePlans(db);

  // data as the previous release stored it
  const hash = bcrypt.hashSync('Passw0rd!', 4);
  const rid = Number(db.prepare("INSERT INTO restaurants (slug, name, currency, approval_status) VALUES ('old-grill', 'Old Grill', 'SAR', 'approved')").run().lastInsertRowid);
  db.prepare("INSERT INTO subscriptions (restaurant_id, plan_id, status) VALUES (?, (SELECT id FROM plans WHERE code = 'free'), 'active')").run(rid);
  db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('old.customer@t.test', ?, 'Old Customer', 'customer')").run(hash);
  const cat = Number(db.prepare('INSERT INTO categories (restaurant_id, name) VALUES (?, ?)').run(rid, 'Mains').lastInsertRowid);
  const prod = Number(db.prepare('INSERT INTO products (restaurant_id, category_id, name, description, price_cents) VALUES (?,?,?,?,?)').run(rid, cat, 'Mixed Grill', 'Old description', 4500).lastInsertRowid);
  const grp = Number(db.prepare('INSERT INTO option_groups (restaurant_id, product_id, name, min_select, max_select) VALUES (?,?,?,?,?)').run(rid, prod, 'Sides', 0, 2).lastInsertRowid);
  const opt = Number(db.prepare('INSERT INTO options (restaurant_id, group_id, name, price_cents) VALUES (?,?,?,?)').run(rid, grp, 'Rice', 300).lastInsertRowid);
  const custId = db.prepare("SELECT id FROM users WHERE email = 'old.customer@t.test'").get().id;
  const ord = Number(db.prepare(`INSERT INTO orders (restaurant_id, customer_id, order_number, order_type, customer_name, customer_phone, subtotal_cents, tax_cents, delivery_fee_cents, total_cents, currency)
    VALUES (?,?,1,'pickup','Old Customer','+966500000009',4800,0,0,4800,'SAR')`).run(rid, custId).lastInsertRowid);
  const item = Number(db.prepare('INSERT INTO order_items (order_id, restaurant_id, product_id, product_name, unit_price_cents, quantity, line_total_cents) VALUES (?,?,?,?,?,1,4800)').run(ord, rid, prod, 'Mixed Grill', 4800).lastInsertRowid);
  db.prepare('INSERT INTO order_item_options (order_item_id, restaurant_id, option_id, group_name, option_name, price_cents) VALUES (?,?,?,?,?,300)').run(item, rid, opt, 'Sides', 'Rice');

  // upgrade
  apply(files.find((f) => f.startsWith('006')));
  assert.equal(db.prepare('SELECT track_stock, stock_quantity, original_price_cents, name_ar FROM products WHERE id = ?').get(prod).track_stock, 0); // unlimited, no discount, no invented translation
  assert.equal(db.prepare('SELECT quantity FROM order_item_options WHERE order_item_id = ?').get(item).quantity, 1);
  assert.equal(db.prepare('SELECT max_quantity FROM options WHERE id = ?').get(opt).max_quantity, 1);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);

  // ... and the next release (migration 007: general extras + language preference) is purely additive on top of it
  apply(files.find((f) => f.startsWith('007')));
  assert.deepEqual({ ...db.prepare('SELECT item_kind, extra_id, extra_category, product_id FROM order_items WHERE id = ?').get(item) }, { item_kind: 'dish', extra_id: null, extra_category: null, product_id: prod });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM restaurant_extras').get().c, 0);
  assert.equal(db.prepare("SELECT preferred_lang FROM users WHERE email = 'old.customer@t.test'").get().preferred_lang, null);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);

  // restaurants that already have branches and tracked stock when migration 008 (branches, per-branch stock, discount rules) arrives
  const mk = (slug) => Number(db.prepare("INSERT INTO restaurants (slug, name, currency, approval_status) VALUES (?, ?, 'SAR', 'approved')").run(slug, slug).lastInsertRowid);
  const solo = mk('solo'); const multi = mk('multi');
  db.prepare("INSERT INTO branches (restaurant_id, name) VALUES (?, 'Only branch')").run(solo);
  db.prepare("INSERT INTO branches (restaurant_id, name) VALUES (?, 'North')").run(multi);
  db.prepare("INSERT INTO branches (restaurant_id, name) VALUES (?, 'South')").run(multi);
  const tracked = (rid2, n) => Number(db.prepare('INSERT INTO products (restaurant_id, name, price_cents, track_stock, stock_quantity) VALUES (?,?,100,1,?)').run(rid2, n, 7).lastInsertRowid);
  const pSolo = tracked(solo, 'solo dish'); const pMulti = tracked(multi, 'multi dish');
  apply(files.find((f) => f.startsWith('008')));
  // an order that an (old) discount rule priced before migration 009 introduced the redemption ledger
  const oldOrder = db.prepare('SELECT restaurant_id, customer_id, status FROM orders WHERE id = ?').get(ord);
  const oldRule = Number(db.prepare("INSERT INTO discount_rules (restaurant_id, name_ar, name_en, scope, kind, value, used_count, is_active) VALUES (?, 'x', 'Old sale', 'restaurant', 'percent', 1000, 1, 0)").run(oldOrder.restaurant_id).lastInsertRowid);
  db.prepare('UPDATE order_items SET discount_rule_id = ? WHERE id = ?').run(oldRule, item);
  apply(files.find((f) => f.startsWith('009')));
  // ... it becomes one standing redemption for that customer; the old rule keeps its behaviour (no per-customer limit), nothing else changes
  assert.deepEqual(db.prepare('SELECT rule_id, customer_id, order_id FROM discount_redemptions').all().map((r) => ({ ...r })), [{ rule_id: oldRule, customer_id: oldOrder.customer_id, order_id: ord }]);
  assert.equal(db.prepare('SELECT max_uses_per_customer m FROM discount_rules WHERE id = ?').get(oldRule).m, null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM categories WHERE image_url IS NOT NULL').get().c, 0);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  // exactly one branch: the existing quantity moves to it; several branches: nothing is assigned silently (reported by the dashboard instead)
  assert.deepEqual(db.prepare('SELECT quantity FROM branch_stock WHERE product_id = ?').all(pSolo).map((r) => r.quantity), [7]);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM branch_stock WHERE product_id = ?').get(pMulti).c, 0);
  assert.equal(db.prepare('SELECT stock_quantity q FROM products WHERE id = ?').get(pMulti).q, 7); // legacy figure preserved
  assert.equal(db.prepare('SELECT branch_id FROM orders WHERE id = ?').get(ord).branch_id, null);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);

  const server = createApp(db, { provider: createProvider() }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { token, body } = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    const pub = await call('GET', '/api/public/restaurants/old-grill');
    assert.equal(pub.status, 200);
    const p = pub.body.data.products[0];
    assert.deepEqual([p.name, p.priceCents, p.originalPriceCents, p.hasDiscount, p.trackStock, p.orderable, p.nameAr, p.nameEn], ['Mixed Grill', 4500, 4500, false, false, true, '', '']);
    assert.deepEqual(p.missingTranslations, ['ar', 'en']);
    assert.equal(p.optionGroups[0].options[0].maxQuantity, 1);
    const token = (await call('POST', '/api/auth/login', { body: { email: 'old.customer@t.test', password: 'Passw0rd!' } })).body.data.token;
    const hist = await call('GET', `/api/me/orders/${ord}`, { token });
    assert.deepEqual([hist.body.data.order.items[0].name, hist.body.data.order.items[0].unitPriceCents, hist.body.data.order.items[0].options[0].name, hist.body.data.order.items[0].options[0].quantity, hist.body.data.order.items[0].instructions], ['Mixed Grill', 4800, 'Rice', 1, '']);
    // ordering with the old request shape (optionIds) works and prices the same as before
    const placed = await call('POST', '/api/public/restaurants/old-grill/orders', { token, body: { items: [{ productId: prod, quantity: 2, optionIds: [opt] }], orderType: 'pickup', paymentMethod: 'cod', customerName: 'Old', customerPhone: '+966500000009' } });
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    assert.equal(placed.body.data.order.subtotalCents, 2 * 4800);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
