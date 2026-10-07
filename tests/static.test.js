const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

let t;
before(async () => { t = await startApp(); });
after(async () => { await t.close(); });

const get = (p) => fetch(t.base + p, { redirect: 'manual' });

test('public pages and the pretty restaurant URL are served', async () => {
  for (const p of ['/', '/index.html', '/login.html', '/register.html', '/restaurants.html', '/dashboard.html', '/admin/login', '/onboarding.html', '/orders.html', '/order.html', '/report.html', '/forgot-password.html', '/reset-password.html', '/verify-email.html', '/restaurant/any-slug', '/css/app.css', '/js/common.js']) {
    assert.equal((await get(p)).status, 200, p);
  }
  const page = await (await get('/restaurant/any-slug')).text();
  assert.match(page, /restaurant\.js/);
});

test('original static site is preserved under /legacy (development only)', async () => {
  assert.equal((await get('/legacy/home.html')).status, 200);
  assert.equal((await get('/legacy/dominos.html')).status, 200);
  assert.equal((await get('/legacy/Images/Restaurants/dominos.jpg')).status, 200);
  assert.equal((await get('/Images/Restaurants/dominos.jpg')).status, 200);
});

test('server source, env files, database and node_modules are never served', async () => {
  for (const p of ['/server/config.js', '/.env', '/.env.example', '/package.json', '/data/app.db', '/node_modules/express/package.json', '/tests/helpers.js', '/..%2fpackage.json', '/legacy/../package.json']) {
    const r = await get(p);
    assert.ok(r.status === 404 || r.status === 400 || r.status === 301, `${p} -> ${r.status}`);
    assert.ok(!(await r.text()).includes('jwtSecret'), p);
  }
});

test('security headers are set and unknown paths render the 404 page', async () => {
  const r = await get('/');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
  const nf = await get('/nope');
  assert.equal(nf.status, 404);
  assert.match(await nf.text(), /Page not found/);
});

test('public HTML never contains inline scripts or inline handlers (strict CSP)', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'public');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${f} has inline <script>`);
    assert.ok(!/\son(click|load|submit|change|error)=/i.test(html), `${f} has inline handler`);
  }
});

test('every seeded sample product image exists on disk (no broken images in the demo data)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { openDb, migrate } = require('../server/db');
  const { seedSample } = require('../server/services/seedData');
  const db = openDb(':memory:');
  migrate(db);
  seedSample(db, { createUsers: false });
  const rows = db.prepare('SELECT image_url FROM products WHERE image_url IS NOT NULL').all();
  assert.ok(rows.length > 100);
  const root = path.join(__dirname, '..');
  const missing = rows.filter((r) => !fs.existsSync(path.join(root, decodeURI(r.image_url)))).map((r) => r.image_url);
  assert.deepEqual(missing, []);
});
