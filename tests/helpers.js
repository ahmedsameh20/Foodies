// Tests must never touch a real database that happens to be configured in .env (DATABASE_URL); PostgreSQL tests opt in with TEST_DATABASE_URL only.
process.env.DATABASE_URL = '';
process.env.RATE_LIMIT = 'off';
process.env.BCRYPT_ROUNDS = '4';
process.env.AUTH_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.DEFAULT_PLAN = 'free';
process.env.PAYMENT_PROVIDER = 'none';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL || 'silent';
process.env.WHATSAPP_NUMBER = '00966566148975';
process.env.UPLOAD_DIR = require('node:path').join(require('node:os').tmpdir(), 'foodies-test-uploads');
process.removeAllListeners('warning');

const config = require('../server/config');
const { openDb, migrate } = require('../server/db');
const { createApp } = require('../server/app');
const { createProvider } = require('../server/payments/provider');
const { ensurePlans, createAdmin } = require('../server/services/seedData');
const { startFakeTap } = require('./fakeTap');

let schemaSeq = 0;
// startApp({ tap: true }) wires the REAL Tap adapter to a local test double of Tap's API.
async function startApp({ tap = false } = {}) {
  // TEST_DATABASE_URL (set by `npm run test:pg`) runs the SAME suite against a real PostgreSQL, one throw-away schema per app.
  const pgUrl = process.env.TEST_DATABASE_URL;
  const schema = pgUrl ? `t_${process.pid}_${++schemaSeq}` : null;
  const db = pgUrl ? openDb(pgUrl, { schema }) : openDb(':memory:');
  migrate(db);
  ensurePlans(db);

  let fake = null;
  let provider;
  const saved = { paymentProvider: config.paymentProvider, payment: config.payment };
  if (tap) {
    fake = await startFakeTap();
    config.paymentProvider = 'tap';
    config.payment = { secretKey: fake.secret, publicKey: 'pk_test', merchantId: '', apiBase: fake.base, webhookSecret: fake.secret };
    provider = createProvider(config);
  } else {
    // explicitly NO provider (another test app may have left the shared config pointing at the Tap test double)
    config.paymentProvider = 'none';
    config.payment = { secretKey: '', publicKey: '', merchantId: '', apiBase: '', webhookSecret: '' };
    provider = createProvider(config);
  }
  const server = createApp(db, { provider }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { token, body, raw, headers } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  let n = 0;
  const unique = (p) => `${p}${++n}-${Math.random().toString(36).slice(2, 7)}`;
  const PASSWORD = 'Passw0rd!';

  async function registerCustomer(name = 'Casey Customer') {
    const r = await call('POST', '/api/auth/register', { body: { name, email: `${unique('cust')}@t.test`, password: PASSWORD } });
    if (r.status !== 201) throw new Error(`customer register failed: ${r.text}`);
    return { token: r.body.data.token, user: r.body.data.user, password: PASSWORD };
  }

  async function createAdminUser() {
    const email = `${unique('admin')}@t.test`;
    createAdmin(db, { email, name: 'Test Admin', password: PASSWORD });
    const r = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
    return { token: r.body.data.token, user: r.body.data.user, email };
  }

  // Owner + restaurant. Restaurants are approved by default (new restaurants start 'pending' in real life).
  async function createRestaurantOwner(name = 'Test Kitchen', planCode, { approve = true, payoutAccount = false } = {}) {
    const email = `${unique('owner')}@t.test`;
    const r = await call('POST', '/api/auth/register-owner', { body: { name: 'Olive Owner', email, password: PASSWORD } });
    if (r.status !== 201) throw new Error(`owner register failed: ${r.text}`);
    const token = r.body.data.token;
    const rest = await call('POST', '/api/onboarding/restaurant', { token, body: { name: `${name} ${unique('')}`, city: 'Testville' } });
    if (rest.status !== 201) throw new Error(`onboarding failed: ${rest.text}`);
    const id = rest.body.data.restaurant.id;
    if (approve) db.prepare("UPDATE restaurants SET approval_status = 'approved' WHERE id = ?").run(id);
    if (planCode) db.prepare('UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = ?) WHERE restaurant_id = ?').run(planCode, id);
    if (payoutAccount) {
      db.prepare("UPDATE restaurant_payment_accounts SET connected_account_id = ?, payout_enabled = 1, onboarding_status = 'completed', verification_status = 'verified', payout_account_status = 'active' WHERE restaurant_id = ?")
        .run(`dest_${id}`, id);
    }
    return { token, email, restaurant: rest.body.data.restaurant, password: PASSWORD };
  }

  const setPlan = (owner, code) => db.prepare('UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = ?) WHERE restaurant_id = ?').run(code, owner.restaurant.id);

  async function addProduct(owner, over = {}) {
    const r = await call('POST', '/api/manage/products', { token: owner.token, body: { name: unique('Dish'), priceCents: 1000, ...over } });
    if (r.status !== 201) throw new Error(`addProduct failed: ${r.text}`);
    return r.body.data.product;
  }

  const orderBody = (items, extra = {}) => ({
    items, orderType: 'pickup', paymentMethod: 'cod', customerName: 'Casey', customerPhone: '+15551234567', ...extra,
  });

  const placeOrder = (owner, customer, items, extra, headers) => call('POST', `/api/public/restaurants/${owner.restaurant.slug}/orders`, {
    token: customer.token, body: orderBody(items, extra), headers,
  });

  return {
    db, base, call, unique, fake, config, PASSWORD, schema, pgUrl,
    registerCustomer, createRestaurantOwner, createAdminUser, setPlan, addProduct, orderBody, placeOrder,
    close: async () => {
      await new Promise((r) => server.close(r));
      if (pgUrl) { try { db.exec(`DROP SCHEMA "${schema}" CASCADE`); } finally { db.close(); } }
      if (fake) await fake.close();
      config.paymentProvider = saved.paymentProvider;
      config.payment = saved.payment;
    },
  };
}

module.exports = { startApp };
