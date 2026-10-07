const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startApp } = require('./helpers');
const payouts = require('../server/services/payouts');

// Provider interactions here use the local Tap TEST DOUBLE (tests/fakeTap.js): they prove our logic, not Tap's behaviour.
let t;
before(async () => { t = await startApp({ tap: true }); });
after(async () => { await t.close(); });

const ROOT = path.join(__dirname, '..');
const run = (args, env = {}) => spawnSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env }, encoding: 'utf8' });
const payRow = (orderId) => t.db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);
const SQL_PRELUDE = "process.removeAllListeners('warning');const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.DATABASE_PATH);";

test('GET /health reports app + database health and exposes no configuration', async () => {
  const r = await t.call('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
  assert.equal(r.body.database, 'ok');
  assert.deepEqual(Object.keys(r.body).sort(), ['database', 'status', 'uptimeSeconds']);
  assert.ok(!/secret|key|sk_|AUTH|password|apiBase/i.test(r.text));
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('config: TAP_* / SMTP_PASSWORD aliases, DATABASE_URL handling, unsupported currency', () => {
  const script = "const c=require('./server/config');console.log(JSON.stringify({dialect:c.dbDialect,p:c.paymentProvider,k:c.payment.secretKey,m:c.payment.merchantId,w:c.payment.webhookSecret,s:c.mail.pass,db:c.databasePath}))";
  const probe = (env) => run(['-e', script], {
    AUTH_SECRET: 'x'.repeat(40), NODE_ENV: 'development', PAYMENT_PROVIDER: '', PAYMENT_SECRET_KEY: '', PAYMENT_MERCHANT_ID: '', PAYMENT_WEBHOOK_SECRET: '',
    TAP_SECRET_KEY: '', TAP_MERCHANT_ID: '', TAP_WEBHOOK_SECRET: '', SMTP_PASS: '', SMTP_PASSWORD: '', DATABASE_PATH: '', DATABASE_URL: '', CURRENCY: '', ...env,
  });
  const a = probe({ TAP_SECRET_KEY: 'sk_test_x', TAP_MERCHANT_ID: 'merchant_1', TAP_WEBHOOK_SECRET: 'whs', SMTP_PASSWORD: 'smtp-pw' });
  assert.equal(a.status, 0, a.stderr);
  const got = JSON.parse(a.stdout);
  delete got.dialect;
  assert.deepEqual({ ...got, db: '' }, { p: 'tap', k: 'sk_test_x', m: 'merchant_1', w: 'whs', s: 'smtp-pw', db: '' });
  const b = probe({ DATABASE_URL: 'sqlite:./data/custom.db' });
  assert.match(JSON.parse(b.stdout).db, /custom\.db$/);
  // a postgres:// URL selects PostgreSQL (it never silently falls back to a SQLite file); garbage is refused without echoing it
  const c = probe({ DATABASE_URL: 'postgres://u:p@localhost:5432/foodies' });
  assert.equal(c.status, 0, c.stderr);
  assert.equal(JSON.parse(c.stdout).dialect, 'postgres');
  const d = probe({ DATABASE_URL: 'mysql://u:secretpw@localhost/x' });
  assert.notEqual(d.status, 0);
  assert.ok(!d.stderr.includes('secretpw'), 'the connection string must not be echoed');
  assert.notEqual(probe({ CURRENCY: 'KWD' }).status, 0); // 3-decimal currency would be mis-scaled by cents arithmetic
});

test('backup + restore: a live database is snapshotted and restored with identical data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodies-bak-'));
  const dbFile = path.join(dir, 'app.db');
  const env = { DATABASE_PATH: dbFile, DATABASE_URL: '', UPLOAD_DIR: path.join(dir, 'uploads'), BACKUP_DIR: path.join(dir, 'backups'), AUTH_SECRET: 'x'.repeat(40), NODE_ENV: 'development' };
  assert.equal(run(['server/migrate.js'], env).status, 0);
  const ins = run(['-e', `${SQL_PRELUDE}d.exec("INSERT INTO users (email,password_hash,name,role) VALUES ('keep@t.test','h','Keep','customer')")`], env);
  assert.equal(ins.status, 0, ins.stderr);
  const b = run(['scripts/backup.js'], env);
  assert.equal(b.status, 0, b.stderr);
  const snap = fs.readdirSync(env.BACKUP_DIR)[0];
  // disaster: the live DB is lost
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });
  const r = run(['scripts/restore.js', path.join(env.BACKUP_DIR, snap)], env);
  assert.equal(r.status, 0, r.stderr);
  const q = run(['-e', `${SQL_PRELUDE}console.log(d.prepare("SELECT COUNT(*) c FROM users WHERE email='keep@t.test'").get().c, d.prepare('PRAGMA integrity_check').get().integrity_check)`], env);
  assert.equal(q.stdout.trim(), '1 ok');
  assert.notEqual(run(['scripts/restore.js', path.join(dir, 'nope')], env).status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('FINAL END-TO-END: admin, restaurant, customer, card payment, webhook, delivery, payout; then verify the ledgers', async () => {
  // restaurant registers and creates a restaurant: pending until approved
  const owner = await t.createRestaurantOwner('E2E Kitchen', 'free', { approve: false, payoutAccount: true });
  const admin = await t.createAdminUser();
  const A = (m, p, body) => t.call(m, `/api/admin${p}`, { token: admin.token, body });
  const rid = owner.restaurant.id;
  const dish = await t.addProduct(owner, { priceCents: 2500, name: 'E2E Burger' });
  assert.equal((await t.call('GET', `/api/public/restaurants/${owner.restaurant.slug}`)).status, 404, 'pending restaurants are invisible');
  assert.equal((await t.call('GET', '/api/admin/dashboard', { token: admin.token })).status, 200);

  // admin approves, assigns a plan, views subscription and restaurant
  assert.equal((await A('POST', `/restaurants/${rid}/approve`, {})).status, 200);
  assert.equal((await A('PUT', `/restaurants/${rid}/subscription`, { planCode: 'pro', status: 'active' })).status, 200);
  assert.ok(JSON.stringify((await A('GET', '/subscriptions')).body).includes(owner.restaurant.name));
  assert.equal((await A('GET', `/restaurants/${rid}`)).status, 200);
  assert.equal((await t.call('GET', '/api/manage/subscription', { token: owner.token })).status, 200);
  assert.equal((await t.call('GET', `/api/public/restaurants/${owner.restaurant.slug}`)).status, 200, 'approved restaurants are public');

  // customer: checkout by card, pay on the (fake) hosted page, webhook, track
  const cust = await t.registerCustomer();
  const order = await t.placeOrder(owner, cust, [{ productId: dish.id, quantity: 3 }], { paymentMethod: 'card' });
  assert.equal(order.status, 201, order.text);
  const oid = order.body.data.order.id;
  assert.match(order.body.data.paymentUrl, /^https:\/\//);
  const charge = payRow(oid).provider_transaction_id;
  t.fake.capture(charge);
  const wh = t.fake.webhookFor(charge);
  assert.equal((await t.call('POST', '/webhooks/tap', { body: wh.body, headers: wh.headers })).status, 200);
  assert.equal(t.db.prepare('SELECT payment_status FROM orders WHERE id = ?').get(oid).payment_status, 'paid');

  // restaurant sees the order and delivers it; the customer tracks it
  assert.equal((await t.call('GET', '/api/orders', { token: owner.token })).body.data.orders.length, 1);
  for (const st of ['confirmed', 'preparing', 'ready', 'delivered']) {
    assert.equal((await t.call('PATCH', `/api/manage/orders/${oid}/status`, { token: owner.token, body: { status: st } })).status, 200);
  }
  assert.equal((await t.call('GET', `/api/me/orders/${oid}`, { token: cust.token })).status, 200);
  assert.equal(t.db.prepare('SELECT status FROM orders WHERE id = ?').get(oid).status, 'delivered');

  // money: gross 7500, commission 750 (10%), restaurant 6750; split sent to Tap = restaurant share only; no SaaS invoice touched
  assert.equal((await t.call('GET', '/api/manage/earnings', { token: owner.token })).status, 200);
  const sale = t.db.prepare("SELECT * FROM ledger_entries WHERE order_id = ? AND entry_type = 'sale'").get(oid);
  assert.equal(sale.gross_amount_cents, 7500);
  assert.equal(sale.platform_commission_cents, 750);
  assert.equal(sale.restaurant_amount_cents, 6750);
  assert.equal(t.fake.calls.filter((c) => c.url === '/charges').pop().body.destinations.destination[0].amount, 67.5);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM saas_invoices WHERE restaurant_id = ?').get(rid).c, 0);

  // weekly payout: one per week, never duplicated, failed -> retry -> paid, paid is final
  const now = new Date('2026-03-12T09:00:00Z');
  const period = payouts.lastFullWeek(now);
  t.db.prepare('UPDATE ledger_entries SET eligible_at = ? WHERE order_id = ?').run(`${period.periodStart}T12:00:00.000Z`, oid);
  payouts.generateWeeklyPayouts(t.db, { now });
  payouts.generateWeeklyPayouts(t.db, { now });
  const rows = t.db.prepare('SELECT * FROM payouts WHERE restaurant_id = ?').all(rid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount_cents, 6750);
  assert.equal((await A('GET', '/payouts')).status, 200);
  assert.equal((await t.call('GET', '/api/payouts', { token: owner.token })).body.data.payouts.length, 1);
  const pid = rows[0].id;
  assert.ok((await A('PATCH', `/payouts/${pid}`, { status: 'paid', reference: 'BANK-0' })).status >= 400, 'an admin cannot mark a payout paid directly');
  assert.equal((await A('PATCH', `/payouts/${pid}`, { status: 'manual_payout' })).status, 200);
  assert.equal((await A('PATCH', `/payouts/${pid}`, { status: 'failed', failureReason: 'bank rejected' })).status, 200);
  assert.equal((await A('PATCH', `/payouts/${pid}`, { status: 'pending' })).status, 200);
  assert.equal((await A('PATCH', `/payouts/${pid}`, { status: 'manual_payout' })).status, 200);
  assert.equal((await A('PATCH', `/payouts/${pid}`, { status: 'paid', reference: 'BANK-123' })).status, 200);
  assert.ok((await A('PATCH', `/payouts/${pid}`, { status: 'pending' })).status >= 400, 'a paid payout cannot be reopened');
  assert.equal(payouts.generateForRestaurant(t.db, rid, period).skipped, 'already_generated');
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE payout_id = ?').get(pid).c, 1);

  for (const p of ['/payments', '/refunds', '/orders', '/balances', '/reports/revenue']) assert.equal((await A('GET', p)).status, 200, p);
});

test('concurrent refunds with different keys can never refund more than was paid', async () => {
  const o = await t.createRestaurantOwner('Race Kitchen', 'pro', { payoutAccount: true });
  const p = await t.addProduct(o, { priceCents: 10000 });
  const c = await t.registerCustomer();
  const admin = await t.createAdminUser();
  const r = await t.placeOrder(o, c, [{ productId: p.id, quantity: 1 }], { paymentMethod: 'card' });
  const oid = r.body.data.order.id;
  const charge = payRow(oid).provider_transaction_id;
  t.fake.capture(charge);
  const wh = t.fake.webhookFor(charge);
  await t.call('POST', '/webhooks/tap', { body: wh.body, headers: wh.headers });
  const pay = payRow(oid);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    t.call('POST', `/api/admin/payments/${pay.id}/refund`, { token: admin.token, body: { amountCents: 3000, reason: 'race' }, headers: { 'Idempotency-Key': `race-key-${i}-${Date.now()}` } })));
  assert.equal(results.filter((x) => x.status === 201).length, 3, results.map((x) => x.status).join(','));
  assert.equal(payRow(oid).refunded_cents, 9000);
  const sum = t.db.prepare("SELECT COALESCE(SUM(amount_cents),0) s FROM refunds WHERE payment_id = ? AND status = 'succeeded'").get(pay.id).s;
  assert.equal(sum, 9000);
});

test('a signed webhook whose provider-side amount, currency or order reference disagrees never confirms the order', async () => {
  const o = await t.createRestaurantOwner('Verify Kitchen', 'pro', { payoutAccount: true });
  const p = await t.addProduct(o, { priceCents: 5000 });
  const c = await t.registerCustomer();
  for (const bad of [{ amount: 1 }, { currency: 'EUR' }, { reference: { order: 'ord_999999' } }]) {
    const r = await t.placeOrder(o, c, [{ productId: p.id, quantity: 1 }], { paymentMethod: 'card' });
    const oid = r.body.data.order.id;
    const charge = payRow(oid).provider_transaction_id;
    const ch = t.fake.charges.get(charge);
    t.fake.capture(charge);
    Object.assign(ch, bad, bad.reference ? { reference: { ...ch.reference, ...bad.reference } } : {});
    const w = t.fake.webhookFor(charge); // correctly signed, but the provider record disagrees with our order
    await t.call('POST', '/webhooks/tap', { body: w.body, headers: w.headers });
    const row = t.db.prepare('SELECT payment_status, status FROM orders WHERE id = ?').get(oid);
    assert.notEqual(row.payment_status, 'paid', JSON.stringify(bad));
    assert.equal(t.db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE order_id = ?').get(oid).c, 0);
  }
});
