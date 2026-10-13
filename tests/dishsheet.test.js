// Excel import / export of dishes: template, export (own data only), preview, validation, safe create / update, tenancy and malformed files.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { startApp } = require('./helpers');
const { XLSX_MIME } = require('../server/services/dishSheet');

let t;
before(async () => { t = await startApp(); });
after(async () => { await t.close(); });

const H = ['ID', 'Name (Arabic)', 'Name (English)', 'Description (Arabic)', 'Description (English)', 'Category', 'Original Price', 'Discounted Price', 'Available', 'Track Stock', 'Stock Quantity', 'Image URL'];
const row = (o = {}) => { const g = (k, d) => (k in o ? o[k] : d); return [g('id', null), g('ar', 'برغر'), g('en', t.unique('Burger')), g('dar', 'وصف'), g('den', 'desc'), g('cat', null), g('price', 12.5), g('disc', null), g('avail', 'yes'), g('track', 'no'), g('qty', null), g('img', null)]; };
const dishOf = (owner, o = {}) => t.addProduct(owner, { nameAr: 'طبق', nameEn: t.unique('Dish'), descriptionAr: 'و', descriptionEn: 'd', originalPriceCents: 1000, ...o });
async function book(headers, rows, sheetName = 'Dishes') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const send = (owner, path, buf, headers = {}) => t.call('POST', path, { token: owner.token, body: buf, raw: true, headers: { 'Content-Type': XLSX_MIME, ...headers } });
const preview = (owner, buf, mode = 'create') => send(owner, `/api/manage/dishes/import/preview?mode=${mode}`, buf);
const importIt = (owner, buf, qs = 'mode=create', headers) => send(owner, `/api/manage/dishes/import?${qs}`, buf, headers);
const products = (owner) => t.db.prepare('SELECT * FROM products WHERE restaurant_id = ? ORDER BY id').all(owner.restaurant.id);
async function download(owner, path) {
  const res = await fetch(t.base + path, { headers: { Authorization: `Bearer ${owner.token}` } });
  return { res, buf: Buffer.from(await res.arrayBuffer()) };
}
async function sheetRows(buf, name = 'Dishes') {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const out = [];
  wb.getWorksheet(name).eachRow((r) => out.push(r.values.slice(1)));
  return out;
}

test('template: a valid .xlsx with clear column names, owners only', async () => {
  const o = await t.createRestaurantOwner();
  const { res, buf } = await download(o, '/api/manage/dishes/template.xlsx');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), XLSX_MIME);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="[\w.-]+\.xlsx"/);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const rows = await sheetRows(buf);
  assert.deepEqual(rows[0], H.filter((h) => h !== 'ID' || true).slice(0, 12));
  const c = await t.registerCustomer();
  assert.equal((await t.call('GET', '/api/manage/dishes/template.xlsx', { token: c.token })).status, 403);
  assert.equal((await t.call('GET', '/api/manage/dishes/template.xlsx')).status, 401);
});

test('export: only the signed-in restaurant\'s dishes, round-trippable, formula-safe, empty menu is fine', async () => {
  const a = await t.createRestaurantOwner();
  const b = await t.createRestaurantOwner();
  const cat = (await t.call('POST', '/api/manage/categories', { token: a.token, body: { nameAr: 'مشويات', nameEn: 'Grill' } })).body.data.category;
  const d = await dishOf(a, { nameAr: 'برغر', nameEn: 'Burger', descriptionAr: 'لحم', descriptionEn: '=HYPERLINK("http://evil")', originalPriceCents: 2500, discountedPriceCents: 2000, categoryId: cat.id, trackStock: true, stockQuantity: 7 });
  await dishOf(b, { nameEn: 'Secret dish of B' });

  const { res, buf } = await download(a, '/api/manage/dishes/export.xlsx');
  assert.equal(res.status, 200);
  const rows = await sheetRows(buf);
  assert.equal(rows.length, 2); // header + the one dish
  const r = rows[1];
  assert.deepEqual([r[0], r[1], r[2], r[5], r[6], r[7], r[8], r[9], r[10]], [d.id, 'برغر', 'Burger', 'Grill', 25, 20, 'yes', 'yes', 7]);
  assert.equal(r[4], "'=HYPERLINK(\"http://evil\")"); // would otherwise be a live formula in Excel
  assert.ok(!buf.toString('latin1').includes('Secret dish of B'));

  // an empty menu still exports (headers only)
  const empty = await t.createRestaurantOwner();
  const e = await download(empty, '/api/manage/dishes/export.xlsx');
  assert.equal(e.res.status, 200);
  assert.equal((await sheetRows(e.buf)).length, 1);

  // what was exported can be fed back in update mode without changes
  const re = await importIt(a, buf, 'mode=update');
  assert.equal(re.status, 200, re.text);
  assert.deepEqual(re.body.data.summary, { created: 0, updated: 1, skipped: 0, failed: 0 });
  const p = products(a)[0];
  assert.deepEqual([p.price_cents, p.original_price_cents, p.stock_quantity, p.descriptionEn ?? p.description_en], [2000, 2500, 7, '=HYPERLINK("http://evil")']);
});

test('preview and import (create): valid rows are created, nothing is published by accident', async () => {
  const o = await t.createRestaurantOwner();
  const cat = (await t.call('POST', '/api/manage/categories', { token: o.token, body: { nameAr: 'مقبلات', nameEn: 'Starters' } })).body.data.category;
  const buf = await book(H, [
    row({ en: 'Hummus', ar: 'حمص', cat: 'Starters', price: 8, disc: 6.5, avail: 'yes', track: 'yes', qty: 20, img: 'https://example.com/h.jpg' }),
    row({ en: 'Falafel', cat: 'مقبلات', price: '9,50', avail: null }), // availability left empty
    row({ en: 'Soup', avail: 'no' }),
  ]);
  const pv = await preview(o, buf);
  assert.equal(pv.status, 200, pv.text);
  assert.deepEqual([pv.body.data.report.totals.ok, pv.body.data.report.totals.errors, pv.body.data.report.creates], [3, 0, 3]);
  assert.equal(products(o).length, 0); // a preview writes nothing
  assert.equal(pv.body.data.report.rows[1].warnings[0].code, 'availability_defaulted');

  const r = await importIt(o, buf);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.data.summary, { created: 3, updated: 0, skipped: 0, failed: 0 });
  const [hummus, falafel] = products(o);
  assert.deepEqual([hummus.name_en, hummus.name_ar, hummus.category_id, hummus.price_cents, hummus.original_price_cents, hummus.is_available, hummus.track_stock, hummus.stock_quantity, hummus.image_url],
    ['Hummus', 'حمص', cat.id, 650, 800, 1, 1, 20, 'https://example.com/h.jpg']);
  assert.deepEqual([falafel.price_cents, falafel.original_price_cents, falafel.is_available, falafel.category_id], [950, null, 0, cat.id]); // empty availability = hidden

  // running the same file again creates nothing: existing dishes are reported as skipped, never duplicated or overwritten
  const again = await importIt(o, buf);
  assert.deepEqual(again.body.data.summary, { created: 0, updated: 0, skipped: 3, failed: 0 });
  assert.equal(products(o).length, 3);
  // the same request replayed with an Idempotency-Key returns the first answer
  const fresh = await book(H, [row({ en: 'Tea' })]);
  const k = { 'Idempotency-Key': `imp-${t.unique('k')}` };
  const one = await importIt(o, fresh, 'mode=create', k);
  const two = await importIt(o, fresh, 'mode=create', k);
  assert.equal(two.headers.get('idempotent-replay'), 'true');
  assert.deepEqual(one.body, two.body);
  assert.equal(products(o).length, 4);
});

test('validation reports the sheet row and column; strict import writes nothing, skipInvalid imports the valid rows only', async () => {
  const o = await t.createRestaurantOwner();
  const buf = await book(H, [
    row({ en: 'Good' }),                              // row 2
    row({ en: '', ar: '' }),                          // row 3: names missing
    row({ en: 'Bad price', price: 'abc' }),           // row 4
    row({ en: 'Neg', price: -5 }),                    // row 5
    row({ en: 'Cheap', price: 10, disc: 12 }),        // row 6: discount not lower
    row({ en: 'Decimals', price: 10.555 }),           // row 7
    row({ en: 'No cat', cat: 'Missing category' }),   // row 8
    row({ en: 'Avail', avail: 'maybe' }),             // row 9
    row({ en: 'Stock', track: 'no', qty: 5 }),        // row 10: quantity without tracking
    row({ en: 'Local', img: 'C:\\Users\\me\\a.png' }),// row 11: local path
    row({ en: 'Good' }),                              // row 12: duplicate in file
    row({ en: 'Withid', id: 5 }),                     // row 13: ID not allowed in create mode
    row({ en: 'Qty', track: 'yes', qty: 'x' }),       // row 14
  ]);
  const pv = (await preview(o, buf)).body.data.report;
  const errs = Object.fromEntries(pv.rows.filter((r) => r.status === 'error').map((r) => [r.row, r.errors.map((e) => `${e.field}:${e.code}`)]));
  assert.deepEqual(errs[3], ['Name (Arabic):required', 'Name (English):required']);
  assert.deepEqual(errs[4], ['Original Price:invalid_number']);
  assert.deepEqual(errs[5], ['Original Price:invalid_number']);
  assert.deepEqual(errs[6], ['Discounted Price:discount_not_lower']);
  assert.deepEqual(errs[7], ['Original Price:too_many_decimals']);
  assert.deepEqual(errs[8], ['Category:unknown_category']);
  assert.deepEqual(errs[9], ['Available:invalid_boolean']);
  assert.deepEqual(errs[10], ['Stock Quantity:stock_requires_tracking']);
  assert.deepEqual(errs[11], ['Image URL:invalid_image_url']);
  assert.deepEqual(errs[12], ['Name (English):duplicate_in_file']);
  assert.deepEqual(errs[13], ['ID:id_not_allowed']);
  assert.deepEqual(errs[14], ['Stock Quantity:invalid_integer']);
  assert.equal(pv.rows[0].status, 'ok');

  const strict = await importIt(o, buf);
  assert.equal(strict.status, 422); assert.equal(strict.body.error.code, 'import_invalid');
  assert.equal(strict.body.error.details.report.totals.errors, 12);
  assert.equal(products(o).length, 0); // nothing written

  const partial = await importIt(o, buf, 'mode=create&skipInvalid=1');
  assert.equal(partial.status, 200, partial.text);
  assert.deepEqual(partial.body.data.summary, { created: 1, updated: 0, skipped: 0, failed: 12 });
  assert.deepEqual(products(o).map((p) => p.name_en), ['Good']);
});

test('headers are validated; unknown columns (including any restaurant id) are ignored, never trusted', async () => {
  const o = await t.createRestaurantOwner();
  const victim = await t.createRestaurantOwner();
  const missing = await preview(o, await book(['Name (English)', 'Original Price'], [['X', 5]]));
  assert.ok(missing.body.data.report.headerErrors.some((e) => e.code === 'missing_column'));
  assert.equal((await importIt(o, await book(['Name (English)'], [['X']]))).status, 422);

  const sneaky = await book([...H, 'Restaurant ID', 'restaurant_id'], [[...row({ en: 'Sneaky' }), victim.restaurant.id, victim.restaurant.id]]);
  const r = await importIt(o, sneaky);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.data.report.ignoredColumns.sort(), ['Restaurant ID', 'restaurant_id']);
  assert.equal(products(o).length, 1);
  assert.equal(products(victim).length, 0);

  // a branch column that is not this restaurant's is refused
  const ob = await t.createRestaurantOwner();
  const foreign = await t.call('POST', '/api/manage/branches', { token: ob.token, body: { name: 'Theirs', latitude: 1, longitude: 1 } });
  const bad = await preview(o, await book([...H, `Stock - Theirs (#${foreign.body.data.branch.id})`], [row()]));
  assert.ok(bad.body.data.report.headerErrors.some((e) => e.code === 'unknown_branch'));
});

test('update mode: stable dish IDs only; other restaurants\' ids and name matches are rejected; blank stock cells leave stock alone', async () => {
  const o = await t.createRestaurantOwner();
  const other = await t.createRestaurantOwner();
  const mine = await dishOf(o, { nameEn: 'Mine', originalPriceCents: 1000, trackStock: true, stockQuantity: 9 });
  const theirs = await dishOf(other, { nameEn: 'Theirs', originalPriceCents: 1000 });

  const buf = await book(H, [
    row({ id: mine.id, en: 'Mine renamed', price: 15, avail: 'yes', track: null, qty: null }),
    row({ id: theirs.id, en: 'Hijack' }),
    row({ id: null, en: 'Mine renamed' }),       // no id: names never identify a dish
    row({ id: 999999, en: 'Ghost' }),
    row({ id: mine.id, en: 'Twice' }),
  ]);
  const pv = (await preview(o, buf, 'update')).body.data.report;
  assert.deepEqual(pv.rows.map((r) => [r.row, r.status, r.errors[0]?.code]), [[2, 'ok', undefined], [3, 'error', 'unknown_id'], [4, 'error', 'id_required'], [5, 'error', 'unknown_id'], [6, 'error', 'duplicate_in_file']]);
  const done = await importIt(o, buf, 'mode=update&skipInvalid=1');
  assert.deepEqual(done.body.data.summary, { created: 0, updated: 1, skipped: 0, failed: 4 });
  const p = products(o)[0];
  assert.deepEqual([p.name_en, p.price_cents, p.stock_quantity, p.track_stock], ['Mine renamed', 1500, 9, 1]);
  assert.equal(t.db.prepare('SELECT name_en FROM products WHERE id = ?').get(theirs.id).name_en, 'Theirs'); // untouched
});

test('branch stock columns: export lists every branch, import sets quantities per branch', async () => {
  const o = await t.createRestaurantOwner();
  t.setPlan(o, 'business');
  const mk = async (name) => (await t.call('POST', '/api/manage/branches', { token: o.token, body: { name, latitude: 24, longitude: 46 } })).body.data.branch;
  const a = await mk('Alpha');
  const b = await mk('Beta');
  const { buf: tpl } = await download(o, '/api/manage/dishes/template.xlsx');
  const header = (await sheetRows(tpl))[0];
  assert.ok(header.includes(`Stock - Alpha (#${a.id})`) && header.includes(`Stock - Beta (#${b.id})`));
  assert.ok(!header.includes('Stock Quantity')); // replaced by the branch columns

  const cols = H.filter((h) => h !== 'Stock Quantity');
  const buf = await book([...cols, `Stock - Alpha (#${a.id})`, `Stock - Beta (#${b.id})`], [
    [null, 'ب', 'Branchy', 'و', 'd', null, 5, null, 'yes', 'yes', null, 11, null], // Alpha = 11, Beta empty
  ]);
  const r = await importIt(o, buf);
  assert.equal(r.status, 200, r.text);
  const p = products(o)[0];
  const stock = (br) => t.db.prepare('SELECT quantity FROM branch_stock WHERE branch_id = ? AND product_id = ?').get(br, p.id)?.quantity;
  assert.deepEqual([stock(a.id), stock(b.id)], [11, undefined]);
  // export shows the per-branch quantities
  const rows = await sheetRows((await download(o, '/api/manage/dishes/export.xlsx')).buf);
  const h = rows[0];
  assert.equal(rows[1][h.indexOf(`Stock - Alpha (#${a.id})`)], 11);
  // the old single "Stock Quantity" cell is refused for a restaurant with branches
  const old = await preview(o, await book(H, [row({ en: 'Old', track: 'yes', qty: 4 })]));
  assert.equal(old.body.data.report.rows[0].errors[0].code, 'use_branch_columns');
});

test('security: owners only, size limit, malformed / non-xlsx files and zip bombs are rejected cleanly', async () => {
  const o = await t.createRestaurantOwner();
  const buf = await book(H, [row()]);
  const c = await t.registerCustomer();
  assert.equal((await send(c, '/api/manage/dishes/import/preview', buf)).status, 403);
  assert.equal((await t.call('POST', '/api/manage/dishes/import', { body: buf, raw: true, headers: { 'Content-Type': XLSX_MIME } })).status, 401);
  // a staff account may not import either
  const st = await t.call('POST', '/api/manage/staff', { token: o.token, body: { name: 'S', email: `${t.unique('s')}@t.test`, password: 'Passw0rd!' } });
  const login = await t.call('POST', '/api/auth/login', { body: { email: st.body.data.staff.email, password: 'Passw0rd!' } });
  assert.equal((await send({ token: login.body.data.token }, '/api/manage/dishes/import/preview', buf)).status, 403);

  const junk = await preview(o, Buffer.from('this is definitely not a spreadsheet'));
  assert.equal(junk.status, 400); assert.equal(junk.body.error.details.reason, 'not_xlsx');
  const fakeZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)]);
  const corrupt = await preview(o, fakeZip);
  assert.equal(corrupt.status, 400);
  assert.doesNotMatch(corrupt.text, /at \w+|node_modules|\\Users\\/); // no internals leak
  const csv = await t.call('POST', '/api/manage/dishes/import/preview', { token: o.token, body: 'a,b\n1,2', raw: true, headers: { 'Content-Type': 'text/csv' } });
  assert.equal(csv.status, 415);
  const huge = await preview(o, Buffer.concat([buf, Buffer.alloc(3 * 1024 * 1024)]));
  assert.equal(huge.status, 413);
  const wb = await book(H, Array.from({ length: 1001 }, () => row()));
  const many = await preview(o, wb);
  assert.equal(many.status, 400); assert.equal(many.body.error.details.reason, 'too_many_rows');
  assert.equal(products(o).length, 0);
});

test('plan limits apply to imports and a failing import leaves the menu unchanged', async () => {
  const o = await t.createRestaurantOwner(); // free plan: 10 dishes
  for (let i = 0; i < 8; i++) await dishOf(o);
  const buf = await book(H, [row(), row(), row()]);
  const r = await importIt(o, buf);
  assert.equal(r.status, 402); assert.equal(r.body.error.code, 'plan_limit_reached');
  assert.equal(products(o).length, 8);
});

test('a workbook written by another tool (prefixed XML namespace, BOM, absolute relationship targets, cell notes) is still read', async () => {
  const JSZip = require('jszip');
  const o = await t.createRestaurantOwner();
  const plain = await book(H, [row({ en: 'Prefixed Burger' })]);
  const zip = await JSZip.loadAsync(plain);
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir || !/\.(xml|rels)$/.test(name)) continue;
    let text = await zip.file(name).async('string');
    if (name.endsWith('.rels')) text = '\uFEFF' + text.replace(/Target="(?!\/)([^"]+)"/g, (a, x) => `Target="/${name.startsWith('xl/worksheets') ? 'xl/' : name.startsWith('xl/') ? 'xl/' : ''}${x.replace(/^\.\.\//, '')}"`);
    else if (/xl\/(workbook|styles|sharedStrings|worksheets\/sheet\d+)\.xml$/.test(name)) {
      text = text.replace(/xmlns="http:\/\/schemas.openxmlformats.org\/spreadsheetml\/2006\/main"/, 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')
        .replace(/<(\/?)(?!\?)([A-Za-z])/g, '<$1x:$2');
    }
    zip.file(name, text);
  }
  const odd = await zip.generateAsync({ type: 'nodebuffer' });
  const r = await preview(o, odd);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.data.report.totals.ok, 1);
  assert.equal((await preview(o, Buffer.from('PK\u0003\u0004 not really a workbook'))).status, 400);
});
