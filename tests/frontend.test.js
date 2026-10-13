// The browser-side logic that can run without a DOM: phone composition, the customer price formula (checked against the server's own
// pricing), localization dictionaries, and that every new front-end module is served. The pages themselves are exercised in a real browser.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { startApp } = require('./helpers');

let t;
before(async () => { t = await startApp(); });
after(async () => { await t.close(); });

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', name)).href);

test('phone input composes a strict E.164 number from what people type', async () => {
  const { composePhone, splitPhone } = await load('phone-format.js');
  assert.equal(composePhone('966', '050 000 0000'), '+966500000000'); // local trunk 0 dropped
  assert.equal(composePhone('966', '500000000'), '+966500000000');
  assert.equal(composePhone('966', '٠٥٠ ٠٠٠ ٠٠٠٠'), '+966500000000'); // Arabic-Indic digits
  assert.equal(composePhone('971', '(50) 123-4567'), '+971501234567');
  assert.equal(composePhone('966', '+44 7700 900123'), '+447700900123'); // a full international number overrides the selector
  assert.equal(composePhone('966', '00966500000000'), '+966500000000');
  assert.equal(composePhone('', '+31 6 12345678'), '+31612345678'); // "other" country
  assert.equal(composePhone('966', ''), '');
  assert.equal(composePhone('966', '   '), '');
  assert.deepEqual(splitPhone('+966500000000'), { dial: '966', national: '500000000' });
  assert.deepEqual(splitPhone('+12025550123'), { dial: '1', national: '2025550123' });
  assert.deepEqual(splitPhone('0500000000'), { dial: null, national: '0500000000' });
  // whatever the form composes, the server accepts exactly the valid ones
  const { mobile } = require('../server/utils');
  for (const [dial, typed] of [['966', '055 555 5555'], ['20', '010 1234 5678'], ['44', '07700 900123'], ['1', '(202) 555-0123']]) {
    assert.match(mobile(composePhone(dial, typed)), /^\+[1-9]\d{7,14}$/);
  }
  assert.throws(() => mobile(composePhone('966', '12')));
});

test('the price shown in the browser equals the price the server charges', async () => {
  const { lineCents, discountPercent, extrasCents, unitCents } = await load('pricing.js');
  const o = await t.createRestaurantOwner('Agreement Grill');
  const c = await t.registerCustomer();
  const group = (extras, over = {}) => ({ nameAr: 'إضافات', nameEn: 'Extras', minSelect: 0, maxSelect: extras.length, options: extras.map(([ar, en, priceCents, maxQuantity]) => ({ nameAr: ar, nameEn: en, priceCents, maxQuantity })), ...over });
  const cases = [
    { original: 3000, discounted: 2500, extras: [['ج', 'Cheese', 500, 1], ['ط', 'Tomato', 200, 3]], pick: [[0, 1], [1, 2]], qty: 2 }, // the worked example: 68.00
    { original: 1999, discounted: null, extras: [['أ', 'A', 1, 5], ['ب', 'B', 333, 2]], pick: [[0, 5], [1, 2]], qty: 3 },
    { original: 1, discounted: null, extras: [['أ', 'A', 99, 20]], pick: [[0, 20]], qty: 50 },
    { original: 1050, discounted: 999, extras: [['أ', 'A', 0, 1]], pick: [], qty: 7 },
  ];
  for (const k of cases) {
    const dish = (await t.call('POST', '/api/manage/products', { token: o.token, body: {
      nameAr: 'وجبة', nameEn: 'Dish', descriptionAr: 'وصف', descriptionEn: 'Desc', originalPriceCents: k.original, discountedPriceCents: k.discounted,
      optionGroups: [group(k.extras)],
    } })).body.data;
    // what the browser sees
    const pub = (await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`)).body.data.products.find((p) => p.id === dish.product.id);
    const options = dish.optionGroups[0].options;
    const selected = k.pick.map(([i, qty]) => ({ id: options[i].id, qty }));
    const shown = lineCents(pub, selected, k.qty);
    // what the server charges for the same cart
    const r = await t.placeOrder(o, c, [{ productId: dish.product.id, quantity: k.qty, options: selected.map((s) => ({ optionId: s.id, quantity: s.qty })) }]);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.data.order.items[0].lineTotalCents, shown, JSON.stringify(k));
    assert.equal(r.body.data.order.items[0].unitPriceCents, unitCents(pub, selected));
    assert.equal(r.body.data.order.subtotalCents, shown);
    assert.equal(extrasCents(pub, selected), k.pick.reduce((s, [i, q]) => s + k.extras[i][2] * q, 0));
    assert.equal(pub.discountPercent, discountPercent(pub.originalPriceCents, pub.priceCents));
  }
  assert.equal(discountPercent(3000, 2500), 17);
  assert.equal(discountPercent(1000, 1000), 0);
  assert.equal(discountPercent(0, 0), 0);
  assert.equal(discountPercent(10, 1), 90);
});

test('Arabic and English dictionaries define the same keys, with matching placeholders (npm run check)', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'check-i18n.js')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /keys in both languages/);
});

test('every new front-end module and page is served, and pages are marked up for translation', async () => {
  const get = (p) => fetch(t.base + p, { redirect: 'manual' });
  for (const p of ['/js/i18n.js', '/js/locale-en.js', '/js/locale-ar.js', '/js/locales/en/admin.js', '/js/locales/ar/dashboard.js', '/js/icons.js', '/js/legal.js', '/js/menu-manager.js', '/js/phone-input.js', '/js/phone-format.js', '/js/pricing.js']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /javascript/);
  }
  // every page - including the platform admin sign-in - follows the visitor's language
  for (const p of ['/admin/login', '/register.html', '/login.html', '/onboarding.html', '/orders.html', '/restaurants.html', '/']) {
    const html = await (await get(p)).text();
    assert.match(html, /data-i18n=/, p);
    assert.ok(!/data-lang=/.test(html), `${p} must follow the visitor's language`);
  }
  // the dictionaries are real Arabic, not placeholders
  const ar = (await load('locale-ar.js')).default;
  const en = (await load('locale-en.js')).default;
  assert.match(ar['dish.instructions'], /ملاحظات أو طلبات إضافية/); // the label the product brief asks for
  assert.equal(en['dish.instructions'], 'Special instructions');
  assert.equal(Object.keys(ar).filter((k) => !/[؀-ۿ]/.test(ar[k]) && !/^(login\.title|register\.title|.*pageTitle|landing\.title)$/.test(k) && /[a-z]{4,}/i.test(ar[k].replace(/\{\w+\}/g, '').replace(/PNG|JPEG|WebP|MB|Foodies|WhatsApp/g, ''))).length, 0);
});

test('general extras: the browser formula equals the server, and a mixed cart adds up to the same total', async () => {
  const { lineCents, extraLineCents } = await load('pricing.js');
  const o = await t.createRestaurantOwner('Mixed Grill');
  const c = await t.registerCustomer();
  const dish = (await t.call('POST', '/api/manage/products', { token: o.token, body: {
    nameAr: 'وجبة', nameEn: 'Dish', descriptionAr: 'وصف', descriptionEn: 'Desc', originalPriceCents: 2500,
    optionGroups: [{ nameAr: 'إضافات', nameEn: 'Extras', options: [{ nameAr: 'جبن', nameEn: 'Cheese', priceCents: 500, maxQuantity: 2 }] }],
  } })).body.data;
  const mk = async (nameEn, category, priceCents) => (await t.call('POST', '/api/manage/extras', { token: o.token, body: { nameAr: 'إضافة', nameEn, category, priceCents } })).body.data.extra;
  const water = await mk('Water', 'drinks', 300);
  const fries = await mk('Fries', 'sides', 800);
  const pub = (await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`)).body.data;
  const cheese = dish.optionGroups[0].options[0];
  const p = pub.products.find((x) => x.id === dish.product.id);
  const w = pub.extras.find((x) => x.id === water.id);
  const f = pub.extras.find((x) => x.id === fries.id);
  const shown = lineCents(p, [{ id: cheese.id, qty: 2 }], 2) + extraLineCents(w, 2) + extraLineCents(f, 1);
  const r = await t.placeOrder(o, c, [{ productId: dish.product.id, quantity: 2, options: [{ optionId: cheese.id, quantity: 2 }] }], { extras: [{ extraId: water.id, quantity: 2 }, { extraId: fries.id, quantity: 1 }] });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.data.order.subtotalCents, shown);
  assert.equal(extraLineCents(w, 2), r.body.data.order.items.find((i) => i.nameEn === 'Water').lineTotalCents);
});

test('navigation uses monochrome SVG icons (no emoji anywhere in the interface) and the Menu submenu is nested in the sidebar', () => {
  const fs = require('node:fs');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)).map((x) => path.join(e.name, x)) : [e.name]));
  const pub = path.join(__dirname, '..', 'public');
  for (const f of [...walk(path.join(pub, 'js')).map((x) => path.join('js', x)), ...fs.readdirSync(pub).filter((x) => x.endsWith('.html'))]) {
    const src = fs.readFileSync(path.join(pub, f), 'utf8');
    assert.ok(!/\p{Extended_Pictographic}/u.test(src), `${f} contains an emoji`);
  }
  const dash = fs.readFileSync(path.join(pub, 'js', 'dashboard.js'), 'utf8');
  const menu = fs.readFileSync(path.join(pub, 'js', 'menu-manager.js'), 'utf8');
  const css = fs.readFileSync(path.join(pub, 'css', 'app.css'), 'utf8');
  assert.match(dash, /children: MENU_NAV/);          // the submenu belongs to the Menu item of the one sidebar
  assert.match(dash, /data-menu-toggle/);            // Menu expands / collapses
  assert.ok(!/menu-nav|menu-shell/.test(menu + css)); // the separate second navigation panel is gone
  for (const id of ['dishes', 'categories', 'stock', 'discounts', 'extras', 'settings']) assert.match(menu, new RegExp(`id: '${id}'`), id); // every section is still offered
  // "Add new dish" is no longer a sidebar item: it is a button on All dishes, and #menu/new stays a working route
  assert.doesNotMatch(menu, /id: 'new'/);
  assert.match(menu, /id="add-dish" href="#menu\/new"/);
  assert.match(menu, /isForm = section === 'new' \|\| section === 'edit'/);
  // Add-ons & extras opens General extras; #menu/extras (and the old dish tab) redirect there; no Dish extras tab or link remains
  assert.match(menu, /location\.replace\('#menu\/extras\/general'\)/);
  assert.doesNotMatch(menu, /gx\.tab\.dish|dishExtrasOverview|extrasTabs/);
  for (const route of ['menu/new', 'menu/dishes', 'menu/categories', 'menu/stock', 'menu/discounts', 'menu/extras', 'menu/settings']) assert.ok(menu.includes(`'${route.split('/')[1]}'`) || dash.includes(route), route);
});

test('account recovery, help, error and legal pages are translated (Arabic + English)', async () => {
  const get = async (p) => (await fetch(t.base + p)).text();
  for (const p of ['/forgot-password.html', '/reset-password.html', '/verify-email.html', '/report.html', '/403.html', '/404.html']) {
    assert.match(await get(p), /data-i18n=/, p);
  }
  for (const p of ['/terms.html', '/privacy.html', '/refund-policy.html']) {
    const html = await get(p);
    assert.match(html, /data-l="en"/, p);
    assert.match(html, /data-l="ar"[^>]*dir="rtl"/, p);
    assert.match(html, /js\/legal\.js/, p);
  }
  // the stylesheet shows only the visitor's language on those pages
  assert.match(await get('/css/app.css'), /html\[lang="ar"\] \[data-l="en"\]/);
});

test('restaurant-written Arabic text keeps its own direction; logical CSS properties are used for layout', () => {
  const fs = require('node:fs');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  // physical left/right offsets would not mirror in RTL; the few that remain must be symmetric (left and right set together)
  const physical = css.split('\n').filter((l) => /(^|[\s{;])(margin|padding)-(left|right)\s*:|(^|[\s{;])(left|right)\s*:\s*[^;]+;/.test(l) && !/left:[^;]*;\s*right:|right:[^;]*;\s*left:/.test(l));
  assert.deepEqual(physical, []);
  assert.match(css, /margin-inline-start/);
  assert.match(css, /\[dir="rtl"\]/);
});
