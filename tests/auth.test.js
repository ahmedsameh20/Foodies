const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

let t;
before(async () => { t = await startApp(); });
after(async () => { await t.close(); });

test('registers a customer and returns a token + sanitized user', async () => {
  const email = `${t.unique('a')}@t.test`;
  const r = await t.call('POST', '/api/auth/register', { body: { name: 'Ann', email, password: 'Passw0rd!' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.user.role, 'customer');
  assert.ok(r.body.data.token);
  assert.equal(r.body.data.user.password_hash, undefined);
  assert.equal(r.body.data.user.passwordHash, undefined);
});

test('registration ignores a client-supplied role (no privilege escalation)', async () => {
  const r = await t.call('POST', '/api/auth/register', {
    body: { name: 'Mallory', email: `${t.unique('m')}@t.test`, password: 'Passw0rd!', role: 'super_admin', restaurantId: 1 },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.user.role, 'customer');
  assert.equal(r.body.data.user.restaurantId, null);
});

test('rejects duplicate email, weak password and malformed email', async () => {
  const email = `${t.unique('d')}@t.test`;
  await t.call('POST', '/api/auth/register', { body: { name: 'Dee', email, password: 'Passw0rd!' } });
  const dup = await t.call('POST', '/api/auth/register', { body: { name: 'Dee', email: email.toUpperCase(), password: 'Passw0rd!' } });
  assert.equal(dup.status, 409);
  const weak = await t.call('POST', '/api/auth/register', { body: { name: 'W', email: `${t.unique('w')}@t.test`, password: 'short' } });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error.code, 'validation_error');
  const badMail = await t.call('POST', '/api/auth/register', { body: { name: 'W', email: 'nope', password: 'Passw0rd!' } });
  assert.equal(badMail.status, 400);
});

test('login succeeds with correct credentials and fails identically for bad email / bad password', async () => {
  const email = `${t.unique('l')}@t.test`;
  await t.call('POST', '/api/auth/register', { body: { name: 'Lee', email, password: 'Passw0rd!' } });
  const ok = await t.call('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!' } });
  assert.equal(ok.status, 200);
  const wrongPw = await t.call('POST', '/api/auth/login', { body: { email, password: 'Wrong1234' } });
  const noUser = await t.call('POST', '/api/auth/login', { body: { email: 'ghost@t.test', password: 'Wrong1234' } });
  assert.equal(wrongPw.status, 401);
  assert.equal(noUser.status, 401);
  assert.equal(wrongPw.body.error.message, noUser.body.error.message);
});

test('protected endpoints require a valid token', async () => {
  assert.equal((await t.call('GET', '/api/auth/me')).status, 401);
  assert.equal((await t.call('GET', '/api/auth/me', { token: 'garbage' })).status, 401);
  assert.equal((await t.call('GET', '/api/manage/orders')).status, 401);
  assert.equal((await t.call('GET', '/api/admin/stats')).status, 401);
  const c = await t.registerCustomer();
  const me = await t.call('GET', '/api/auth/me', { token: c.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.data.user.email, c.user.email);
});

test('a disabled account can no longer use an existing token', async () => {
  const c = await t.registerCustomer();
  t.db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(c.user.id);
  assert.equal((await t.call('GET', '/api/auth/me', { token: c.token })).status, 401);
});

test('malformed JSON and unknown endpoints return the JSON error envelope', async () => {
  const r = await t.call('POST', '/api/auth/login', { raw: true, body: '{bad', headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'bad_json');
  const nf = await t.call('GET', '/api/nope');
  assert.equal(nf.status, 404);
  assert.equal(nf.body.error.code, 'not_found');
});

test('owner onboarding creates a restaurant, links the owner, assigns the Free plan and a unique slug', async () => {
  const email = `${t.unique('o')}@t.test`;
  const reg = await t.call('POST', '/api/auth/register-owner', { body: { name: 'Owen', email, password: 'Passw0rd!' } });
  const token = reg.body.data.token;
  // Before onboarding, manage endpoints say onboarding is required.
  const early = await t.call('GET', '/api/manage/restaurant', { token });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'onboarding_required');

  const a = await t.call('POST', '/api/onboarding/restaurant', { token, body: { name: 'Pasta Place', city: 'Rome' } });
  assert.equal(a.status, 201);
  assert.equal(a.body.data.restaurant.slug, 'pasta-place');
  const again = await t.call('POST', '/api/onboarding/restaurant', { token, body: { name: 'Second' } });
  assert.equal(again.status, 409);

  const mine = await t.call('GET', '/api/manage/restaurant', { token });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.data.subscription.plan.code, 'free');

  // A second owner choosing the same name gets a different slug.
  const o2 = await t.call('POST', '/api/auth/register-owner', { body: { name: 'Pia', email: `${t.unique('o')}@t.test`, password: 'Passw0rd!' } });
  const b = await t.call('POST', '/api/onboarding/restaurant', { token: o2.body.data.token, body: { name: 'Pasta Place' } });
  assert.equal(b.body.data.restaurant.slug, 'pasta-place-2');
  // new restaurants wait for platform approval before they are public
  assert.equal(a.body.data.restaurant.approval_status, 'pending');
  assert.equal((await t.call('GET', '/api/public/restaurants/pasta-place')).status, 404);
  t.db.prepare("UPDATE restaurants SET approval_status = 'approved' WHERE id = ?").run(a.body.data.restaurant.id);
  const pub = await t.call('GET', '/api/public/restaurants/pasta-place');
  assert.equal(pub.status, 200);
});

test('customers cannot onboard a restaurant', async () => {
  const c = await t.registerCustomer();
  const r = await t.call('POST', '/api/onboarding/restaurant', { token: c.token, body: { name: 'Nope' } });
  assert.equal(r.status, 403);
});
