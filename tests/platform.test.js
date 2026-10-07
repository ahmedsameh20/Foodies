const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startApp } = require('./helpers');
const totp = require('../server/services/totp');

let t, admin, owner, customer;
before(async () => {
  t = await startApp();
  admin = await t.createAdminUser();
  owner = await t.createRestaurantOwner('Page Test Grill', 'pro');
  customer = await t.registerCustomer();
});
after(async () => { await t.close(); });

// plain fetch that never follows redirects, optionally with a cookie
const page = (path, cookie) => fetch(t.base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
async function cookieFor(email, password = 'Passw0rd!') {
  const res = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const c = res.headers.getSetCookie().find((x) => x.startsWith('foodies_session='));
  return { cookie: c?.split(';')[0], body: await res.json() };
}
// request with an arbitrary Host header (fetch forbids overriding it)
const rawGet = (path, host) => new Promise((resolve, reject) => {
  const u = new URL(t.base);
  http.get({ host: u.hostname, port: u.port, path, headers: { Host: host } }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
  }).on('error', reject);
});

test('ADMIN ACCESS: /admin is protected on the backend and routes admins to /admin/dashboard', async () => {
  // anonymous: redirected to the admin login (never shown the panel)
  for (const p of ['/admin', '/admin/', '/admin/dashboard', '/admin/restaurants', '/admin/system']) {
    const r = await page(p);
    assert.ok([302, 301].includes(r.status), `${p} -> ${r.status}`);
    assert.match(r.headers.get('location'), /^\/admin\/(login|dashboard)/);
  }
  assert.match((await page('/admin/dashboard')).headers.get('location'), /^\/admin\/login\?next=%2Fadmin%2Fdashboard$/);
  assert.equal((await page('/admin/login')).status, 200);
  assert.equal((await page('/admin.html')).status, 301); // the old file URL no longer exposes the shell

  // a restaurant owner and a customer get 403 and never the admin HTML
  for (const who of [owner.email, customer.user.email]) {
    const { cookie } = await cookieFor(who);
    for (const p of ['/admin/dashboard', '/admin/restaurants', '/admin/payouts']) {
      const r = await page(p, cookie);
      assert.equal(r.status, 403, `${who} ${p}`);
      const body = await r.text();
      assert.match(body, /403/);
      assert.ok(!body.includes('admin-app.js'), 'admin shell must not be served to non-admins');
    }
  }
  // the admin gets the panel; /admin itself redirects; the admin login bounces an already-signed-in admin
  const a = await cookieFor(admin.email);
  const ok = await page('/admin/dashboard', a.cookie);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /admin-app\.js/);
  for (const section of ['restaurants', 'users', 'customers', 'orders', 'payments', 'refunds', 'payouts', 'subscriptions', 'plans', 'reports', 'support', 'settings', 'audit', 'system', 'security']) {
    assert.equal((await page(`/admin/${section}`, a.cookie)).status, 200, section);
  }
  assert.equal((await page('/admin/nope', a.cookie)).status, 404);
  assert.match((await page('/admin/login', a.cookie)).headers.get('location'), /\/admin\/dashboard$/);
  assert.match((await page('/admin', a.cookie)).headers.get('location'), /\/admin\/dashboard$/);
  // the logged-in nav entry for each role (frontend helper): admins land on the dashboard, others never do
  const common = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'common.js'), 'utf8');
  assert.match(common, /super_admin: '\/admin\/dashboard'/);
  assert.match(common, /owner: user\.restaurantId \? '\/dashboard\.html'/);
});

test('REGRESSION: a stale, forged or revoked session cookie never blocks signing in', async () => {
  const stale = 'foodies_session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjEsInR2IjowfQ.invalidsignature';
  // public pages and the admin login page still load
  assert.equal((await page('/admin/login', stale)).status, 200);
  assert.equal((await page('/login.html', stale)).status, 200);
  // the sign-in request itself succeeds and sets a fresh cookie
  const res = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: stale }, body: JSON.stringify({ email: admin.email, password: 'Passw0rd!' }) });
  assert.equal(res.status, 200);
  assert.ok(res.headers.getSetCookie().some((c) => c.startsWith('foodies_session=') && !c.startsWith('foodies_session=;')));
  // protected endpoints answer 401 (and clear the cookie) rather than 500
  const prot = await fetch(`${t.base}/api/admin/dashboard`, { headers: { Cookie: stale } });
  assert.equal(prot.status, 401);
  assert.equal((await prot.json()).error.code, 'invalid_token');
  // a session revoked by logout behaves the same way (own admin: logout revokes every session of that account)
  const other = await t.createAdminUser();
  const a = await cookieFor(other.email);
  await fetch(`${t.base}/api/auth/logout`, { method: 'POST', headers: { Cookie: a.cookie, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal((await page('/admin/login', a.cookie)).status, 200); // not redirected: the session is gone
  assert.equal((await cookieFor(other.email)).body.data.user.role, 'super_admin'); // and signing in again works
});

test('admin login, role gate and credentials: only super_admin passes /api/admin; a restaurant role never does', async () => {
  const login = await t.call('POST', '/api/auth/login', { body: { email: admin.email, password: 'Passw0rd!' } });
  assert.equal(login.body.data.user.role, 'super_admin');
  assert.equal((await t.call('GET', '/api/admin/dashboard', { token: login.body.data.token })).status, 200);
  assert.equal((await t.call('GET', '/api/admin/dashboard', { token: owner.token })).status, 403);
  assert.equal((await t.call('GET', '/api/admin/dashboard', { token: customer.token })).status, 403);
  assert.equal((await t.call('GET', '/api/admin/dashboard')).status, 401);
  assert.equal((await t.call('POST', '/api/auth/login', { body: { email: admin.email, password: 'wrong-Password1' } })).status, 401);
  // a restaurant owner cannot promote themselves, neither by registering nor with request fields
  const sneaky = await t.call('POST', '/api/auth/register-owner', { body: { name: 'Eve', email: `${t.unique('eve')}@t.test`, password: 'Passw0rd!', role: 'super_admin' } });
  assert.equal(sneaky.body.data.user.role, 'owner');
  assert.equal((await t.call('PUT', '/api/manage/restaurant', { token: owner.token, body: { name: 'X', role: 'super_admin', userId: admin.user.id } })).status, 200);
  assert.equal(t.db.prepare('SELECT role FROM users WHERE email = ?').get(owner.email).role, 'owner');
});

test('2FA: enrol, sign in with TOTP, replay protection, backup codes, challenge token is not a session, enforcement gate', async () => {
  const a = await t.createAdminUser();
  const auth = (token) => ({ token });
  // owners/customers cannot use the admin 2FA endpoints
  assert.equal((await t.call('POST', '/api/auth/2fa/setup', { ...auth(owner.token), body: {} })).status, 403);
  const setup = await t.call('POST', '/api/auth/2fa/setup', { token: a.token, body: {} });
  assert.match(setup.body.data.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.body.data.otpauthUri, /^otpauth:\/\/totp\//);
  assert.equal(t.db.prepare('SELECT totp_secret_enc FROM users WHERE id = ?').get(a.user.id).totp_secret_enc.includes(setup.body.data.secret), false); // encrypted at rest
  assert.equal((await t.call('POST', '/api/auth/2fa/enable', { token: a.token, body: { code: '000000' } })).status, 400);
  const en = await t.call('POST', '/api/auth/2fa/enable', { token: a.token, body: { code: totp.codeAt(setup.body.data.secret) } });
  assert.equal(en.status, 200);
  assert.equal(en.body.data.backupCodes.length, 8);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM backup_codes WHERE user_id = ?').get(a.user.id).c, 8);
  assert.ok(!JSON.stringify(t.db.prepare('SELECT code_hash FROM backup_codes WHERE user_id = ?').all(a.user.id)).includes(en.body.data.backupCodes[0].replace('-', '')));

  // sign-in is now two-step; the first step yields no session at all
  const step1 = await t.call('POST', '/api/auth/login', { body: { email: a.email, password: 'Passw0rd!' } });
  assert.equal(step1.body.data.mfaRequired, true);
  assert.equal(step1.body.data.token, undefined);
  assert.equal(step1.headers.getSetCookie().length, 0);
  const challenge = step1.body.data.mfaToken;
  assert.equal((await t.call('GET', '/api/admin/dashboard', { token: challenge })).status, 401); // a challenge is not a session
  assert.equal((await t.call('POST', '/api/auth/mfa', { body: { mfaToken: challenge, code: '123456' } })).status, 401);
  assert.equal((await t.call('POST', '/api/auth/mfa', { body: { mfaToken: 'garbage', code: totp.codeAt(setup.body.data.secret) } })).status, 401);
  // the code used to enable 2FA is already consumed: replay is refused even though it is still "current"
  assert.equal((await t.call('POST', '/api/auth/mfa', { body: { mfaToken: challenge, code: totp.codeAt(setup.body.data.secret) } })).status, 401);
  // the next time step is accepted exactly once
  const next = totp.codeAt(setup.body.data.secret, Date.now() + 30000);
  const ok = await t.call('POST', '/api/auth/mfa', { body: { mfaToken: challenge, code: next } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.user.role, 'super_admin');
  assert.equal((await t.call('GET', '/api/admin/dashboard', { token: ok.body.data.token })).status, 200);
  assert.equal((await t.call('POST', '/api/auth/mfa', { body: { mfaToken: challenge, code: next } })).status, 401); // replay
  // backup codes work once
  const bc = en.body.data.backupCodes[0];
  const fresh = (await t.call('POST', '/api/auth/login', { body: { email: a.email, password: 'Passw0rd!' } })).body.data.mfaToken;
  assert.equal((await t.call('POST', '/api/auth/mfa', { body: { mfaToken: fresh, code: bc } })).status, 200);
  assert.equal((await t.call('POST', '/api/auth/mfa', { body: { mfaToken: fresh, code: bc } })).status, 401);
  // disabling needs password + a valid second factor
  const tok = (await t.call('POST', '/api/auth/mfa', { body: { mfaToken: fresh, code: en.body.data.backupCodes[1] } })).body.data.token;
  assert.equal((await t.call('POST', '/api/auth/2fa/disable', { token: tok, body: { password: 'nope', code: en.body.data.backupCodes[2] } })).status, 403);
  assert.equal((await t.call('POST', '/api/auth/2fa/disable', { token: tok, body: { password: 'Passw0rd!', code: en.body.data.backupCodes[2] } })).status, 200);
  assert.equal((await t.call('POST', '/api/auth/login', { body: { email: a.email, password: 'Passw0rd!' } })).body.data.mfaRequired, undefined);

  // enforcement: with REQUIRE_ADMIN_2FA the admin API is closed until the admin enrols (the /me probe stays open)
  const b = await t.createAdminUser();
  t.config.requireAdmin2fa = true;
  try {
    const gated = await t.call('GET', '/api/admin/dashboard', { token: b.token });
    assert.equal(gated.status, 403);
    assert.equal(gated.body.error.code, 'mfa_enrollment_required');
    const me = await t.call('GET', '/api/admin/me', { token: b.token });
    assert.equal(me.body.data.mfaEnrollmentRequired, true);
    const s = await t.call('POST', '/api/auth/2fa/setup', { token: b.token, body: {} });
    const e = await t.call('POST', '/api/auth/2fa/enable', { token: b.token, body: { code: totp.codeAt(s.body.data.secret) } });
    assert.equal((await t.call('GET', '/api/admin/dashboard', { token: e.body.data.token })).status, 200);
  } finally { t.config.requireAdmin2fa = false; }
});

test('TOTP implementation matches RFC 6238 and rejects malformed codes', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totp.codeAt(secret, 59000), '287082');
  assert.equal(totp.codeAt(secret, 1111111109000), '081804');
  assert.equal(totp.verify(secret, '287082', { now: 59000 }), 1);
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, '28708 2']) assert.equal(totp.verify(secret, bad, { now: 59000 }), null, String(bad));
});

test('admin dashboard shows only real database numbers (zeros on an empty platform)', async () => {
  const empty = await startApp();
  try {
    const adm = await empty.createAdminUser();
    const d = (await empty.call('GET', '/api/admin/dashboard', { token: adm.token })).body.data;
    for (const [k, v] of Object.entries(d.stats)) if (typeof v === 'number') assert.equal(v, 0, `${k} must be 0 on an empty platform`);
    assert.deepEqual(d.stats.subscriptionsByStatus, {});
    assert.equal(d.series.orders.length, 30);
    assert.ok(Object.values(d.series).filter(Array.isArray).every((s) => s.every((p) => Object.entries(p).every(([k, v]) => k === 'day' || v === undefined || v === 0))));
    assert.deepEqual((await empty.call('GET', '/api/public/restaurants')).body.data.restaurants, []);
    assert.equal(empty.db.prepare('SELECT COUNT(*) c FROM restaurants').get().c, 0);
    assert.equal(empty.db.prepare('SELECT COUNT(*) c FROM users WHERE role != \'super_admin\'').get().c, 0);
  } finally { await empty.close(); }

  // with data, the dashboard equals what the database says
  const o = await t.createRestaurantOwner('Stats Shop', 'pro');
  const p = await t.addProduct(o, { priceCents: 2500 });
  const c = await t.registerCustomer('Stats Customer');
  await t.placeOrder(o, c, [{ productId: p.id, quantity: 2 }]);
  await t.placeOrder(o, c, [{ productId: p.id, quantity: 1 }]);
  const d = (await t.call('GET', '/api/admin/dashboard?days=7', { token: admin.token })).body.data;
  const q = (sql) => t.db.prepare(sql).get().n;
  assert.equal(d.stats.totalRestaurants, q('SELECT COUNT(*) n FROM restaurants'));
  assert.equal(d.stats.totalCustomers, q("SELECT COUNT(*) n FROM users WHERE role = 'customer'"));
  assert.equal(d.stats.totalOrders, q("SELECT COUNT(*) n FROM orders WHERE status NOT IN ('cancelled','rejected','awaiting_payment')"));
  assert.equal(d.stats.grossRevenueCents, q("SELECT COALESCE(SUM(total_cents),0) n FROM orders WHERE status NOT IN ('cancelled','rejected','awaiting_payment')"));
  assert.equal(d.stats.platformCommissionCents, q("SELECT COALESCE(SUM(commission_cents + platform_fee_cents),0) n FROM orders WHERE status NOT IN ('cancelled','rejected','awaiting_payment')"));
  assert.equal(d.stats.subscriptionRevenueCents, 0); // order money never leaks into the subscription ledger
  assert.equal(d.series.days, 7);
  assert.equal(d.series.orders.at(-1).orders, 2);
  assert.equal(d.series.orders.reduce((s, x) => s + (x.revenueCents || 0), 0), 7500);
});

test('plans are configurable by the admin: create, edit, validate, deactivate; owners only see active plans', async () => {
  const mk = (body) => t.call('POST', '/api/admin/plans', { token: admin.token, body });
  const good = { code: 'enterprise', name: 'Enterprise', priceCents: 29900, billingInterval: 'year', trialDays: 30, maxMenuItems: null, maxStaff: 50, maxOrdersPerMonth: null, analytics: true, advancedReports: true, features: ['SLA support', 'Custom domain'] };
  const created = await mk(good);
  assert.equal(created.status, 201);
  assert.equal(created.body.data.plan.billingInterval, 'year');
  assert.equal(created.body.data.plan.maxStaff, 50);
  assert.deepEqual(created.body.data.plan.features, ['SLA support', 'Custom domain']);
  assert.equal((await mk(good)).status, 409);
  for (const bad of [{ ...good, code: 'Bad Code!' }, { ...good, code: 'x1', name: '' }, { ...good, code: 'x2', priceCents: -5 }, { ...good, code: 'x3', billingInterval: 'week' }, { ...good, code: 'x4', maxStaff: 'many' }]) {
    assert.equal((await mk(bad)).status, 400, JSON.stringify(bad));
  }
  const edit = await t.call('PUT', '/api/admin/plans/enterprise', { token: admin.token, body: { priceCents: 31900, maxMenuItems: 5000 } });
  assert.equal(edit.body.data.plan.priceCents, 31900);
  assert.equal(edit.body.data.plan.maxMenuItems, 5000);
  assert.ok((await t.call('GET', '/api/public/plans')).body.data.plans.some((p) => p.code === 'enterprise'));
  const off = await t.call('PUT', '/api/admin/plans/enterprise', { token: admin.token, body: { isActive: false } });
  assert.equal(off.body.data.plan.isActive, false);
  assert.ok(!(await t.call('GET', '/api/public/plans')).body.data.plans.some((p) => p.code === 'enterprise'));
  assert.ok(!(await t.call('GET', '/api/manage/subscription', { token: owner.token })).body.data.plans.some((p) => p.code === 'enterprise'));
  const sel = await t.call('POST', '/api/manage/subscription/change', { token: owner.token, body: { planCode: 'enterprise' } });
  assert.equal(sel.status, 404);
  // seeded defaults exist and none is hard-wired: the admin may rename them
  assert.ok((await t.call('GET', '/api/admin/plans', { token: admin.token })).body.data.plans.length >= 5);
  assert.equal((await t.call('PUT', '/api/admin/plans/free', { token: admin.token, body: { name: 'Community' } })).body.data.plan.name, 'Community');
  await t.call('PUT', '/api/admin/plans/free', { token: admin.token, body: { name: 'Free' } });
});

test('restaurant details for admins; delete only without financial history; customers/system/subscriptions views', async () => {
  const o = await t.createRestaurantOwner('Detail Diner', 'pro');
  const p = await t.addProduct(o);
  const c = await t.registerCustomer('Detail Customer');
  await t.placeOrder(o, c, [{ productId: p.id, quantity: 1 }]);
  const d = (await t.call('GET', `/api/admin/restaurants/${o.restaurant.id}`, { token: admin.token })).body.data;
  assert.equal(d.restaurant.ownerEmail, o.email);
  assert.equal(d.subscription.plan.code, 'pro');
  assert.equal(d.recentOrders.length, 1);
  assert.equal(d.earnings.orders, 1);
  assert.ok(Array.isArray(d.payouts) && Array.isArray(d.invoices) && Array.isArray(d.staff));
  assert.equal(d.reportLast30Days.orders, 1);
  // has orders -> cannot be deleted, must be suspended
  const del = await t.call('DELETE', `/api/admin/restaurants/${o.restaurant.id}`, { token: admin.token });
  assert.equal(del.status, 409);
  assert.equal(del.body.error.code, 'has_history');
  // an empty restaurant can be deleted; its owner account survives
  const e = await t.createRestaurantOwner('Empty Eatery');
  const st = await t.call('POST', '/api/manage/staff', { token: e.token, body: { name: 'S', email: `${t.unique('s')}@t.test`, password: 'Passw0rd!' } });
  assert.equal(st.status, 201);
  assert.equal((await t.call('DELETE', `/api/admin/restaurants/${e.restaurant.id}`, { token: owner.token })).status, 403);
  assert.equal((await t.call('DELETE', `/api/admin/restaurants/${e.restaurant.id}`, { token: admin.token })).status, 200);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM restaurants WHERE id = ?').get(e.restaurant.id).c, 0);
  assert.equal(t.db.prepare('SELECT restaurant_id FROM users WHERE email = ?').get(e.email).restaurant_id, null);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM users WHERE email = ?').get(st.body.data.staff.email).c, 0);
  assert.equal((await t.call('DELETE', '/api/admin/restaurants/999999', { token: admin.token })).status, 404);

  const cu = await t.call('GET', `/api/admin/customers?q=${encodeURIComponent('Detail Customer')}`, { token: admin.token });
  assert.equal(cu.body.data.total, 1);
  assert.equal(cu.body.data.customers[0].orders, 1);
  assert.ok(!JSON.stringify(cu.body).match(/password/i));
  const sys = (await t.call('GET', '/api/admin/system', { token: admin.token })).body.data;
  assert.match(sys.database.engine, /^(sqlite|postgresql)$/);
  assert.match(sys.database.recommendation, /PostgreSQL/);
  assert.ok(sys.database.migrations.length >= (sys.database.engine === 'postgresql' ? 1 : 3));
  assert.ok(!JSON.stringify(sys).match(/secret|password|sk_/i));
  const subs = (await t.call('GET', '/api/admin/subscriptions?status=active', { token: admin.token })).body.data;
  assert.ok(subs.subscriptions.length >= 1 && subs.subscriptions.every((s) => s.status === 'active'));
  assert.equal((await t.call('GET', '/api/admin/subscriptions', { token: owner.token })).status, 403);
  assert.equal((await t.call('GET', '/api/admin/system', { token: owner.token })).status, 403);
});

test('TENANT URLs: /r/<slug>, <slug>.<base-domain> and custom domains resolve the right restaurant; nothing else', async () => {
  const o = await t.createRestaurantOwner('Subdomain Bistro', 'pro');
  const slug = o.restaurant.slug;
  assert.match(await (await page(`/r/${slug}`)).text(), /restaurant\.js/);
  assert.match(await (await page(`/restaurant/${slug}`)).text(), /restaurant\.js/);
  t.config.tenantBaseDomain = 'platform.test';
  try {
    const sub = await rawGet('/', `${slug}.platform.test`);
    assert.equal(sub.status, 200);
    assert.match(sub.body, new RegExp(`<meta name="tenant-slug" content="${slug}">`));
    assert.match(sub.body, /restaurant\.js/);
    // the platform's own host and reserved/unknown subdomains do not become tenants
    for (const host of ['platform.test', 'www.platform.test', 'admin.platform.test', 'api.platform.test', 'nope-nobody.platform.test', 'evil.com']) {
      const r = await rawGet('/', host);
      assert.ok(!r.body.includes('tenant-slug'), host);
    }
    // an unapproved restaurant is not served on its subdomain
    const pend = await t.createRestaurantOwner('Pending Place', null, { approve: false });
    assert.ok(!(await rawGet('/', `${pend.restaurant.slug}.platform.test`)).body.includes('tenant-slug'));
    // custom domains
    t.db.prepare('UPDATE restaurants SET custom_domain = ? WHERE id = ?').run('order.bistro.example', o.restaurant.id);
    assert.match((await rawGet('/', 'order.bistro.example')).body, new RegExp(`content="${slug}"`));
    assert.ok(!(await rawGet('/', 'order.other.example')).body.includes('tenant-slug'));
    // a tenant host only changes WHICH public page is shown; private data stays scoped to the signed-in user
    const viaHost = await fetch(`${t.base}/api/manage/orders`, { headers: { Host: `${slug}.platform.test`, Authorization: `Bearer ${customer.token}` } });
    assert.equal(viaHost.status, 403);
  } finally { t.config.tenantBaseDomain = ''; }
  // slug is escaped even if somebody stored something odd
  t.db.prepare("UPDATE restaurants SET custom_domain = 'x.inject.example', slug = ? WHERE id = ?").run('a"><script>alert(1)</script>', o.restaurant.id);
  assert.ok(!(await rawGet('/', 'x.inject.example')).body.includes('<script>alert'));
});

test('WhatsApp links are always valid wa.me digit-only URLs (platform number and restaurant numbers)', async () => {
  const o = await t.createRestaurantOwner('Chat Cafe', 'pro');
  assert.equal((await t.call('PUT', '/api/manage/restaurant', { token: o.token, body: { whatsapp: '+966 50 111-2222' } })).status, 200);
  const pub = await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`);
  assert.match(pub.body.data.whatsappUrl, /^https:\/\/wa\.me\/966501112222\?text=/);
  const cfg = (await t.call('GET', '/api/public/config')).body.data;
  assert.match(cfg.whatsappUrl, /^https:\/\/wa\.me\/966566148975\?text=/);
  t.db.prepare('UPDATE restaurants SET whatsapp = ? WHERE id = ?').run('00966501112222', o.restaurant.id);
  assert.match((await t.call('GET', `/api/public/restaurants/${o.restaurant.slug}`)).body.data.whatsappUrl, /^https:\/\/wa\.me\/966501112222\?/);
});

test('operator recovery: resetting an admin\'s 2FA signs them out and lets them enrol again (audited)', async () => {
  const { resetAdminTwoFactor } = require('../server/services/seedData');
  const a = await t.createAdminUser();
  const s = await t.call('POST', '/api/auth/2fa/setup', { token: a.token, body: {} });
  const e = await t.call('POST', '/api/auth/2fa/enable', { token: a.token, body: { code: totp.codeAt(s.body.data.secret) } });
  assert.equal(e.status, 200);
  assert.equal(resetAdminTwoFactor(t.db, 'nobody@t.test'), false);
  assert.equal(resetAdminTwoFactor(t.db, owner.email), false); // only super_admin accounts
  assert.equal(resetAdminTwoFactor(t.db, a.email), true);
  assert.equal((await t.call('GET', '/api/admin/dashboard', { token: e.body.data.token })).status, 401); // old sessions revoked
  const login = await t.call('POST', '/api/auth/login', { body: { email: a.email, password: 'Passw0rd!' } });
  assert.equal(login.body.data.mfaRequired, undefined);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM backup_codes WHERE user_id = ?').get(a.user.id).c, 0);
  assert.equal(t.db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action = 'admin.2fa_reset_cli'").get().c >= 1, true);
});
