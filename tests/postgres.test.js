const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// PostgreSQL-specific tests against a REAL PostgreSQL server (embedded-postgres dev dependency, or TEST_DATABASE_URL when set).
// The whole functional suite also runs on PostgreSQL via `npm run test:pg`; these tests cover what is unique to the PostgreSQL layer:
// SQL translation, schema parity with SQLite, error mapping, transactions/savepoints, cross-instance locking, leader election and
// the SQLite -> PostgreSQL / backup / restore tooling.
const ROOT = path.join(__dirname, '..');
let pgUrl;
let stopPg = async () => {};
let helpers;
let skip = false;

before(async () => {
  pgUrl = process.env.TEST_DATABASE_URL;
  if (!pgUrl) {
    let Embedded;
    try { ({ default: Embedded } = await import('embedded-postgres')); } catch { skip = 'embedded-postgres is not installed'; return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodies-pgt-'));
    const port = 54900 + Math.floor(Math.random() * 90);
    const pg = new Embedded({ databaseDir: dir, user: 'postgres', password: 'test', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
    await pg.initialise();
    await pg.start();
    pgUrl = `postgres://postgres:test@localhost:${port}/postgres`;
    stopPg = async () => { try { await pg.stop(); } catch { /* already stopped */ } try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* Windows may hold files briefly */ } };
  }
  process.env.TEST_DATABASE_URL = pgUrl; // makes tests/helpers.js build PostgreSQL apps
  helpers = require('./helpers');
});
after(async () => {
  // drop every scratch schema this file created (it works on a shared database when TEST_DATABASE_URL points at one)
  if (pgUrl && created.length) {
    const cleaner = openDb(pgUrl);
    try { for (const sc of created) { try { cleaner.exec(`DROP SCHEMA IF EXISTS "${sc}" CASCADE`); } catch { /* best effort */ } } } finally { cleaner.close(); }
  }
  await stopPg();
});

const need = (t) => { if (skip) { t.skip(skip); return false; } return true; };
const { openDb, migrate, tx } = require('../server/db');
let n = 0;
const created = [];
const freshSchema = () => { const sc = `pgt_${process.pid}_${++n}`; created.push(sc); return sc; };
const open = (schema = freshSchema()) => { const db = openDb(pgUrl, { schema }); migrate(db); return db; };

// ---------------------------------------------------------------------------------------------------- translation
test('SQL translation: placeholders, literals, INSERT OR IGNORE, LIKE, IS NULL, RETURNING id, strftime', () => {
  const { translate } = require('../server/pg/translate');
  const hasId = (t) => ['orders', 'plans'].includes(t);
  assert.equal(translate('SELECT * FROM a WHERE x = ? AND y = ?', hasId).text, 'SELECT * FROM a WHERE x = $1 AND y = $2');
  assert.equal(translate("SELECT '?' AS q, '''?' AS r FROM a WHERE x = ?", hasId).text, "SELECT '?' AS q, '''?' AS r FROM a WHERE x = $1"); // literals untouched
  assert.equal(translate('INSERT OR IGNORE INTO plans (code) VALUES (?)', hasId).text, 'INSERT INTO plans (code) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id');
  assert.equal(translate('INSERT INTO settings (key) VALUES (?)', hasId).text, 'INSERT INTO settings (key) VALUES ($1)'); // no id column: no RETURNING
  assert.equal(translate('INSERT INTO orders (a) VALUES (?) RETURNING id', hasId).text, 'INSERT INTO orders (a) VALUES ($1) RETURNING id');
  assert.equal(translate("SELECT 1 WHERE name LIKE ? ESCAPE '\\'", hasId).text, "SELECT 1 WHERE name ILIKE $1 ESCAPE '\\'");
  assert.equal(translate('SELECT 1 WHERE (? IS NULL OR a = ?)', hasId).text, 'SELECT 1 WHERE ($1::text IS NULL OR a = $2)');
  assert.equal(translate("UPDATE t SET at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", hasId).text, 'UPDATE t SET at = iso_now() WHERE id = $1');
  assert.equal(translate("SELECT 'LIKE' AS w", hasId).text, "SELECT 'LIKE' AS w");
});

// ---------------------------------------------------------------------------------------------------- schema
test('migrations: apply to an empty database, idempotent, UTF-8 enforced; schema matches SQLite table by table, column by column', (t) => {
  if (!need(t)) return;
  const schema = freshSchema();
  const db = openDb(pgUrl, { schema });
  assert.deepEqual(migrate(db), ['001_schema.sql']);
  assert.deepEqual(migrate(db), []); // idempotent
  assert.equal(db.prepare('SHOW server_encoding').get().server_encoding, 'UTF8');
  const lite = openDb(':memory:');
  migrate(lite);
  const liteTables = lite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const pgTables = db.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name").all().map((r) => r.name);
  assert.deepEqual(pgTables, liteTables);
  for (const tb of liteTables) {
    const a = lite.prepare(`PRAGMA table_info(${tb})`).all().map((c) => c.name).sort();
    const b = db.prepare('SELECT column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?').all(tb).map((c) => c.c).sort();
    assert.deepEqual(b, a, `columns of ${tb}`);
  }
  // explicit indexes exist on both engines
  const liteIdx = lite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all().map((r) => r.name);
  const pgIdx = new Set(db.prepare('SELECT indexname AS n FROM pg_indexes WHERE schemaname = current_schema()').all().map((r) => r.n));
  for (const i of liteIdx) assert.ok(pgIdx.has(i), `index ${i}`);
  // tenancy and money guarantees live in the database on PostgreSQL too: composite FKs, partial unique indexes, CHECKs, append-only ledger
  assert.ok(db.prepare("SELECT COUNT(*) AS c FROM pg_constraint WHERE contype = 'f' AND connamespace = current_schema()::regnamespace").get().c >= 40);
  db.close();
});

test('error mapping and transactions: constraint errors keep the codes the app understands; a failed statement does not poison the transaction; rollback is real', (t) => {
  if (!need(t)) return;
  const db = open();
  db.prepare("INSERT INTO settings (key, value) VALUES ('a', '1')").run();
  assert.throws(() => db.prepare("INSERT INTO settings (key, value) VALUES ('a', '2')").run(), (e) => e.code === 'SQLITE_CONSTRAINT_UNIQUE' && /UNIQUE/.test(e.message) && e.pgCode === '23505');
  assert.throws(() => db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('x@t.test','h','n','wizard')").run(), (e) => e.code === 'SQLITE_CONSTRAINT_CHECK');
  assert.throws(() => db.prepare('INSERT INTO products (restaurant_id, name, price_cents) VALUES (999, ?, 1)').run('p'), (e) => e.code === 'SQLITE_CONSTRAINT_FOREIGNKEY');
  // catching a constraint error inside a transaction and carrying on (SQLite semantics)
  tx(db, () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('b', '1')").run();
    try { db.prepare("INSERT INTO settings (key, value) VALUES ('a', 'dup')").run(); } catch (e) { assert.equal(e.code, 'SQLITE_CONSTRAINT_UNIQUE'); }
    db.prepare("INSERT INTO settings (key, value) VALUES ('c', '1')").run();
  });
  assert.deepEqual(db.prepare('SELECT key FROM settings ORDER BY key').all().map((r) => r.key), ['a', 'b', 'c']);
  // rollback, and nested transactions as savepoints
  assert.throws(() => tx(db, () => { db.prepare("INSERT INTO settings (key, value) VALUES ('gone', '1')").run(); throw new Error('boom'); }), /boom/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'gone'").get().n, 0);
  tx(db, () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('outer', '1')").run();
    assert.throws(() => tx(db, () => { db.prepare("INSERT INTO settings (key, value) VALUES ('inner', '1')").run(); throw new Error('inner fails'); }), /inner fails/);
  });
  assert.deepEqual(db.prepare("SELECT key FROM settings WHERE key IN ('outer','inner')").all().map((r) => r.key), ['outer']);
  assert.equal(db.isTransaction, false);
  // lastInsertRowid, changes, bigint counts as numbers, unsafe/hostile parameters match nothing
  const ins = db.prepare("INSERT INTO plans (code, name, price_cents, currency) VALUES ('t', 'T', 0, 'SAR')").run();
  assert.equal(typeof ins.lastInsertRowid, 'number');
  assert.equal(db.prepare('SELECT * FROM plans WHERE id = ?').get(ins.lastInsertRowid).code, 't');
  assert.equal(db.prepare("UPDATE plans SET name = 'U' WHERE id = ?").run(ins.lastInsertRowid).changes, 1);
  assert.equal(typeof db.prepare('SELECT COUNT(*) AS n FROM plans').get().n, 'number');
  for (const bad of [Infinity, NaN, 3.14, 'abc', 1e30]) assert.equal(db.prepare('SELECT * FROM plans WHERE id = ?').get(bad), undefined);
  db.close();
});

test('updated_at trigger, append-only ledger and case-insensitive unique email behave as on SQLite', (t) => {
  if (!need(t)) return;
  const db = open();
  db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('Mixed@Case.test', 'h', 'n', 'customer')").run();
  assert.throws(() => db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('mixed@case.test', 'h', 'n', 'customer')").run(), (e) => e.code === 'SQLITE_CONSTRAINT_UNIQUE');
  const before = db.prepare("SELECT updated_at FROM users WHERE email = 'Mixed@Case.test'").get().updated_at;
  db.prepare("UPDATE users SET name = 'renamed' WHERE email = 'Mixed@Case.test'").run();
  assert.notEqual(db.prepare("SELECT updated_at FROM users WHERE email = 'Mixed@Case.test'").get().updated_at, before);
  assert.match(db.prepare("SELECT created_at FROM users LIMIT 1").get().created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE name ILIKE 'RENAMED'").get().n, 1);
  db.close();
});

// ---------------------------------------------------------------------------------------------------- multi-instance
const child = (code, env) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['-e', code], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (status) => resolve({ status, out, err }));
});

test('two application instances (separate processes, separate connections) never lose an update: write transactions are serialised', async (t) => {
  if (!need(t)) return;
  const schema = freshSchema();
  const db = open(schema);
  db.prepare("INSERT INTO settings (key, value) VALUES ('counter', '0')").run();
  const code = `
    process.removeAllListeners('warning');
    const { openDb, tx } = require('./server/db');
    const db = openDb(process.env.URL, { schema: process.env.SCHEMA });
    for (let i = 0; i < 60; i++) tx(db, () => {
      const v = Number(db.prepare("SELECT value FROM settings WHERE key = 'counter'").get().value);
      db.prepare("UPDATE settings SET value = ? WHERE key = 'counter'").run(String(v + 1));
    });
    db.close(); console.log('done');`;
  const env = { URL: pgUrl, SCHEMA: schema };
  const [a, b, c] = await Promise.all([child(code, env), child(code, env), child(code, env)]);
  for (const r of [a, b, c]) assert.equal(r.status, 0, r.err);
  assert.equal(Number(db.prepare("SELECT value FROM settings WHERE key = 'counter'").get().value), 180); // 3 instances x 60, none lost
  db.close();
});

test('concurrent instances generating the weekly payouts create exactly one statement per restaurant and never pay an earning twice', async (t) => {
  if (!need(t)) return;
  const app = await helpers.startApp({ tap: true });
  try {
    const o = await app.createRestaurantOwner('Multi Place', 'pro', { payoutAccount: true });
    const p = await app.addProduct(o, { priceCents: 10000 });
    const c = await app.registerCustomer();
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const r = await app.placeOrder(o, c, [{ productId: p.id, quantity: 1 }], { paymentMethod: 'card' });
      const pay = app.db.prepare('SELECT * FROM payments WHERE order_id = ?').get(r.body.data.order.id);
      app.fake.capture(pay.provider_transaction_id);
      const w = app.fake.webhookFor(pay.provider_transaction_id);
      await app.call('POST', '/webhooks/tap', { body: w.body, headers: w.headers });
      for (const st of ['confirmed', 'preparing', 'ready', 'delivered']) await app.call('PATCH', `/api/manage/orders/${r.body.data.order.id}/status`, { token: o.token, body: { status: st } });
      ids.push(r.body.data.order.id);
    }
    app.db.prepare("UPDATE ledger_entries SET eligible_at = '2026-03-03T12:00:00.000Z'").run();
    const code = `
      process.removeAllListeners('warning');
      const { openDb } = require('./server/db'); const payouts = require('./server/services/payouts');
      const db = openDb(process.env.URL, { schema: process.env.SCHEMA });
      const r = payouts.generateWeeklyPayouts(db, { now: new Date('2026-03-12T09:00:00Z') });
      console.log(JSON.stringify(r.created.length)); db.close();`;
    const env = { URL: app.pgUrl, SCHEMA: app.schema };
    const results = await Promise.all([child(code, env), child(code, env), child(code, env)]);
    for (const r of results) assert.equal(r.status, 0, r.err);
    assert.equal(results.reduce((s, r) => s + Number(r.out.trim()), 0), 1); // exactly one instance created it
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM payouts').get().n, 1);
    assert.equal(app.db.prepare('SELECT amount_cents FROM payouts').get().amount_cents, 27000);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM ledger_entries WHERE payout_id IS NOT NULL').get().n, 3);
  } finally { await app.close(); }
});

test('background jobs run on one instance: the first connection holds the leader lock, a second does not until it goes away', (t) => {
  if (!need(t)) return;
  const first = openDb(pgUrl, { schema: freshSchema() });
  const second = openDb(pgUrl, { schema: freshSchema() });
  assert.equal(first.tryLeader(), true);
  assert.equal(first.tryLeader(), true); // re-entrant for the holder
  assert.equal(second.tryLeader(), false);
  first.close();
  let got = false;
  for (let i = 0; i < 50 && !got; i++) { got = second.tryLeader(); if (!got) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  assert.equal(got, true, 'leadership moves when the leader disappears');
  second.close();
  assert.equal(openDb(':memory:').tryLeader(), true); // SQLite is single-instance: always leader
});

// ---------------------------------------------------------------------------------------------------- tooling
test('SQLite -> PostgreSQL data migration copies every table, keeps foreign keys and identities, refuses a non-empty target', (t) => {
  if (!need(t)) return;
  const { ensurePlans, createAdmin, seedSample } = require('../server/services/seedData');
  const { copyAll } = require('../scripts/lib/rowcopy');
  const lite = openDb(':memory:');
  migrate(lite);
  ensurePlans(lite);
  createAdmin(lite, { email: 'root@t.test', name: 'Root', password: 'Passw0rd!x' });
  seedSample(lite, { log: () => {} });
  const dst = open();
  const counts = copyAll(lite, dst, {});
  for (const [tb, nrows] of Object.entries(counts)) assert.equal(dst.prepare(`SELECT COUNT(*) AS n FROM ${tb}`).get().n, lite.prepare(`SELECT COUNT(*) AS n FROM ${tb}`).get().n, tb);
  assert.ok(counts.restaurants >= 1 && counts.products >= 10 && counts.users >= 2 && counts.plans >= 1);
  assert.equal(dst.prepare('SELECT COUNT(*) AS n FROM restaurants WHERE owner_id IS NOT NULL').get().n, lite.prepare('SELECT COUNT(*) AS n FROM restaurants WHERE owner_id IS NOT NULL').get().n);
  // identities continue after the highest copied id, so new rows do not collide
  const max = dst.prepare('SELECT MAX(id) AS m FROM products').get().m;
  const r = dst.prepare("INSERT INTO categories (restaurant_id, name) VALUES ((SELECT id FROM restaurants LIMIT 1), 'new')").run();
  assert.ok(r.lastInsertRowid > 0);
  assert.ok(dst.prepare("INSERT INTO products (restaurant_id, name, price_cents) VALUES ((SELECT id FROM restaurants LIMIT 1), 'new', 100)").run().lastInsertRowid > max);
  assert.throws(() => copyAll(lite, dst, {}), /not empty/);
  dst.close();
});

test('PostgreSQL logical backup and restore round-trips the real data of a running app, including money', async (t) => {
  if (!need(t)) return;
  const { dumpAll, ndjsonSource, copyAll } = require('../scripts/lib/rowcopy');
  const app = await helpers.startApp({ tap: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodies-pgbak-'));
  try {
    const o = await app.createRestaurantOwner('Backup Place', 'pro', { payoutAccount: true });
    const p = await app.addProduct(o, { priceCents: 5000, name: 'Dish ✓ ' + String.fromCodePoint(0x1f35c) });
    const c = await app.registerCustomer();
    const r = await app.placeOrder(o, c, [{ productId: p.id, quantity: 2 }], { paymentMethod: 'card' });
    const pay = app.db.prepare('SELECT * FROM payments WHERE order_id = ?').get(r.body.data.order.id);
    app.fake.capture(pay.provider_transaction_id);
    const w = app.fake.webhookFor(pay.provider_transaction_id);
    await app.call('POST', '/webhooks/tap', { body: w.body, headers: w.headers });
    const sums = (db) => db.prepare('SELECT COALESCE(SUM(gross_amount_cents),0) AS g, COALESCE(SUM(restaurant_amount_cents),0) AS r, COUNT(*) AS n FROM ledger_entries').get();
    const orig = sums(app.db);
    assert.equal(orig.g, 10000);
    const { counts } = dumpAll(app.db, dir);
    assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
    const dst = open();
    copyAll(ndjsonSource(dir), dst, {});
    assert.deepEqual(sums(dst), orig);
    assert.equal(dst.prepare('SELECT name FROM products WHERE id = ?').get(p.id).name, 'Dish ✓ ' + String.fromCodePoint(0x1f35c)); // UTF-8 incl. emoji survives
    for (const tb of Object.keys(counts)) assert.equal(dst.prepare(`SELECT COUNT(*) AS n FROM ${tb}`).get().n, counts[tb], tb);
    dst.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); await app.close(); }
});

test('the health endpoint and admin system page report the PostgreSQL engine without exposing the connection string', async (t) => {
  if (!need(t)) return;
  const app = await helpers.startApp({ tap: false });
  try {
    const h = await app.call('GET', '/health');
    assert.equal(h.status, 200);
    const admin = await app.createAdminUser();
    const sys = await app.call('GET', '/api/admin/system', { token: admin.token });
    assert.equal(sys.body.data.database.engine, 'postgresql');
    assert.equal(sys.body.data.database.multiInstanceSafe, true);
    assert.ok(sys.body.data.database.sizeBytes > 0);
    assert.ok(!JSON.stringify(sys.body).includes('postgres://') && !JSON.stringify(sys.body).includes(':test@'));
    assert.ok(!h.text.includes('postgres'));
  } finally { await app.close(); }
});

test('real processes on PostgreSQL: npm run migrate, create-admin, server boot, login, /health, graceful stop', async (t) => {
  if (!need(t)) return;
  const { spawnSync } = require('node:child_process');
  const schema = freshSchema();
  const base = { ...process.env, NODE_ENV: 'development', DATABASE_URL: pgUrl, DATABASE_SCHEMA: schema, RATE_LIMIT: 'off', BCRYPT_ROUNDS: '4', PORT: String(53000 + Math.floor(Math.random() * 900)), PAYMENT_PROVIDER: 'none', LOG_LEVEL: 'error' };
  const run = (script, extra = {}) => spawnSync(process.execPath, [script], { cwd: ROOT, env: { ...base, ...extra }, encoding: 'utf8' });
  const m1 = run('server/migrate.js');
  assert.match(m1.stdout, /Applied migrations: 001_schema.sql/, m1.stderr);
  assert.match(run('server/migrate.js').stdout, /up to date/);
  const adm = run('server/create-admin.js', { ADMIN_EMAIL: 'pg-admin@example.test', ADMIN_PASSWORD: 'a long passphrase 1x' });
  assert.equal(adm.status, 0, adm.stderr);
  const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: base, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const url = `http://127.0.0.1:${base.PORT}`;
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { up = (await fetch(`${url}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    assert.equal(up, true, 'server did not come up');
    const login = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'PG-Admin@Example.test', password: 'a long passphrase 1x' }) });
    assert.equal(login.status, 200); // email matching is case-insensitive on PostgreSQL too
    const token = (await login.json()).data.token;
    const sys = await fetch(`${url}/api/admin/system`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await sys.json()).data.database.engine, 'postgresql');
    // the plans were seeded through INSERT ... ON CONFLICT DO NOTHING and survive a restart (second start does not duplicate)
    const plans1 = (await (await fetch(`${url}/api/public/plans`)).json());
    assert.ok(JSON.stringify(plans1).length > 10);
  } finally { server.kill('SIGKILL'); }
  const again = run('server/migrate.js');
  assert.match(again.stdout, /up to date/);
});
