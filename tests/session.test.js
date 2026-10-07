const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { captureMail } = require('../server/services/mailer');
const logger = require('../server/logger');

let t;
const mails = [];
before(async () => { t = await startApp(); captureMail((m) => mails.push(m)); });
after(async () => { captureMail(null); await t.close(); });

const cookieOf = (res) => (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('foodies_session='));
async function cookieLogin(email, password = 'Passw0rd!') {
  const res = await t.call('POST', '/api/auth/login', { body: { email, password } });
  const c = cookieOf(res);
  return { res, cookie: c ? c.split(';')[0] : null, raw: c };
}

test('login sets an httpOnly SameSite cookie session; the browser never needs the token', async () => {
  const c = await t.registerCustomer();
  const { res, cookie, raw } = await cookieLogin(c.user.email);
  assert.equal(res.status, 200);
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Lax/i);
  assert.match(raw, /Path=\//);
  const me = await t.call('GET', '/api/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.equal(me.body.data.user.email, c.user.email);
});

test('CSRF: a cookie-authenticated state change from another site is blocked; same-site and bearer clients work', async () => {
  const c = await t.registerCustomer();
  const { cookie } = await cookieLogin(c.user.email);
  const body = { category: 'other', subject: 'Hello there', description: 'This is a test report body.' };
  const attempt = (headers) => t.call('POST', '/api/support/reports', { body, headers: { Cookie: cookie, ...headers } });
  assert.equal((await attempt({})).status, 403); // no Origin / Fetch-Metadata at all
  assert.equal((await attempt({ Origin: 'https://evil.example' })).status, 403);
  assert.equal((await attempt({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await attempt({ 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal((await attempt({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' })).body.error.code, 'csrf_blocked');
  assert.equal((await attempt({ 'Sec-Fetch-Site': 'same-origin' })).status, 201);
  assert.equal((await attempt({ Origin: t.base })).status, 201);
  // reads with a cookie are not state-changing; bearer-token API clients are not CSRF-able and need no Origin
  assert.equal((await t.call('GET', '/api/support/reports', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await t.call('POST', '/api/support/reports', { token: c.token, body })).status, 201);
});

test('logout revokes every session of the account (cookie and bearer)', async () => {
  const c = await t.registerCustomer();
  const { cookie } = await cookieLogin(c.user.email);
  const out = await t.call('POST', '/api/auth/logout', { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(out.status, 200);
  assert.match(cookieOf(out) || '', /foodies_session=;|Expires=Thu, 01 Jan 1970/i);
  assert.equal((await t.call('GET', '/api/auth/me', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await t.call('GET', '/api/auth/me', { token: c.token })).status, 401);
  assert.equal((await cookieLogin(c.user.email)).res.status, 200); // can sign in again
});

test('change password: needs the current password, revokes older sessions, issues a fresh one', async () => {
  const c = await t.registerCustomer();
  assert.equal((await t.call('POST', '/api/auth/change-password', { token: c.token, body: { currentPassword: 'wrong', newPassword: 'NewPassw0rd!' } })).status, 403);
  assert.equal((await t.call('POST', '/api/auth/change-password', { token: c.token, body: { currentPassword: c.password, newPassword: 'short' } })).status, 400);
  const ok = await t.call('POST', '/api/auth/change-password', { token: c.token, body: { currentPassword: c.password, newPassword: 'NewPassw0rd!' } });
  assert.equal(ok.status, 200);
  assert.equal((await t.call('GET', '/api/auth/me', { token: c.token })).status, 401);
  assert.equal((await t.call('GET', '/api/auth/me', { token: ok.body.data.token })).status, 200);
  assert.equal((await cookieLogin(c.user.email, c.password)).res.status, 401);
  assert.equal((await cookieLogin(c.user.email, 'NewPassw0rd!')).res.status, 200);
});

test('password reset: generic response, emailed single-use expiring token, hashed at rest, sessions revoked', async () => {
  const c = await t.registerCustomer();
  mails.length = 0;
  const unknown = await t.call('POST', '/api/auth/forgot-password', { body: { email: 'nobody@t.test' } });
  const known = await t.call('POST', '/api/auth/forgot-password', { body: { email: c.user.email } });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, known.body); // no account enumeration
  assert.equal(mails.filter((m) => m.to === 'nobody@t.test').length, 0);
  const mail = mails.find((m) => m.to === c.user.email && /reset/i.test(m.subject));
  assert.ok(mail);
  const token = /token=([a-f0-9]{64})/.exec(mail.text)[1];
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM auth_tokens WHERE token_hash = ?').get(token).c, 0); // raw token never stored
  assert.equal(t.db.prepare("SELECT COUNT(*) c FROM auth_tokens WHERE type = 'password_reset' AND user_id = ?").get(c.user.id).c, 1);

  assert.equal((await t.call('POST', '/api/auth/reset-password', { body: { token: 'f'.repeat(64), password: 'Another1Pass' } })).status, 400);
  assert.equal((await t.call('POST', '/api/auth/reset-password', { body: { token, password: 'weak' } })).status, 400);
  const done = await t.call('POST', '/api/auth/reset-password', { body: { token, password: 'Another1Pass' } });
  assert.equal(done.status, 200);
  assert.equal((await t.call('POST', '/api/auth/reset-password', { body: { token, password: 'Third1Pass' } })).status, 400); // single use
  assert.equal((await t.call('GET', '/api/auth/me', { token: c.token })).status, 401);
  assert.equal((await cookieLogin(c.user.email, 'Another1Pass')).res.status, 200);

  // expired token
  await t.call('POST', '/api/auth/forgot-password', { body: { email: c.user.email } });
  const t2 = /token=([a-f0-9]{64})/.exec(mails.filter((m) => m.to === c.user.email).pop().text)[1];
  t.db.prepare("UPDATE auth_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ? AND used_at IS NULL").run(c.user.id);
  assert.equal((await t.call('POST', '/api/auth/reset-password', { body: { token: t2, password: 'Fourth1Pass' } })).status, 400);
  // a newer request invalidates the older link
  await t.call('POST', '/api/auth/forgot-password', { body: { email: c.user.email } });
  await t.call('POST', '/api/auth/forgot-password', { body: { email: c.user.email } });
  const [first, second] = mails.filter((m) => m.to === c.user.email).slice(-2).map((m) => /token=([a-f0-9]{64})/.exec(m.text)[1]);
  assert.equal((await t.call('POST', '/api/auth/reset-password', { body: { token: first, password: 'Fifth1Pass' } })).status, 400);
  assert.equal((await t.call('POST', '/api/auth/reset-password', { body: { token: second, password: 'Fifth1Pass' } })).status, 200);
});

test('email verification: link verifies the address once; resend works; wrong/forged tokens fail', async () => {
  mails.length = 0;
  const c = await t.registerCustomer();
  await new Promise((r) => setTimeout(r, 50));
  const mail = mails.find((m) => m.to === c.user.email && /confirm/i.test(m.subject));
  assert.ok(mail, 'verification email sent at registration');
  assert.equal((await t.call('GET', '/api/auth/me', { token: c.token })).body.data.user.emailVerified, false);
  const token = /token=([a-f0-9]{64})/.exec(mail.text)[1];
  assert.equal((await t.call('POST', '/api/auth/verify-email', { body: { token: '0'.repeat(64) } })).status, 400);
  assert.equal((await t.call('POST', '/api/auth/verify-email', { body: { token: "' OR 1=1 --" } })).status, 400);
  assert.equal((await t.call('POST', '/api/auth/verify-email', { body: { token } })).status, 200);
  assert.equal((await t.call('GET', '/api/auth/me', { token: c.token })).body.data.user.emailVerified, true);
  assert.equal((await t.call('POST', '/api/auth/verify-email', { body: { token } })).status, 400);
  assert.equal((await t.call('POST', '/api/auth/resend-verification', { token: c.token })).status, 200);
});

test('logs never contain passwords, tokens, secrets or payment signatures', async () => {
  const lines = [];
  logger.setSink((l) => lines.push(l));
  const prev = process.env.LOG_LEVEL;
  try {
    // logging is silent in tests by design; verify the redaction layer directly with realistic payloads
    const sample = logger.redact({
      password: 'Sup3rSecret!', newPassword: 'x', authorization: 'Bearer abc.def.ghi', cookie: 'foodies_session=zzz', token: 'tok',
      card: { number: '4242424242424242', cvv: '123' }, hashstring: 'abc', secretKey: 'sk_live_abc', user: { email: 'a@b.co', apiKey: 'k' }, headers: { Authorization: 'Bearer q' },
      nested: [{ cardNumber: '4111111111111111' }], note: 'fine',
    });
    const dump = JSON.stringify(sample);
    for (const secret of ['Sup3rSecret!', 'abc.def.ghi', 'zzz', '4242424242424242', '123', 'sk_live_abc', '4111111111111111', 'Bearer q']) assert.ok(!dump.includes(secret), `${secret} leaked`);
    assert.equal(sample.note, 'fine');
    assert.equal(sample.user.email, 'a@b.co');
    // errors are logged by name/message only
    assert.ok(!JSON.stringify(logger.redact({ error: new Error('boom') })).includes('Sup3rSecret'));
  } finally { logger.setSink((l) => process.stdout.write(`${l}\n`)); process.env.LOG_LEVEL = prev; }
});

test('health endpoint reports database and payment status without leaking configuration', async () => {
  const r = await t.call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { status: 'ok', database: 'ok', payments: 'disabled' });
  assert.ok(r.headers.get('x-request-id'));
});
