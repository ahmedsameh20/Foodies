// End-to-end smoke test against a RUNNING server. It creates throw-away accounts through the public API.
//   node scripts/smoke.js http://localhost:3000
// Optional: SMOKE_ADMIN_EMAIL / SMOKE_ADMIN_PASSWORD let it approve the new restaurant and exercise the whole
// order lifecycle; without them it verifies everything up to "waiting for approval".
const base = process.argv[2] || 'http://localhost:3000';
let failed = 0;

async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or csv */ }
  return { status: res.status, json, text };
}
function step(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
  if (!ok) failed++;
}

(async () => {
  const stamp = Date.now();
  const pw = `Smoke-${stamp}-Pw1`;
  const health = await call('GET', '/api/health');
  step('health endpoint', health.status === 200 && health.json.data.database === 'ok', health.text);

  const owner = await call('POST', '/api/auth/register-owner', { body: { name: 'Smoke Owner', email: `smoke.owner.${stamp}@example.test`, password: pw } });
  step('owner registers', owner.status === 201, owner.text);
  const ot = owner.json.data.token;
  const rest = await call('POST', '/api/onboarding/restaurant', { token: ot, body: { name: `Smoke Grill ${stamp}`, city: 'Testville' } });
  step('restaurant onboarding (pending approval)', rest.status === 201 && rest.json.data.restaurant.approval_status === 'pending', rest.text);
  const slug = rest.json.data.restaurant.slug;
  const prod = await call('POST', '/api/manage/products', { token: ot, body: { name: 'Smoke Burger', priceCents: 899 } });
  step('menu item created', prod.status === 201, prod.text);
  step('unapproved restaurant is not public', (await call('GET', `/api/public/restaurants/${slug}`)).status === 404);

  const cust = await call('POST', '/api/auth/register', { body: { name: 'Smoke Customer', email: `smoke.cust.${stamp}@example.test`, password: pw } });
  const ct = cust.json.data.token;
  step('anonymous blocked from the dashboard API (401)', (await call('GET', '/api/manage/orders')).status === 401);
  step('customer blocked from the dashboard API (403)', (await call('GET', '/api/manage/orders', { token: ct })).status === 403);
  step('customer blocked from the admin API (403)', (await call('GET', '/api/admin/stats', { token: ct })).status === 403);

  const { SMOKE_ADMIN_EMAIL: ae, SMOKE_ADMIN_PASSWORD: ap } = process.env;
  if (ae && ap) {
    const login = await call('POST', '/api/auth/login', { body: { email: ae, password: ap } });
    step('admin signs in', login.status === 200 && login.json.data.user.role === 'super_admin', login.text);
    const at = login.json.data.token;
    const approve = await call('POST', `/api/admin/restaurants/${rest.json.data.restaurant.id}/approve`, { token: at, body: {} });
    step('admin approves the restaurant', approve.status === 200, approve.text);

    const menu = await call('GET', `/api/public/restaurants/${slug}`);
    step('public menu visible after approval', menu.status === 200 && menu.json.data.products.length === 1, menu.text);
    const order = await call('POST', `/api/public/restaurants/${slug}/orders`, {
      token: ct, headers: { 'Idempotency-Key': `smoke-${stamp}-key` },
      body: { items: [{ productId: prod.json.data.product.id, quantity: 2 }], orderType: 'pickup', paymentMethod: 'cod', customerName: 'Smoke', customerPhone: '+15551234567' },
    });
    step('cash order placed with a server-side total', order.status === 201 && order.json.data.order.totalCents === 1798, order.text);
    const oid = order.json.data.order.id;
    let ok = true;
    for (const status of ['confirmed', 'preparing', 'ready', 'delivered']) {
      const r = await call('PATCH', `/api/manage/orders/${oid}/status`, { token: ot, body: { status } });
      ok = ok && r.status === 200;
    }
    step('restaurant moves the order through to delivered', ok);
    const mine = await call('GET', `/api/me/orders/${oid}`, { token: ct });
    step('customer sees delivered + cash collected', mine.json?.data?.order?.status === 'delivered' && mine.json.data.order.paymentStatus === 'cash_collected', mine.text);
    const earn = await call('GET', '/api/manage/earnings', { token: ot });
    step('cash commission receivable recorded', earn.status === 200 && earn.json.data.codCommissionDueCents > 0, earn.text);
    const payments = await call('GET', '/api/admin/payments?method=cod', { token: at });
    step('admin sees the cash payment', payments.status === 200 && payments.json.data.payments.some((p) => p.orderId === oid), payments.text);
    const other = await call('POST', '/api/auth/register-owner', { body: { name: 'Other Owner', email: `smoke.other.${stamp}@example.test`, password: pw } });
    await call('POST', '/api/onboarding/restaurant', { token: other.json.data.token, body: { name: `Other Place ${stamp}` } });
    step('another restaurant cannot read the order (404)', (await call('GET', `/api/manage/orders/${oid}`, { token: other.json.data.token })).status === 404);
  } else {
    console.log('SKIP  approval + order lifecycle (set SMOKE_ADMIN_EMAIL and SMOKE_ADMIN_PASSWORD to run them)');
  }
  step('public restaurant page is served', (await call('GET', `/restaurant/${slug}`)).text.includes('restaurant.js'));

  console.log(failed ? `\n${failed} step(s) FAILED` : '\nSmoke test passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
