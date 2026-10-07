const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ADMIN_PW = 'Adm1n-Passphrase-For-Test';

function baseEnv(dir, extra = {}) {
  const env = { ...process.env };
  for (const k of ['JWT_SECRET', 'RATE_LIMIT', 'LOG_LEVEL', 'PAYMENT_SECRET_KEY', 'DEFAULT_PLAN']) delete env[k];
  return {
    ...env, NODE_ENV: 'production', APP_URL: 'https://shop.example.com', AUTH_SECRET: 'p'.repeat(48), BCRYPT_ROUNDS: '4',
    DATABASE_PATH: path.join(dir, 'prod.db'), UPLOAD_DIR: path.join(dir, 'uploads'), PORT: '0', LOG_LEVEL: 'debug',
    PAYMENT_PROVIDER: 'none', DATABASE_URL: '', TEST_DATABASE_URL: '', PAYMENT_ENV: 'production', CURRENCY: 'SAR', RATE_LIMIT: 'off', ...extra,
  };
}

test('production process: migrate, create admin, boot, serve, log safely, shut down gracefully', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodies-prod-'));
  const env = baseEnv(dir);
  const run = (script, extraEnv = {}) => spawnSync(process.execPath, [script], { cwd: ROOT, env: { ...env, ...extraEnv }, encoding: 'utf8' });

  assert.match(run('server/migrate.js').stdout, /Applied migrations: 001_init.sql, 002_marketplace.sql/);
  assert.match(run('server/migrate.js').stdout, /up to date/);
  const bad = run('server/create-admin.js', { ADMIN_EMAIL: 'boss@example.com', ADMIN_PASSWORD: 'short' });
  assert.notEqual(bad.status, 0);
  const made = run('server/create-admin.js', { ADMIN_EMAIL: 'boss@example.com', ADMIN_PASSWORD: ADMIN_PW });
  assert.match(made.stdout, /Admin account created/);
  assert.match(run('server/create-admin.js', { ADMIN_EMAIL: 'boss@example.com', ADMIN_PASSWORD: ADMIN_PW }).stdout, /already exists/);
  // sample data and demo accounts can never be loaded into production
  const sample = run('server/seed.js', {});
  assert.equal(sample.status, 0);
  const refused = spawnSync(process.execPath, ['server/seed.js', '--sample'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Refusing to load sample data/);

  // free port, then boot the real server
  const port = await new Promise((resolve) => { const s = require('node:net').createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...env, PORT: String(port) } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50 && !out.includes('server.started'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(out.includes('server.started'), out);

  try {
    const j = async (m, p, body, headers = {}) => {
      const r = await fetch(base + p, { method: m, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
    };
    assert.deepEqual((await j('GET', '/api/health')).body.data, { status: 'ok', database: 'ok', payments: 'disabled' });
    assert.equal((await fetch(`${base}/legacy/home.html`)).status, 404); // legacy sample site is not served in production
    const home = await fetch(base + '/');
    assert.match(home.headers.get('strict-transport-security') || '', /max-age=/);
    assert.match(home.headers.get('content-security-policy'), /upgrade-insecure-requests/);

    const SECRET_PW = 'Zx9-Very-Secret-Pw!';
    const reg = await j('POST', '/api/auth/register', { name: 'Log Tester', email: 'log@example.com', password: SECRET_PW });
    assert.equal(reg.status, 201);
    assert.match(reg.headers.getSetCookie().join(';'), /Secure/i); // cookie is Secure in production
    await j('POST', '/api/auth/login', { email: 'log@example.com', password: 'WrongPassw0rd' });
    const login = await j('POST', '/api/auth/login', { email: 'boss@example.com', password: ADMIN_PW });
    assert.equal(login.status, 200);
    let adminToken = login.body.data.token;
    // production requires two-factor authentication for admins: the admin API stays closed until they enrol
    const gated = await j('GET', '/api/admin/stats', null, { Authorization: `Bearer ${adminToken}` });
    assert.equal(gated.status, 403);
    assert.equal(gated.body.error.code, 'mfa_enrollment_required');
    const totp = require('../server/services/totp');
    const setup = await j('POST', '/api/auth/2fa/setup', {}, { Authorization: `Bearer ${adminToken}` });
    const enabled = await j('POST', '/api/auth/2fa/enable', { code: totp.codeAt(setup.body.data.secret) }, { Authorization: `Bearer ${adminToken}` });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.data.backupCodes.length, 8);
    adminToken = enabled.body.data.token;
    // from now on the password alone no longer signs the admin in
    const second = await j('POST', '/api/auth/login', { email: 'boss@example.com', password: ADMIN_PW });
    assert.equal(second.body.data.mfaRequired, true);
    assert.equal(second.body.data.token, undefined);
    await j('POST', '/api/auth/forgot-password', { email: 'log@example.com' });
    assert.equal((await j('POST', '/webhooks/tap', { id: 'chg_x', status: 'CAPTURED', amount: 1, currency: 'USD', card: '4242424242424242' }, { hashstring: 'deadbeef' })).status, 404); // no provider configured: webhooks do not exist
    assert.equal((await j('GET', '/api/admin/stats', null, { Authorization: `Bearer ${adminToken}` })).status, 200);
    assert.equal((await j('GET', '/api/admin/stats')).status, 401);
    await j('GET', '/api/does/not/exist');

    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    for (const forbidden of [SECRET_PW, ADMIN_PW, adminToken, setup.body.data.secret, 'p'.repeat(48), '4242424242424242', 'deadbeef', 'WrongPassw0rd']) {
      assert.ok(!out.includes(forbidden), `log output leaked a secret (${forbidden.slice(0, 4)}…)`);
    }
    const lines = out.trim().split('\n');
    assert.ok(lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), 'every log line is JSON');
    const events = lines.map((l) => JSON.parse(l).event);
    for (const e of ['server.started', 'auth.registered', 'auth.login_failed', 'auth.login', 'http']) assert.ok(events.includes(e), `missing log event ${e}`);
    // Windows has no POSIX signals (SIGTERM hard-kills the process), so the graceful-shutdown log can only be asserted elsewhere.
    if (process.platform !== 'win32') assert.ok(events.includes('server.stopping'));
  } finally { child.kill('SIGKILL'); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Windows may still hold the SQLite file for a moment; the temp dir is harmless */ } }
});

test('production refuses insecure configuration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodies-cfg-'));
  const tryConfig = (extra) => spawnSync(process.execPath, ['-e', "require('./server/config')"], { cwd: ROOT, env: baseEnv(dir, extra), encoding: 'utf8' });
  assert.notEqual(tryConfig({ APP_URL: 'http://shop.example.com' }).status, 0);
  assert.match(tryConfig({ APP_URL: 'http://shop.example.com' }).stderr, /APP_URL must be an https/);
  assert.notEqual(tryConfig({ PAYMENT_PROVIDER: 'tap' }).status, 0); // tap without a secret key
  assert.match(tryConfig({ PAYMENT_PROVIDER: 'tap' }).stderr, /PAYMENT_SECRET_KEY/);
  assert.notEqual(tryConfig({ PAYMENT_PROVIDER: 'paypal' }).status, 0);
  // sandbox and live credentials are never mixed: production needs a live key, and a live key needs PAYMENT_ENV=production
  assert.notEqual(tryConfig({ PAYMENT_PROVIDER: 'tap', PAYMENT_SECRET_KEY: 'sk_test_x' }).status, 0);
  assert.match(tryConfig({ PAYMENT_PROVIDER: 'tap', PAYMENT_SECRET_KEY: 'sk_test_x' }).stderr, /sandbox Tap key/);
  assert.equal(tryConfig({ PAYMENT_PROVIDER: 'tap', PAYMENT_SECRET_KEY: 'sk_live_x' }).status, 0);
  assert.notEqual(tryConfig({ PAYMENT_PROVIDER: 'tap', PAYMENT_SECRET_KEY: 'sk_live_x', PAYMENT_ENV: 'sandbox' }).status, 0);
  assert.equal(tryConfig({}).status, 0);
  assert.match(tryConfig({ CURRENCY: '' }).stderr, /CURRENCY must be set explicitly/); // no silent USD default in production
  fs.rmSync(dir, { recursive: true, force: true });
});
