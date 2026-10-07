const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startApp } = require('./helpers');

const ROOT = path.join(__dirname, '..');
let t;
before(async () => { t = await startApp(); });
after(async () => { await t.close(); });

test('invalid / hostile ids never crash or leak: 400 or 404, never 500', async () => {
  const o = await t.createRestaurantOwner('Id Tester', 'pro');
  const ids = ['abc', '-1', '0', '1e999', '99999999999999999999', '1;DROP TABLE products', "1' OR '1'='1", '%00', '..%2f..%2fetc', 'NaN', '3.14'];
  for (const id of ids) {
    for (const [m, p, body] of [
      ['GET', `/api/manage/orders/${id}`], ['PUT', `/api/manage/products/${id}`, { name: 'x' }],
      ['DELETE', `/api/manage/products/${id}`], ['PATCH', `/api/manage/orders/${id}/status`, { status: 'confirmed' }],
      ['DELETE', `/api/manage/staff/${id}`], ['PUT', `/api/manage/categories/${id}`, { name: 'x' }],
    ]) {
      const r = await t.call(m, p, { token: o.token, body });
      assert.ok([400, 404].includes(r.status), `${m} ${p} -> ${r.status}`);
    }
  }
  const c = await t.registerCustomer();
  assert.equal((await t.call('GET', '/api/me/orders/abc', { token: c.token })).status, 404);
  assert.equal((await t.call('GET', `/api/public/restaurants/${encodeURIComponent("x' OR 1=1 --")}`)).status, 404);
  assert.ok(t.db.prepare('SELECT COUNT(*) c FROM products').get().c >= 0); // tables still exist
});

test('special characters, unicode and script payloads are stored verbatim and returned as inert JSON text', async () => {
  const o = await t.createRestaurantOwner('Spëcial Çhars 🍜', 'pro');
  const nasty = `<img src=x onerror=alert(1)> "quotes" 'single' \\ 🍣 Robert'); DROP TABLE users;--`;
  const p = await t.addProduct(o, { name: nasty.slice(0, 120), description: nasty });
  const pub = await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`);
  assert.equal(pub.body.data.products[0].description, nasty);
  assert.match(pub.headers.get('content-type'), /application\/json/);
  assert.ok(t.db.prepare('SELECT COUNT(*) c FROM users').get().c > 0);
  assert.ok(p.id);
  assert.match(o.restaurant.slug, /^[a-z0-9-]+$/);
});

test('oversized and malformed input is rejected cleanly', async () => {
  const o = await t.createRestaurantOwner('Big Input');
  const huge = 'x'.repeat(200 * 1024);
  const r1 = await t.call('POST', '/api/manage/products', { token: o.token, body: { name: 'a', priceCents: 1, description: huge } });
  assert.equal(r1.status, 413);
  assert.equal(r1.body.error.code, 'too_large');
  assert.equal((await t.call('POST', '/api/manage/products', { token: o.token, body: { name: 'x'.repeat(121), priceCents: 1 } })).status, 400);
  assert.equal((await t.call('POST', '/api/manage/products', { token: o.token, body: { name: 'a', priceCents: 1e12 } })).status, 400);
  for (const body of [[], 'string', null, 42]) {
    const r = await t.call('POST', '/api/manage/products', { token: o.token, body });
    assert.ok(r.status >= 400 && r.status < 500, `body ${JSON.stringify(body)} -> ${r.status}`);
  }
  const long = await t.call('POST', '/api/auth/register', { body: { name: 'a', email: 'long@t.test', password: `a1${'x'.repeat(80)}` } });
  assert.equal(long.status, 400); // > 72 bytes would be silently truncated by bcrypt
  assert.equal((await t.call('POST', '/api/auth/register', { body: { name: 'x'.repeat(101), email: 'n@t.test', password: 'Passw0rd!' } })).status, 400);
  const bigUpload = await t.call('POST', '/api/manage/uploads', { token: o.token, raw: true, body: Buffer.alloc(3 * 1024 * 1024, 1), headers: { 'Content-Type': 'image/png' } });
  assert.equal(bigUpload.status, 413);
});

test('concurrent requests cannot exceed plan limits or duplicate order numbers', async () => {
  const o = await t.createRestaurantOwner('Race Cafe'); // Free: 10 items
  const results = await Promise.all(Array.from({ length: 25 }, (_, i) =>
    t.call('POST', '/api/manage/products', { token: o.token, body: { name: `Race ${i}`, priceCents: 100 } })));
  assert.equal(results.filter((r) => r.status === 201).length, 10);
  assert.equal(results.filter((r) => r.status === 402).length, 15);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM products WHERE restaurant_id = ?').get(o.restaurant.id).c, 10);

  const p = (await t.call('GET', '/api/manage/products', { token: o.token })).body.data.products[0];
  const c = await t.registerCustomer();
  const orders = await Promise.all(Array.from({ length: 30 }, () =>
    t.call('POST', `/api/public/restaurants/${o.restaurant.slug}/orders`, { token: c.token, body: t.orderBody([{ productId: p.id, quantity: 1 }]) })));
  assert.ok(orders.every((r) => r.status === 201), orders.map((r) => r.status).join());
  const nums = orders.map((r) => r.body.data.order.orderNumber).sort((a, b) => a - b);
  assert.deepEqual(nums, Array.from({ length: 30 }, (_, i) => i + 1));
});

test('old open orders are never hidden by the list limit (status=active)', async () => {
  const o = await t.createRestaurantOwner('Backlog Bar', 'pro');
  const p = await t.addProduct(o);
  const c = await t.registerCustomer();
  const place = async () => (await t.call('POST', `/api/public/restaurants/${o.restaurant.slug}/orders`, { token: c.token, body: t.orderBody([{ productId: p.id, quantity: 1 }]) })).body.data.order;
  const first = await place();
  for (let i = 0; i < 5; i++) {
    const x = await place();
    for (const s of ['confirmed', 'preparing', 'ready', 'delivered']) await t.call('PATCH', `/api/manage/orders/${x.id}/status`, { token: o.token, body: { status: s } });
  }
  const r = await t.call('GET', '/api/manage/orders?status=active&limit=3', { token: o.token });
  assert.deepEqual(r.body.data.orders.map((x) => x.id), [first.id]);
});

test('expired, unknown-user, unsigned and wrongly-schemed tokens fail gracefully', async () => {
  const jwt = require('jsonwebtoken');
  const expired = jwt.sign({ sub: 1 }, process.env.AUTH_SECRET, { expiresIn: -10 });
  const r = await t.call('GET', '/api/auth/me', { token: expired });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'invalid_token');
  assert.equal((await t.call('GET', '/api/auth/me', { token: jwt.sign({ sub: 999999 }, process.env.AUTH_SECRET) })).status, 401);
  assert.equal((await t.call('GET', '/api/auth/me', { token: jwt.sign({ sub: 1 }, '', { algorithm: 'none' }) })).status, 401);
  assert.equal((await t.call('GET', '/api/auth/me', { headers: { Authorization: 'Basic abc' } })).status, 401);
});

test('settings validation: tax, fees, email and image URL', async () => {
  const o = await t.createRestaurantOwner('Settings Spot');
  const put = (body) => t.call('PUT', '/api/manage/restaurant', { token: o.token, body });
  assert.equal((await put({ taxRateBp: 10001 })).status, 400);
  assert.equal((await put({ taxRateBp: -1 })).status, 400);
  assert.equal((await put({ deliveryFeeCents: 'free' })).status, 400);
  assert.equal((await put({ email: 'nope' })).status, 400);
  assert.equal((await put({ logoUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await put({ logoUrl: 'http://insecure.example/x.png' })).status, 400);
  assert.equal((await put({ logoUrl: '/uploads/../server/config.js' })).status, 400);
  assert.equal((await put({ name: '   ' })).status, 400);
  const ok = await put({ name: 'Renamed', taxRateBp: 825, logoUrl: 'https://example.com/logo.png' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.restaurant.taxRateBp, 825);
});

test('empty database: a brand-new platform returns empty lists, not errors', async () => {
  const fresh = await startApp();
  try {
    const list = await fresh.call('GET', '/api/public/restaurants');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.restaurants, []);
    assert.equal((await fresh.call('GET', '/api/public/plans')).body.data.plans.length, 4);
  } finally { await fresh.close(); }
});

test('production refuses to start without AUTH_SECRET', () => {
  const env = { ...process.env, NODE_ENV: 'production', APP_URL: 'https://example.com' };
  delete env.AUTH_SECRET;
  delete env.JWT_SECRET;
  const r = spawnSync(process.execPath, ['-e', "require('./server/config')"], { cwd: ROOT, env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /AUTH_SECRET must be set/);
});

test('production also refuses placeholder or short AUTH_SECRET values (e.g. the one in .env.example)', () => {
  for (const secret of ['change-me', 'short', 'x'.repeat(31)]) {
    const r = spawnSync(process.execPath, ['-e', "require('./server/config')"], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'production', APP_URL: 'https://example.com', AUTH_SECRET: secret }, encoding: 'utf8' });
    assert.notEqual(r.status, 0, secret);
    assert.match(r.stderr, /AUTH_SECRET must be set/);
  }
  const good = spawnSync(process.execPath, ['-e', "require('./server/config')"], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'production', APP_URL: 'https://example.com', AUTH_SECRET: 'x'.repeat(48), CURRENCY: 'SAR' }, encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
});

test('auth rate limiting returns 429 after repeated attempts', () => {
  const script = `
    process.env.RATE_LIMIT = 'on'; process.env.BCRYPT_ROUNDS = '4'; process.removeAllListeners('warning');
    const { openDb, migrate } = require('./server/db'); const { createApp } = require('./server/app');
    const db = openDb(':memory:'); migrate(db);
    const s = createApp(db).listen(0, async () => {
      const base = 'http://127.0.0.1:' + s.address().port; let last;
      for (let i = 0; i < 40; i++) last = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.co', password: 'x' }) });
      console.log(String(last.status)); s.close();
    });`;
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  delete env.RATE_LIMIT;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '429', r.stderr);
});
