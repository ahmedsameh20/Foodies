const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const subscriptions = require('../server/services/subscriptions');
const { createProvider } = require('../server/payments/provider');

// SaaS billing = what a RESTAURANT pays the PLATFORM. Uses the real Tap adapter against the local test double.
let t, admin;
before(async () => { t = await startApp({ tap: true }); admin = await t.createAdminUser(); });
after(async () => { await t.close(); });

const sub = (o) => t.db.prepare('SELECT * FROM subscriptions WHERE restaurant_id = ?').get(o.restaurant.id);
const change = (o, planCode, extra = {}) => t.call('POST', '/api/manage/subscription/change', { token: o.token, body: { planCode, ...extra } });
const DAY = 86400000;
const countTables = () => ({
  payments: t.db.prepare('SELECT COUNT(*) c FROM payments').get().c,
  ledger: t.db.prepare('SELECT COUNT(*) c FROM ledger_entries').get().c,
  refunds: t.db.prepare('SELECT COUNT(*) c FROM refunds').get().c,
});
const invoiceWebhook = (chargeId, status) => { const w = t.fake.webhookFor(chargeId, status); return t.call('POST', '/webhooks/tap', { body: w.body, headers: w.headers }); };
async function newOwner(name = 'Bill Bistro', { plan } = {}) {
  const o = await t.createRestaurantOwner(name); // default plan: free
  if (plan) t.db.prepare('UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = ?) WHERE restaurant_id = ?').run(plan, o.restaurant.id);
  return o;
}

test('onboarding picks the starting subscription from the plan: free=active, paid+trial=trialing, paid without trial=expired until paid', async () => {
  const free = await t.createRestaurantOwner('Free Start');
  assert.equal(sub(free).status, 'active');
  assert.equal(sub(free).price_cents, 0);
  assert.equal(sub(free).end_date, null);

  // owner chooses a paid plan with a trial at registration
  const email = `${t.unique('o')}@t.test`;
  const reg = await t.call('POST', '/api/auth/register-owner', { body: { name: 'Trial Owner', email, password: 'Passw0rd!' } });
  const r = await t.call('POST', '/api/onboarding/restaurant', { token: reg.body.data.token, body: { name: `Trial ${t.unique('')}`, planCode: 'pro' } });
  assert.equal(r.status, 201);
  const row = t.db.prepare('SELECT * FROM subscriptions WHERE restaurant_id = ?').get(r.body.data.restaurant.id);
  assert.equal(row.status, 'trialing');
  assert.equal(row.price_cents, 7900);
  assert.ok(new Date(row.trial_end).getTime() > Date.now() + 13 * DAY);

  // a paid plan with no trial needs payment first
  t.db.prepare("UPDATE plans SET trial_days = 0 WHERE code = 'business'").run();
  const reg2 = await t.call('POST', '/api/auth/register-owner', { body: { name: 'No Trial', email: `${t.unique('o')}@t.test`, password: 'Passw0rd!' } });
  const r2 = await t.call('POST', '/api/onboarding/restaurant', { token: reg2.body.data.token, body: { name: `NoTrial ${t.unique('')}`, planCode: 'business' } });
  const row2 = t.db.prepare('SELECT * FROM subscriptions WHERE restaurant_id = ?').get(r2.body.data.restaurant.id);
  assert.equal(row2.status, 'expired');
  assert.equal(t.db.prepare("SELECT COUNT(*) c FROM saas_invoices WHERE restaurant_id = ? AND status = 'open'").get(r2.body.data.restaurant.id).c, 1);
  t.db.prepare("UPDATE plans SET trial_days = 14 WHERE code = 'business'").run();

  assert.equal((await t.call('POST', '/api/onboarding/restaurant', { token: (await t.call('POST', '/api/auth/register-owner', { body: { name: 'Bad', email: `${t.unique('o')}@t.test`, password: 'Passw0rd!' } })).body.data.token, body: { name: 'X', planCode: 'does-not-exist' } })).status, 400);
});

test('paid upgrade end-to-end: invoice -> provider checkout -> verified webhook -> active; price locked; duplicates harmless; ledgers separate', async () => {
  const o = await newOwner();
  const before = countTables();
  // first paid plan: free trial, no payment yet
  const trial = await change(o, 'basic');
  assert.equal(trial.body.data.applied, true);
  assert.equal(trial.body.data.trial, true);
  assert.equal(sub(o).status, 'trialing');
  // a second paid choice (trial already used) needs an invoice and payment
  const up = await change(o, 'pro');
  assert.equal(up.status, 200);
  assert.equal(up.body.data.applied, false);
  assert.match(up.body.data.paymentUrl, /^https:\/\/checkout\.fake-tap\.test\/chg_/);
  const inv = up.body.data.invoice;
  assert.equal(inv.amountCents, 7900);
  assert.equal(inv.status, 'open');
  assert.equal(sub(o).plan_id, t.db.prepare("SELECT id FROM plans WHERE code = 'basic'").get().id); // still on the old plan until paid

  // what was sent to the provider: a plain charge for the invoice, no marketplace split, no card data
  const call = t.fake.calls.filter((c) => c.method === 'POST' && c.url === '/charges').pop();
  assert.equal(call.body.amount, 79);
  assert.equal(call.body.reference.order, `inv_${inv.id}`);
  assert.equal(call.body.destinations, undefined);
  assert.ok(call.body.redirect.url.endsWith('/dashboard.html#subscription'));

  // the browser claiming it paid changes nothing
  const refresh0 = await t.call('POST', `/api/manage/invoices/${inv.id}/refresh`, { token: o.token, body: { paid: true } });
  assert.equal(refresh0.body.data.subscription.status, 'trialing');

  const charge = t.fake.lastCharge();
  t.fake.capture(charge.id);
  assert.equal((await invoiceWebhook(charge.id)).status, 200);
  const s = sub(o);
  assert.equal(s.status, 'active');
  assert.equal(s.price_cents, 7900);
  assert.equal(s.plan_id, t.db.prepare("SELECT id FROM plans WHERE code = 'pro'").get().id);
  assert.ok(new Date(s.end_date).getTime() > Date.now() + 27 * DAY);
  const paid = t.db.prepare('SELECT * FROM saas_invoices WHERE id = ?').get(inv.id);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.provider_ref, charge.id);
  assert.ok(paid.paid_at);

  // duplicate delivery of the same event, then a replay through the return-page refresh: still one payment
  assert.equal((await invoiceWebhook(charge.id)).body.duplicate, true);
  await t.call('POST', `/api/manage/invoices/${inv.id}/refresh`, { token: o.token });
  assert.equal(t.db.prepare("SELECT COUNT(*) c FROM saas_invoices WHERE restaurant_id = ? AND status = 'paid'").get(o.restaurant.id).c, 1);

  // the order-payment ledgers were never touched
  assert.deepEqual(countTables(), before);
  // price is locked in at purchase: a later list-price change does not touch this restaurant
  t.db.prepare("UPDATE plans SET price_cents = 99900 WHERE code = 'pro'").run();
  const view = (await t.call('GET', '/api/manage/subscription', { token: o.token })).body.data;
  assert.equal(view.subscription.priceCents, 7900);
  assert.equal(view.subscription.status, 'active');
  assert.ok(view.subscription.nextBillingDate);
  assert.equal(view.invoices.length, 1);
  t.db.prepare("UPDATE plans SET price_cents = 7900 WHERE code = 'pro'").run();
});

test('forged, mismatched or unrelated provider events never activate a subscription', async () => {
  const o = await newOwner('Forgery Foods');
  t.db.prepare("UPDATE subscriptions SET trial_end = '2020-01-01T00:00:00.000Z' WHERE restaurant_id = ?").run(o.restaurant.id); // trial already used
  const up = await change(o, 'basic');
  const inv = up.body.data.invoice;
  const chargeId = t.fake.lastCharge().id;
  // unsigned / bad signature
  const w = t.fake.webhookFor(chargeId);
  assert.equal((await t.call('POST', '/webhooks/tap', { body: w.body })).status, 401);
  assert.equal((await t.call('POST', '/webhooks/tap', { body: w.body, headers: { hashstring: 'f'.repeat(64) } })).status, 401);
  // genuine signature but the provider says it is not paid
  assert.equal((await invoiceWebhook(chargeId)).status, 200);
  assert.equal(t.db.prepare('SELECT status FROM saas_invoices WHERE id = ?').get(inv.id).status, 'open');
  // paid, but for a different amount than the invoice
  t.fake.capture(chargeId);
  t.fake.charges.get(chargeId).amount = 1.0;
  await invoiceWebhook(chargeId);
  assert.equal(t.db.prepare('SELECT status FROM saas_invoices WHERE id = ?').get(inv.id).status, 'open');
  assert.equal(sub(o).plan_id, t.db.prepare("SELECT id FROM plans WHERE code = 'free'").get().id); // still on the Free plan: nothing was applied
  // a charge for another restaurant's invoice cannot be replayed on this one
  t.fake.charges.get(chargeId).amount = 29;
  t.fake.charges.get(chargeId).reference.order = 'inv_999999';
  await invoiceWebhook(chargeId);
  assert.equal(t.db.prepare('SELECT status FROM saas_invoices WHERE id = ?').get(inv.id).status, 'open');
});

test('subscription lifecycle: trial ends -> invoice + grace -> expiry blocks ordering -> payment restores; cancel ends at period end', async () => {
  const o = await newOwner('Lifecycle Lounge');
  const p = await t.addProduct(o, { priceCents: 1000 });
  const c = await t.registerCustomer();
  assert.equal((await change(o, 'basic')).body.data.trial, true);
  const now = Date.now();
  assert.equal((await t.placeOrder(o, c, [{ productId: p.id, quantity: 1 }])).status, 201); // trialing can take orders

  // day 15: the trial is over -> an invoice is issued and a grace period starts
  const r1 = subscriptions.runLifecycle(t.db, new Date(now + 15 * DAY));
  assert.equal(r1.trialsEnded >= 1, true);
  assert.equal(sub(o).status, 'past_due');
  const open = t.db.prepare("SELECT * FROM saas_invoices WHERE restaurant_id = ? AND status = 'open'").get(o.restaurant.id);
  assert.equal(open.amount_cents, 2900);
  assert.equal((await t.placeOrder(o, c, [{ productId: p.id, quantity: 1 }])).status, 201); // grace: still working
  const dash = (await t.call('GET', '/api/manage/subscription', { token: o.token })).body.data.subscription;
  assert.equal(dash.status, 'past_due');
  assert.equal(dash.openInvoice.id, open.id);

  // after the grace period: expired, the public page stops taking orders, the owner can still sign in and pay
  subscriptions.runLifecycle(t.db, new Date(now + 15 * DAY + 8 * DAY));
  assert.equal(sub(o).status, 'expired');
  const blocked = await t.placeOrder(o, c, [{ productId: p.id, quantity: 1 }]);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'restaurant_unavailable');
  assert.equal((await t.call('POST', '/api/manage/products', { token: o.token, body: { name: 'x', priceCents: 1 } })).status, 402);
  assert.equal((await t.call('POST', '/api/manage/products', { token: o.token, body: { name: 'x', priceCents: 1 } })).body.error.code, 'subscription_inactive');
  assert.equal((await t.call('GET', '/api/manage/subscription', { token: o.token })).status, 200);
  const pay = await t.call('POST', `/api/manage/invoices/${open.id}/pay`, { token: o.token });
  assert.match(pay.body.data.paymentUrl, /^https:\/\//);
  t.fake.capture(t.fake.lastCharge().id);
  await t.call('POST', `/api/manage/invoices/${open.id}/refresh`, { token: o.token });
  assert.equal(sub(o).status, 'active');
  assert.equal((await t.placeOrder(o, c, [{ productId: p.id, quantity: 1 }])).status, 201);

  // renewal: at the end of the paid month a new invoice is issued
  const end = new Date(sub(o).end_date).getTime();
  const r2 = subscriptions.runLifecycle(t.db, new Date(end + 1000));
  assert.equal(r2.renewalsIssued >= 1, true);
  assert.equal(sub(o).status, 'past_due');
  // cancel -> the access lasts until the period end, no renewal is invoiced (the pending renewal is voided)
  assert.equal((await t.call('POST', '/api/manage/subscription/cancel', { token: o.token })).status, 200);
  assert.equal(t.db.prepare("SELECT COUNT(*) c FROM saas_invoices WHERE restaurant_id = ? AND status = 'open'").get(o.restaurant.id).c, 0);
  assert.equal((await t.call('POST', '/api/manage/subscription/cancel', { token: o.token })).status, 409);
  t.db.prepare("UPDATE subscriptions SET status = 'active', end_date = ? WHERE restaurant_id = ?").run(new Date(Date.now() + DAY).toISOString(), o.restaurant.id);
  subscriptions.runLifecycle(t.db, new Date(Date.now() + 2 * DAY));
  assert.equal(sub(o).status, 'cancelled');
  assert.equal(t.db.prepare("SELECT COUNT(*) c FROM saas_invoices WHERE restaurant_id = ? AND status = 'open'").get(o.restaurant.id).c, 0);
});

test('plan changes: free downgrade applies at once, over-limit downgrade is refused with the numbers, inactive plans and Free-cancel are rejected', async () => {
  const o = await newOwner('Downgrade Deli', { plan: 'pro' });
  for (let i = 0; i < 12; i++) await t.addProduct(o);
  const refused = await change(o, 'free'); // Free allows 10 products
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'over_plan_limit');
  assert.equal(refused.body.error.details.used, 12);
  assert.equal(refused.body.error.details.limit, 10);
  assert.equal(sub(o).plan_id, t.db.prepare("SELECT id FROM plans WHERE code = 'pro'").get().id);
  const ids = (await t.call('GET', '/api/manage/products', { token: o.token })).body.data.products.slice(0, 2);
  for (const pr of ids) await t.call('DELETE', `/api/manage/products/${pr.id}`, { token: o.token });
  const ok = await change(o, 'free');
  assert.equal(ok.body.data.applied, true);
  assert.equal(sub(o).price_cents, 0);
  assert.equal(sub(o).end_date, null);
  assert.equal((await change(o, 'free')).status, 409); // already on it
  assert.equal((await t.call('POST', '/api/manage/subscription/cancel', { token: o.token })).status, 409);
  assert.equal((await change(o, 'nonexistent')).status, 404);
  // staff cannot manage the subscription
  const st = await t.call('POST', '/api/manage/staff', { token: o.token, body: { name: 'S', email: `${t.unique('s')}@t.test`, password: 'Passw0rd!' } });
  const sLogin = await t.call('POST', '/api/auth/login', { body: { email: st.body.data.staff.email, password: 'Passw0rd!' } });
  for (const [m, p, b] of [['GET', '/api/manage/subscription'], ['POST', '/api/manage/subscription/change', { planCode: 'pro' }], ['POST', '/api/manage/subscription/cancel', {}], ['POST', '/api/manage/invoices/1/pay', {}]]) {
    assert.equal((await t.call(m, p, { token: sLogin.body.data.token, body: b })).status, 403, `${m} ${p}`);
  }
});

test('admin can assign plans/status without payment and settle invoices manually (audited); owners cannot', async () => {
  const o = await newOwner('Manual Mart');
  t.db.prepare("UPDATE subscriptions SET trial_end = '2020-01-01T00:00:00.000Z' WHERE restaurant_id = ?").run(o.restaurant.id);
  const up = await change(o, 'pro', { pay: false });
  assert.equal(up.body.data.paymentUrl, null);
  const inv = up.body.data.invoice;
  assert.equal((await t.call('POST', `/api/admin/invoices/${inv.id}/mark-paid`, { token: o.token, body: { reference: 'x' } })).status, 403);
  assert.equal((await t.call('POST', `/api/admin/invoices/${inv.id}/mark-paid`, { token: admin.token, body: {} })).status, 400); // reference required
  const paid = await t.call('POST', `/api/admin/invoices/${inv.id}/mark-paid`, { token: admin.token, body: { reference: 'BANK-TRANSFER-4411' } });
  assert.equal(paid.body.data.invoice.status, 'paid');
  assert.equal(paid.body.data.invoice.provider, 'manual');
  assert.equal(sub(o).status, 'active');
  assert.equal((await t.call('POST', `/api/admin/invoices/${inv.id}/mark-paid`, { token: admin.token, body: { reference: 'again' } })).body.data.changed, false);
  assert.equal((await t.call('POST', `/api/admin/invoices/${inv.id}/void`, { token: admin.token })).status, 409); // paid invoices cannot be voided

  const assign = await t.call('PUT', `/api/admin/restaurants/${o.restaurant.id}/subscription`, { token: admin.token, body: { planCode: 'business', status: 'active', endDate: '2031-01-01' } });
  assert.equal(assign.status, 200);
  assert.equal(sub(o).end_date.slice(0, 10), '2031-01-01');
  assert.equal((await t.call('PUT', `/api/admin/restaurants/${o.restaurant.id}/subscription`, { token: admin.token, body: { planCode: 'business', status: 'bogus' } })).status, 400);
  assert.equal((await t.call('PUT', `/api/admin/restaurants/${o.restaurant.id}/subscription`, { token: o.token, body: { planCode: 'business' } })).status, 403);
  const log = t.db.prepare("SELECT action FROM audit_logs WHERE action IN ('invoice.marked_paid','subscription.assigned')").all().map((r) => r.action);
  assert.ok(log.includes('invoice.marked_paid') && log.includes('subscription.assigned'));

  // suspension and reactivation restore the status the dates justify
  await t.call('POST', `/api/admin/restaurants/${o.restaurant.id}/suspend`, { token: admin.token, body: { reason: 'test' } });
  assert.equal(sub(o).status, 'suspended');
  await t.call('POST', `/api/admin/restaurants/${o.restaurant.id}/reactivate`, { token: admin.token, body: {} });
  assert.equal(sub(o).status, 'active');
});

test('another restaurant cannot see, pay, refresh or void my invoices', async () => {
  const a = await newOwner('Invoice A');
  const b = await newOwner('Invoice B');
  t.db.prepare("UPDATE subscriptions SET trial_end = '2020-01-01T00:00:00.000Z' WHERE restaurant_id = ?").run(a.restaurant.id);
  const inv = (await change(a, 'basic', { pay: false })).body.data.invoice;
  assert.equal((await t.call('GET', '/api/manage/subscription', { token: b.token })).body.data.invoices.length, 0);
  assert.equal((await t.call('POST', `/api/manage/invoices/${inv.id}/pay`, { token: b.token })).status, 404);
  assert.equal((await t.call('POST', `/api/manage/invoices/${inv.id}/refresh`, { token: b.token })).status, 404);
  assert.equal((await t.call('POST', `/api/admin/invoices/${inv.id}/void`, { token: b.token })).status, 403);
  assert.equal(t.db.prepare('SELECT status FROM saas_invoices WHERE id = ?').get(inv.id).status, 'open');
});

test('PLAN ENFORCEMENT is on the server, explains the limit and points to an upgrade: products, staff, branches, orders/month', async () => {
  const o = await newOwner('Limit Larder');
  t.db.prepare("UPDATE plans SET max_menu_items = 3, max_staff = 1, max_orders_per_month = 2 WHERE code = 'free'").run();
  try {
    for (let i = 0; i < 3; i++) await t.addProduct(o);
    const prod = await t.call('POST', '/api/manage/products', { token: o.token, body: { name: 'Fourth', priceCents: 100 } });
    assert.equal(prod.status, 402);
    assert.equal(prod.body.error.code, 'plan_limit_reached');
    assert.match(prod.body.error.message, /Free plan allows up to 3 menu items\. Upgrade your plan/);
    assert.deepEqual(prod.body.error.details, { limit: 3, used: 3, plan: 'free', resource: 'menuItems', upgrade: true });

    assert.equal((await t.call('POST', '/api/manage/staff', { token: o.token, body: { name: 'S1', email: `${t.unique('s')}@t.test`, password: 'Passw0rd!' } })).status, 201);
    const staff2 = await t.call('POST', '/api/manage/staff', { token: o.token, body: { name: 'S2', email: `${t.unique('s')}@t.test`, password: 'Passw0rd!' } });
    assert.equal(staff2.status, 402);
    assert.equal(staff2.body.error.details.resource, 'staff');

    const items = (await t.call('GET', '/api/manage/products', { token: o.token })).body.data.products;
    const c = await t.registerCustomer();
    assert.equal((await t.placeOrder(o, c, [{ productId: items[0].id, quantity: 1 }])).status, 201);
    assert.equal((await t.placeOrder(o, c, [{ productId: items[0].id, quantity: 1 }])).status, 201);
    const third = await t.placeOrder(o, c, [{ productId: items[0].id, quantity: 1 }]);
    assert.equal(third.status, 403); // customers just see an unavailable restaurant...
    assert.equal(third.body.error.code, 'not_accepting_orders');
    assert.ok(!/plan|upgrade|limit/i.test(third.body.error.message), 'customers never see SaaS plan wording');
    const usage = (await t.call('GET', '/api/manage/subscription', { token: o.token })).body.data.subscription.usage; // ...the owner sees the numbers
    assert.equal(usage.ordersPerMonth, 2);
    assert.equal((await t.call('GET', '/api/manage/subscription', { token: o.token })).body.data.subscription.plan.limits.ordersPerMonth, 2);
    // upgrading lifts every limit at once
    t.db.prepare("UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'business') WHERE restaurant_id = ?").run(o.restaurant.id);
    assert.equal((await t.call('POST', '/api/manage/products', { token: o.token, body: { name: 'Fourth', priceCents: 100 } })).status, 201);
    assert.equal((await t.placeOrder(o, c, [{ productId: items[0].id, quantity: 1 }])).status, 201);
    // features are gated too, with the same upgrade hint
    const g = await newOwner('Feature Gate');
    const gated = await t.call('GET', '/api/manage/reports/advanced', { token: g.token });
    assert.equal(gated.status, 402);
    assert.equal(gated.body.error.details.upgrade, true);
  } finally { t.db.prepare("UPDATE plans SET max_menu_items = 10, max_staff = 1, max_orders_per_month = 100 WHERE code = 'free'").run(); }
});

test('TENANT ISOLATION: every restaurant-scoped endpoint returns only the caller\'s data; ids and tenant fields in the request change nothing', async () => {
  const A = await newOwner('Tenant A', { plan: 'pro' });
  const B = await newOwner('Tenant B', { plan: 'pro' });
  const pa = await t.addProduct(A, { name: 'A-only dish' });
  const pb = await t.addProduct(B, { name: 'B-only dish' });
  const cust = await t.registerCustomer('Shared Customer');
  const oa = (await t.placeOrder(A, cust, [{ productId: pa.id, quantity: 1 }])).body.data.order;
  await t.placeOrder(B, cust, [{ productId: pb.id, quantity: 2 }]);
  const stA = await t.call('POST', '/api/manage/staff', { token: A.token, body: { name: 'A staff', email: `${t.unique('sa')}@t.test`, password: 'Passw0rd!' } });
  const staffA = (await t.call('POST', '/api/auth/login', { body: { email: stA.body.data.staff.email, password: 'Passw0rd!' } })).body.data.token;
  await t.call('POST', '/api/support/reports', { token: cust.token, body: { category: 'restaurant', subject: 'About A', description: 'A problem about tenant A', orderId: oa.id } });

  // the same short URL, two tenants, two answers: GET /api/orders is automatically scoped
  for (const [who, own] of [[A, oa.restaurantId], [B, B.restaurant.id]]) {
    const orders = (await t.call('GET', '/api/orders', { token: who.token })).body.data.orders;
    assert.ok(orders.length >= 1 && orders.every((o) => o.restaurantId === own), 'orders');
    const products = (await t.call('GET', '/api/products', { token: who.token })).body.data.products;
    assert.ok(products.every((p) => p.name === (own === A.restaurant.id ? 'A-only dish' : 'B-only dish')), 'products');
    const cs = (await t.call('GET', '/api/customers', { token: who.token })).body.data.customers;
    assert.equal(cs.length, 1, 'customers');
    assert.equal(cs[0].orderCount, 1); // the shared customer ordered once from EACH restaurant: each sees only its own order
    assert.equal(cs[0].totalSpentCents, t.db.prepare('SELECT total_cents FROM orders WHERE restaurant_id = ?').get(own).total_cents);
  }
  // every tenant-scoped LIST endpoint, requested as B, contains nothing of A (by value, by id, by tenant id)
  const aMarkers = ['A-only dish', `"restaurantId":${A.restaurant.id}`, `"orderId":${oa.id},`, 'Tenant A', stA.body.data.staff.email];
  for (const path of ['/api/manage/restaurant', '/api/manage/orders', '/api/manage/products', '/api/manage/categories', '/api/manage/customers', '/api/manage/staff', '/api/manage/branches',
    '/api/manage/payments', '/api/manage/payouts', '/api/manage/earnings', '/api/manage/earnings/ledger', '/api/manage/subscription', '/api/manage/support-reports', '/api/manage/overview',
    '/api/manage/reports/summary', '/api/manage/reports/advanced', '/api/manage/reports/orders.csv', '/api/manage/payment-account']) {
    const r = await t.call('GET', `${path}${path.includes('?') ? '&' : '?'}restaurantId=${A.restaurant.id}&tenantId=${A.restaurant.id}&userId=${A.restaurant.id}`, { token: B.token, headers: { 'X-Restaurant-Id': String(A.restaurant.id), 'X-Tenant-Id': String(A.restaurant.id) } });
    assert.equal(r.status, 200, `${path} -> ${r.status}`);
    for (const m of aMarkers) assert.ok(!r.text.includes(m), `${path} leaked ${m}`);
  }
  // direct object references into A's rows are plain 404s for B (IDOR)
  const aStaffId = stA.body.data.staff.id;
  for (const [m, p, body] of [
    ['GET', `/api/manage/orders/${oa.id}`], ['PATCH', `/api/manage/orders/${oa.id}/status`, { status: 'confirmed' }], ['PUT', `/api/manage/products/${pa.id}`, { name: 'hax' }],
    ['DELETE', `/api/manage/products/${pa.id}`], ['PATCH', `/api/manage/products/${pa.id}/availability`, { isAvailable: false }], ['DELETE', `/api/manage/staff/${aStaffId}`],
    ['PATCH', `/api/manage/staff/${aStaffId}`, { isActive: false }], ['GET', `/api/orders/${oa.id}`], ['GET', `/api/products/${pa.id}/option-groups`],
  ]) {
    const r = await t.call(m, p, { token: B.token, body });
    assert.equal(r.status, 404, `${m} ${p} -> ${r.status}`);
  }
  assert.equal(t.db.prepare('SELECT name, is_available FROM products WHERE id = ?').get(pa.id).name, 'A-only dish');
  assert.equal(t.db.prepare('SELECT status FROM orders WHERE id = ?').get(oa.id).status, 'pending');
  // tenant / owner fields smuggled into WRITES are ignored: the row lands in the caller's own tenant
  const sneaky = await t.call('POST', '/api/manage/products', { token: B.token, body: { name: 'Sneaky', priceCents: 1, restaurantId: A.restaurant.id, restaurant_id: A.restaurant.id, tenantId: A.restaurant.id, tenant_id: A.restaurant.id, userId: 1, user_id: 1 } });
  assert.equal(sneaky.status, 201);
  assert.equal(t.db.prepare('SELECT restaurant_id FROM products WHERE id = ?').get(sneaky.body.data.product.id).restaurant_id, B.restaurant.id);
  const upd = await t.call('PUT', '/api/manage/restaurant', { token: B.token, body: { id: A.restaurant.id, restaurantId: A.restaurant.id, ownerId: 1, owner_id: 1, approvalStatus: 'rejected', commissionBpOverride: 0, isActive: false, name: 'B renamed' } });
  assert.equal(upd.status, 200);
  const rowA = t.db.prepare('SELECT name, approval_status, is_active FROM restaurants WHERE id = ?').get(A.restaurant.id);
  assert.match(rowA.name, /^Tenant A/);
  const rowB = t.db.prepare('SELECT name, approval_status, is_active, commission_bp_override, owner_id FROM restaurants WHERE id = ?').get(B.restaurant.id);
  assert.equal(rowB.name, 'B renamed');
  assert.equal(rowB.approval_status, 'approved'); // a tenant cannot approve/reject/suspend itself or change its commission
  assert.equal(rowB.is_active, 1);
  assert.equal(rowB.commission_bp_override, null);
  assert.notEqual(rowB.owner_id, 1);
  // staff of A is bound to A as well
  assert.equal((await t.call('GET', `/api/manage/orders/${oa.id}`, { token: staffA })).status, 200);
  assert.equal((await t.call('GET', '/api/orders', { token: staffA })).body.data.orders.every((o) => o.restaurantId === A.restaurant.id), true);
  // customers cannot reach tenant APIs at all, and see only their own orders across tenants
  for (const path of ['/api/orders', '/api/products', '/api/manage/orders', '/api/customers', '/api/subscription']) assert.equal((await t.call('GET', path, { token: cust.token })).status, 403, path);
  assert.equal((await t.call('GET', '/api/me/orders', { token: cust.token })).body.data.orders.length, 2);
  // the platform admin, by contrast, sees every tenant
  const all = await t.call('GET', '/api/admin/orders?pageSize=100', { token: admin.token });
  const rids = new Set(all.body.data.orders.map((o) => o.restaurantId));
  assert.ok(rids.has(A.restaurant.id) && rids.has(B.restaurant.id));
  assert.equal((await t.call('GET', '/api/orders', { token: admin.token })).status, 403); // the tenant API is not the admin API
});
