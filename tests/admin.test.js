const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { REPORT_TYPES } = require('../server/services/reports');

let t, admin, owner, customer, product;
before(async () => {
  t = await startApp({ tap: true });
  admin = await t.createAdminUser();
  owner = await t.createRestaurantOwner('Admin Test Grill', 'pro', { approve: false });
  customer = await t.registerCustomer('Dana Customer');
});
after(async () => { await t.close(); });

const A = (method, path, body, headers) => t.call(method, path, { token: admin.token, body, headers });

test('every admin endpoint is closed to anonymous users, customers, owners and staff', async () => {
  const staff = await t.call('POST', '/api/manage/staff', { token: owner.token, body: { name: 'S', email: `${t.unique('s')}@t.test`, password: 'Passw0rd!' } });
  const sLogin = await t.call('POST', '/api/auth/login', { body: { email: staff.body.data.staff.email, password: 'Passw0rd!' } });
  const endpoints = [
    ['GET', '/api/admin/stats'], ['GET', '/api/admin/users'], ['PATCH', '/api/admin/users/1', { isActive: false }], ['GET', '/api/admin/restaurants'],
    ['POST', `/api/admin/restaurants/${owner.restaurant.id}/approve`, {}], ['POST', `/api/admin/restaurants/${owner.restaurant.id}/suspend`, { reason: 'x' }],
    ['PUT', `/api/admin/restaurants/${owner.restaurant.id}/payment-account`, { connectedAccountId: 'dest_known', payoutEnabled: true }],
    ['GET', '/api/admin/orders'], ['POST', '/api/admin/orders/1/cancel', { reason: 'x' }], ['GET', '/api/admin/payments'],
    ['POST', '/api/admin/payments/1/refund', { reason: 'x' }, { 'Idempotency-Key': 'abcdefgh1234' }], ['GET', '/api/admin/refunds'],
    ['GET', '/api/admin/balances'], ['GET', '/api/admin/payouts'], ['POST', '/api/admin/payouts/generate', {}], ['PATCH', '/api/admin/payouts/1', { status: 'paid', reference: 'x' }],
    ['GET', '/api/admin/reports/revenue'], ['GET', '/api/admin/support-reports'], ['PATCH', '/api/admin/support-reports/1', { status: 'closed' }],
    ['GET', '/api/admin/settings'], ['PUT', '/api/admin/settings', { commissionBp: 0 }], ['GET', '/api/admin/audit'], ['GET', '/api/admin/plans'], ['PUT', '/api/admin/plans/free', { maxMenuItems: 99999 }],
    ['POST', `/api/admin/restaurants/${owner.restaurant.id}/cod-settlement`, {}],
  ];
  for (const [m, p, b, h] of endpoints) {
    assert.equal((await t.call(m, p, { body: b, headers: h })).status, 401, `anon ${m} ${p}`);
    for (const [who, tok] of [['customer', customer.token], ['owner', owner.token], ['staff', sLogin.body.data.token]]) {
      assert.equal((await t.call(m, p, { token: tok, body: b, headers: h })).status, 403, `${who} ${m} ${p}`);
    }
  }
  // privilege escalation attempts via public registration
  const sneaky = await t.call('POST', '/api/auth/register', { body: { name: 'Eve', email: `${t.unique('eve')}@t.test`, password: 'Passw0rd!', role: 'super_admin' } });
  assert.equal(sneaky.body.data.user.role, 'customer');
});

test('restaurant approval workflow: pending is invisible and cannot take orders; approve, reject, suspend, reactivate', async () => {
  product = await t.addProduct(owner, { priceCents: 2000 });
  assert.equal((await t.call('GET', `/api/public/restaurants/${owner.restaurant.slug}`)).status, 404);
  assert.ok(!(await t.call('GET', '/api/public/restaurants')).body.data.restaurants.some((r) => r.id === owner.restaurant.id));
  assert.equal((await t.placeOrder(owner, customer, [{ productId: product.id, quantity: 1 }])).status, 404);

  const pending = await A('GET', '/api/admin/restaurants?approval=pending');
  assert.ok(pending.body.data.restaurants.some((r) => r.id === owner.restaurant.id));
  assert.equal((await A('POST', `/api/admin/restaurants/${owner.restaurant.id}/reject`, {})).status, 400); // reason required
  const rej = await A('POST', `/api/admin/restaurants/${owner.restaurant.id}/reject`, { reason: 'Missing licence' });
  assert.equal(rej.body.data.restaurant.approvalStatus, 'rejected');
  assert.equal((await t.call('GET', '/api/manage/restaurant', { token: owner.token })).body.data.restaurant.rejectionReason, 'Missing licence');
  assert.equal((await t.call('GET', `/api/public/restaurants/${owner.restaurant.slug}`)).status, 404);

  assert.equal((await A('POST', `/api/admin/restaurants/${owner.restaurant.id}/approve`, {})).body.data.restaurant.approvalStatus, 'approved');
  assert.equal((await t.call('GET', `/api/public/restaurants/${owner.restaurant.slug}`)).status, 200);
  assert.equal((await t.placeOrder(owner, customer, [{ productId: product.id, quantity: 1 }])).status, 201);

  assert.equal((await A('POST', `/api/admin/restaurants/${owner.restaurant.id}/suspend`, {})).status, 400); // reason required
  assert.equal((await A('POST', `/api/admin/restaurants/${owner.restaurant.id}/suspend`, { reason: 'Hygiene complaints' })).status, 200);
  assert.equal((await t.call('GET', `/api/public/restaurants/${owner.restaurant.slug}`)).status, 404);
  assert.equal((await t.placeOrder(owner, customer, [{ productId: product.id, quantity: 1 }])).status, 404);
  assert.equal((await A('POST', `/api/admin/restaurants/${owner.restaurant.id}/reactivate`, {})).status, 200);
  assert.equal((await t.placeOrder(owner, customer, [{ productId: product.id, quantity: 1 }])).status, 201);

  assert.equal((await A('GET', '/api/admin/restaurants/999999')).status, 404);
  const det = await A('GET', `/api/admin/restaurants/${owner.restaurant.id}`);
  assert.equal(det.body.data.restaurant.ownerEmail, owner.email);
  assert.ok('availableCents' in det.body.data.earnings);
  const edit = await A('PATCH', `/api/admin/restaurants/${owner.restaurant.id}`, { whatsapp: '+966500000000', commissionBpOverride: 1500 });
  assert.equal(edit.body.data.restaurant.commissionBpOverride, 1500);
  assert.equal((await A('PATCH', `/api/admin/restaurants/${owner.restaurant.id}`, { commissionBpOverride: 20000 })).status, 400);
  assert.equal((await A('PUT', `/api/admin/restaurants/${owner.restaurant.id}/subscription`, { planCode: 'basic' })).status, 200);
  assert.equal((await A('PUT', `/api/admin/restaurants/${owner.restaurant.id}/subscription`, { planCode: 'nope' })).status, 404);
  await A('PUT', `/api/admin/restaurants/${owner.restaurant.id}/subscription`, { planCode: 'pro' });
  const search = await A('GET', `/api/admin/restaurants?q=${encodeURIComponent('Admin Test')}`);
  assert.ok(search.body.data.total >= 1);
});

test('restaurant payment account is linked by an admin only after the provider confirms the destination exists', async () => {
  const id = owner.restaurant.id;
  const unknown = await A('PUT', `/api/admin/restaurants/${id}/payment-account`, { connectedAccountId: 'dest_does_not_exist', payoutEnabled: true, onboardingStatus: 'completed', verificationStatus: 'verified', payoutAccountStatus: 'active' });
  assert.equal(unknown.status, 422);
  assert.equal((await A('PUT', `/api/admin/restaurants/${id}/payment-account`, { payoutEnabled: true })).status, 400); // no account id
  assert.equal((await A('PUT', `/api/admin/restaurants/${id}/payment-account`, { connectedAccountId: 'bad id!' })).status, 400);
  const ok = await A('PUT', `/api/admin/restaurants/${id}/payment-account`, { connectedAccountId: 'dest_known', payoutEnabled: true, onboardingStatus: 'completed', verificationStatus: 'verified', payoutAccountStatus: 'active' });
  assert.equal(ok.status, 200);
  const view = await t.call('GET', '/api/manage/payment-account', { token: owner.token });
  assert.deepEqual({ ...view.body.data.paymentAccount, lastVerifiedAt: null }, { ...view.body.data.paymentAccount, lastVerifiedAt: null, provider: 'tap', providerEnabled: true, onboardingStatus: 'completed', verificationStatus: 'verified', payoutAccountStatus: 'active', payoutEnabled: true, connected: true, status: 'VERIFIED', displayStatus: 'VERIFIED', onlinePaymentsEnabled: true });
  assert.ok(view.body.data.paymentAccount.lastVerifiedAt, 'set because the provider confirmed the destination in this call');
  // the owner cannot edit it, and the provider account id is never shown to restaurants or customers
  assert.equal((await t.call('PUT', `/api/admin/restaurants/${id}/payment-account`, { token: owner.token, body: { connectedAccountId: 'dest_known', payoutEnabled: true } })).status, 403);
  assert.ok(!JSON.stringify(view.body).includes('dest_known'));
  assert.ok(!JSON.stringify((await t.call('GET', `/api/public/restaurants/${owner.restaurant.slug}`)).body).includes('dest_known'));
  const pub = await t.call('GET', `/api/public/restaurants/${owner.restaurant.slug}`);
  assert.equal(pub.body.data.restaurant.paymentMethods.card, true);
});

test('user management: search, filter, disable revokes sessions and blocks login, enable restores', async () => {
  const victim = await t.registerCustomer('Vic Victim');
  const list = await A('GET', `/api/admin/users?q=${encodeURIComponent('Vic Victim')}`);
  assert.equal(list.body.data.users[0].id, victim.user.id);
  assert.equal(list.body.data.users[0].status, 'active');
  assert.ok((await A('GET', '/api/admin/users?role=owner')).body.data.users.every((u) => u.role === 'owner'));
  assert.ok(!JSON.stringify(list.body).match(/password/i));

  assert.equal((await t.call('GET', '/api/me/orders', { token: victim.token })).status, 200);
  assert.equal((await A('PATCH', `/api/admin/users/${victim.user.id}`, { isActive: false })).status, 200);
  assert.equal((await t.call('GET', '/api/me/orders', { token: victim.token })).status, 401); // existing session dead immediately
  const login = await t.call('POST', '/api/auth/login', { body: { email: victim.user.email, password: victim.password } });
  assert.equal(login.status, 403);
  assert.equal((await A('GET', '/api/admin/users?status=disabled')).body.data.users.some((u) => u.id === victim.user.id), true);
  assert.equal((await A('PATCH', `/api/admin/users/${victim.user.id}`, { isActive: true })).status, 200);
  assert.equal((await t.call('POST', '/api/auth/login', { body: { email: victim.user.email, password: victim.password } })).status, 200);
  assert.equal((await A('PATCH', `/api/admin/users/${admin.user.id}`, { isActive: false })).status, 409); // cannot lock yourself out
  assert.equal((await A('PATCH', '/api/admin/users/999999', { isActive: false })).status, 404);
  assert.equal((await A('PATCH', `/api/admin/users/${victim.user.id}`, { isActive: 'no' })).status, 400);
  const orders = await A('GET', `/api/admin/users/${customer.user.id}/orders`);
  assert.ok(orders.body.data.orders.length >= 2);
});

test('order management: search, filter by status / restaurant / date, details, admin cancel', async () => {
  const all = await A('GET', '/api/admin/orders');
  assert.ok(all.body.data.total >= 2);
  const byRest = await A('GET', `/api/admin/orders?restaurantId=${owner.restaurant.id}`);
  assert.ok(byRest.body.data.orders.every((o) => o.restaurantId === owner.restaurant.id));
  const pend = await A('GET', '/api/admin/orders?status=pending');
  assert.ok(pend.body.data.orders.every((o) => o.status === 'pending'));
  const byName = await A('GET', `/api/admin/orders?q=${encodeURIComponent('Casey')}`);
  assert.ok(byName.body.data.total >= 1);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok((await A('GET', `/api/admin/orders?from=${today}&to=${today}`)).body.data.total >= 2);
  assert.equal((await A('GET', '/api/admin/orders?from=2000-01-01&to=2000-01-02')).body.data.total, 0);
  assert.equal((await A('GET', '/api/admin/orders?q=%25')).body.data.total, 0); // LIKE wildcards are escaped

  const id = pend.body.data.orders[0].id;
  const det = await A('GET', `/api/admin/orders/${id}`);
  assert.ok(det.body.data.payment);
  assert.ok(Array.isArray(det.body.data.history));
  assert.equal((await A('POST', `/api/admin/orders/${id}/cancel`, {})).status, 400); // reason required
  assert.equal((await A('POST', `/api/admin/orders/${id}/cancel`, { reason: 'Duplicate order' })).status, 200);
  assert.equal((await A('POST', `/api/admin/orders/${id}/cancel`, { reason: 'again' })).status, 409);
  assert.equal((await A('GET', '/api/admin/orders/abc')).status, 404);
});

test('payments view: filter by method/status, COD clearly separated, failed payments listed, reconcile re-checks the provider', async () => {
  const cod = await A('GET', '/api/admin/payments?method=cod');
  assert.ok(cod.body.data.payments.length >= 1 && cod.body.data.payments.every((p) => p.method === 'cod'));
  // create a failed card payment and a paid one
  const card1 = await t.placeOrder(owner, customer, [{ productId: product.id, quantity: 1 }], { paymentMethod: 'card' });
  const pid = t.db.prepare('SELECT id, provider_transaction_id FROM payments WHERE order_id = ?').get(card1.body.data.order.id);
  const w = t.fake.webhookFor(pid.provider_transaction_id, 'FAILED');
  await t.call('POST', '/webhooks/tap', { body: w.body, headers: w.headers });
  const failed = await A('GET', '/api/admin/payments?status=failed');
  assert.ok(failed.body.data.payments.some((p) => p.id === pid.id));
  assert.equal((await A('GET', `/api/admin/payments?q=${pid.provider_transaction_id}`)).body.data.total, 1);

  const card2 = await t.placeOrder(owner, customer, [{ productId: product.id, quantity: 1 }], { paymentMethod: 'card' });
  const p2 = t.db.prepare('SELECT id, provider_transaction_id FROM payments WHERE order_id = ?').get(card2.body.data.order.id);
  t.fake.capture(p2.provider_transaction_id);
  const rec = await A('POST', `/api/admin/payments/${p2.id}/reconcile`, {});
  assert.equal(rec.body.data.status, 'succeeded');
  assert.equal((await A('GET', '/api/admin/payments?status=succeeded')).body.data.payments.some((p) => p.id === p2.id), true);
  assert.equal((await A('GET', '/api/admin/refunds')).status, 200);
  assert.ok(!JSON.stringify((await A('GET', '/api/admin/payments')).body).match(/sk_test|secret/i));
});

test('payout management: balances, generation, listing, status filter and CSV export', async () => {
  const bal = await A('GET', '/api/admin/balances');
  assert.ok(bal.body.data.balances.some((b) => b.restaurantId === owner.restaurant.id));
  assert.equal((await A('POST', '/api/admin/payouts/generate', { weekStart: '2026-03-03' })).status, 400); // not a Monday
  const gen = await A('POST', '/api/admin/payouts/generate', { weekStart: '2026-03-02' });
  assert.equal(gen.status, 200);
  assert.equal(gen.body.data.period.periodStart, '2026-03-02');
  assert.equal((await A('GET', '/api/admin/payouts?status=failed')).status, 200);
  const csv = await t.call('GET', '/api/admin/reports/payouts?format=csv', { token: admin.token });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text.split('\n')[0], /Payout,Restaurant,From,To,Amount/);
});

test('all ten reports return data and export CSV with decimal money and formula-safe cells', async () => {
  assert.deepEqual(REPORT_TYPES.sort(), ['commissions', 'cod', 'customers', 'finance', 'orders', 'payments', 'payouts', 'refunds', 'restaurants', 'revenue'].sort());
  for (const type of REPORT_TYPES) {
    const r = await A('GET', `/api/admin/reports/${type}`);
    assert.equal(r.status, 200, type);
    assert.ok(Array.isArray(r.body.data.columns) && Array.isArray(r.body.data.rows), type);
    const csv = await t.call('GET', `/api/admin/reports/${type}?format=csv`, { token: admin.token });
    assert.equal(csv.status, 200, type);
    assert.match(csv.headers.get('content-disposition'), new RegExp(`${type}-report.csv`));
  }
  const rev = (await A('GET', '/api/admin/reports/revenue')).body.data;
  assert.ok(rev.rows.length >= 1);
  assert.ok(rev.rows.every((row) => Number.isInteger(row.gmv_cents)));
  const revCsv = (await t.call('GET', '/api/admin/reports/revenue?format=csv', { token: admin.token })).text.split('\n')[1];
  assert.match(revCsv, /\d+\.\d{2}/);
  assert.equal((await A('GET', '/api/admin/reports/nonsense')).status, 404);
  assert.equal((await A('GET', '/api/admin/reports/revenue?from=yesterday')).status, 400);
  assert.equal((await A('GET', '/api/admin/reports/revenue?from=2026-05-02&to=2026-05-01')).status, 400);
  // spreadsheet formula injection: a customer name starting with "=" is neutralised in CSV
  const evil = await t.registerCustomer('=HYPERLINK("http://evil","x")');
  await t.placeOrder(owner, { ...evil }, [{ productId: product.id, quantity: 1 }], { customerName: '=HYPERLINK("http://evil","x")' });
  const csv = (await t.call('GET', '/api/admin/reports/orders?format=csv', { token: admin.token })).text;
  assert.ok(csv.includes('\'=HYPERLINK') || csv.includes('"\'=HYPERLINK'));
  assert.ok(!/(^|,)=HYPERLINK/m.test(csv));
});

test('settings: platform commission is configurable and is snapshotted on each order', async () => {
  const before = await A('GET', '/api/admin/settings');
  assert.equal(before.body.data.settings.commission_bp, 1000);
  assert.equal((await A('PUT', '/api/admin/settings', { commissionBp: 20000 })).status, 400);
  assert.equal((await A('PUT', '/api/admin/settings', { commissionBp: -1 })).status, 400);
  assert.equal((await A('PUT', '/api/admin/settings', { commissionBp: 'ten' })).status, 400);
  const fresh = await t.createRestaurantOwner('Commission Cafe', 'pro');
  const p = await t.addProduct(fresh, { priceCents: 10000 });
  const o1 = (await t.placeOrder(fresh, customer, [{ productId: p.id, quantity: 1 }])).body.data.order;
  assert.equal((await A('PUT', '/api/admin/settings', { commissionBp: 1500, serviceFeeBp: 200, serviceFeeFixedCents: 25 })).status, 200);
  const o2 = (await t.placeOrder(fresh, customer, [{ productId: p.id, quantity: 1 }])).body.data.order;
  const row = (id) => t.db.prepare('SELECT commission_bp, commission_cents, platform_fee_cents, total_cents, restaurant_amount_cents FROM orders WHERE id = ?').get(id);
  assert.deepEqual({ ...row(o1.id) }, { commission_bp: 1000, commission_cents: 1000, platform_fee_cents: 0, total_cents: 10000, restaurant_amount_cents: 9000 });
  assert.deepEqual({ ...row(o2.id) }, { commission_bp: 1500, commission_cents: 1500, platform_fee_cents: 225, total_cents: 10225, restaurant_amount_cents: 8500 });
  // per-restaurant override wins over the platform default
  t.db.prepare('UPDATE restaurants SET commission_bp_override = 500 WHERE id = ?').run(fresh.restaurant.id);
  const o3 = (await t.placeOrder(fresh, customer, [{ productId: p.id, quantity: 1 }])).body.data.order;
  assert.equal(row(o3.id).commission_cents, 500);
  assert.equal((await t.call('GET', '/api/public/config')).body.data.serviceFee.bp, 200);
  await A('PUT', '/api/admin/settings', { commissionBp: 1000, serviceFeeBp: 0, serviceFeeFixedCents: 0 });
});

test('support reports: customers file them (own orders only), admins triage and respond, users see the response', async () => {
  const mine = (await t.call('GET', '/api/me/orders', { token: customer.token })).body.data.orders[0];
  const stranger = await t.registerCustomer('Stranger');
  const body = { category: 'order', subject: 'Cold food', description: 'The food arrived cold and late.', orderId: mine.id };
  assert.equal((await t.call('POST', '/api/support/reports', { token: stranger.token, body })).status, 400); // someone else's order: rejected
  assert.equal((await t.call('POST', '/api/support/reports', { body })).status, 401);
  assert.equal((await t.call('POST', '/api/support/reports', { token: customer.token, body: { ...body, category: 'nonsense' } })).status, 400);
  assert.equal((await t.call('POST', '/api/support/reports', { token: customer.token, body: { ...body, description: 'short' } })).status, 400);
  const created = await t.call('POST', '/api/support/reports', { token: customer.token, body });
  assert.equal(created.status, 201);
  const pay = await t.call('POST', '/api/support/reports', { token: customer.token, body: { category: 'payment', subject: 'Charged twice', description: 'I was charged twice for one order.' } });
  const list = await A('GET', '/api/admin/support-reports?status=open');
  assert.equal(list.body.data.reports[0].priority, 'high'); // payment problems sort first
  assert.ok(list.body.data.reports.some((r) => r.id === created.body.data.reportId && r.orderId === mine.id));
  assert.equal((await A('PATCH', `/api/admin/support-reports/${created.body.data.reportId}`, { status: 'weird' })).status, 400);
  assert.equal((await A('PATCH', `/api/admin/support-reports/${created.body.data.reportId}`, { status: 'in_progress', priority: 'urgent' })).status, 200);
  const done = await A('PATCH', `/api/admin/support-reports/${created.body.data.reportId}`, { status: 'resolved', adminResponse: 'We refunded the delivery fee.' });
  assert.equal(done.status, 200);
  const seen = await t.call('GET', '/api/support/reports', { token: customer.token });
  const r1 = seen.body.data.reports.find((r) => r.id === created.body.data.reportId);
  assert.equal(r1.status, 'resolved');
  assert.equal(r1.adminResponse, 'We refunded the delivery fee.');
  assert.ok(r1.resolvedAt);
  assert.equal((await t.call('GET', '/api/support/reports', { token: stranger.token })).body.data.reports.length, 0); // no cross-user leakage
  assert.ok(pay.body.data.reportId);
  assert.equal((await A('GET', '/api/admin/support-reports?category=payment')).body.data.reports.every((r) => r.category === 'payment'), true);
});

test('audit log records admin actions without secrets; WhatsApp support link uses the configured number', async () => {
  const log = (await A('GET', '/api/admin/audit?limit=500')).body.data.entries;
  const actions = new Set(log.map((e) => e.action));
  for (const a of ['restaurant.approve', 'restaurant.reject', 'restaurant.suspend', 'restaurant.reactivate', 'user.disabled', 'user.enabled', 'settings.updated', 'payment_account.updated', 'order.cancelled', 'support_report.updated']) {
    assert.ok(actions.has(a), `missing audit action ${a}`);
  }
  assert.ok(log.every((e) => e.actor || e.role === 'system'));
  assert.ok(!JSON.stringify(log).match(/password|secret|hashstring/i));
  const cfg = (await t.call('GET', '/api/public/config')).body.data;
  assert.match(cfg.whatsappUrl, /^https:\/\/wa\.me\/966566148975\?text=/);
  assert.deepEqual(cfg.paymentMethods, { card: true, cod: true });
  const orderView = await t.call('GET', `/api/me/orders/${(await t.call('GET', '/api/me/orders', { token: customer.token })).body.data.orders[0].id}`, { token: customer.token });
  assert.match(orderView.body.data.supportUrl, /^https:\/\/wa\.me\/966566148975\?text=/);
});
