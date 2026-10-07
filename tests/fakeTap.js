// TEST DOUBLE ONLY. A local HTTP server that mimics the documented Tap Payments endpoints
// (POST /charges, GET /charges/:id, POST /refunds, GET /destination/:id) so the real adapter code
// (server/payments/tap.js) can be exercised end-to-end without network access or credentials.
// It lives under tests/ and is never loaded by the application.
const http = require('node:http');
const crypto = require('node:crypto');

async function startFakeTap({ secret = 'sk_test_fake_secret', checkoutBase = 'https://checkout.fake-tap.test' } = {}) {
  const charges = new Map();
  const refunds = new Map();
  const calls = [];
  const behavior = { failRefunds: false, pendingRefunds: false, failCharges: false, failMit: false, knownDestinations: new Set(['dest_known']) };
  const tokens = new Map();
  const payouts = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== `Bearer ${secret}`) return send(401, { errors: [{ description: 'Unauthorized' }] });
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ method: req.method, url: req.url, body });
      const url = new URL(req.url, 'http://x');
      if (req.method === 'POST' && url.pathname === '/charges') {
        if (behavior.failCharges) return send(500, { message: 'boom' });
        const id = `chg_${crypto.randomBytes(6).toString('hex')}`;
        const charge = { id, object: 'charge', status: 'INITIATED', amount: body.amount, currency: body.currency, reference: { ...body.reference, gateway: `gw_${id}`, payment: `pm_${id}` }, destinations: body.destinations, transaction: { url: `${checkoutBase}/${id}`, created: String(Date.now()) } };
        if (body.save_card) { charge.card = { id: `card_${id}`, last_four: '4242', brand: 'VISA' }; charge.customer = { id: `cus_${id}` }; charge.payment_agreement = { id: `agr_${id}` }; }
        if (body.customer_initiated === false) { // merchant-initiated renewal with a token from a saved card
          const tok = tokens.get(body.source?.id);
          if (!tok || tok.used || !body.payment_agreement?.id || behavior.failMit) { charge.status = 'DECLINED'; } else { tok.used = true; charge.status = 'CAPTURED'; }
        }
        charges.set(id, charge);
        return send(200, charge);
      }
      if (req.method === 'POST' && url.pathname === '/tokens') {
        const id = `tok_${crypto.randomBytes(6).toString('hex')}`;
        tokens.set(id, { ...body.saved_card, used: false });
        return send(200, { id, object: 'token', status: 'ACTIVE', used: false });
      }
      if (req.method === 'POST' && url.pathname === '/payouts/list/') {
        const filter = body.payouts?.payout_id;
        return send(200, { object: 'list', count: payouts.length, has_more: false, payouts: payouts.filter((p) => !filter || filter.includes(p.id)) });
      }
      const m = /^\/charges\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const c = charges.get(m[1]);
        return c ? send(200, c) : send(404, { errors: [{ description: 'not found' }] });
      }
      if (req.method === 'POST' && url.pathname === '/refunds') {
        const key = body.reference?.idempotent;
        if (key && refunds.has(key)) return send(200, refunds.get(key)); // provider-side idempotency
        const charge = charges.get(body.charge_id);
        if (!charge) return send(404, { errors: [{ description: 'charge not found' }] });
        const r = { id: `ref_${crypto.randomBytes(6).toString('hex')}`, object: 'refund', status: behavior.failRefunds ? 'FAILED' : behavior.pendingRefunds ? 'PENDING' : 'REFUNDED', amount: body.amount, currency: body.currency, response: { message: behavior.failRefunds ? 'Declined' : 'Succeeded' } };
        if (key) refunds.set(key, r);
        return send(200, r);
      }
      const d = /^\/destination\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && d) {
        return behavior.knownDestinations.has(d[1]) ? send(200, { id: d[1], object: 'destination', display_name: 'Test Restaurant', business_id: `bus_${d[1]}`, wallet_id: `wal_${d[1]}`, business_entity_id: `ent_${d[1]}`, live_mode: false }) : send(404, { errors: [{ description: 'not found' }] });
      }
      return send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Independent re-implementation of Tap's documented "hashstring" so the adapter is checked against the spec,
  // not against itself.
  const money = (a) => (typeof a === 'number' ? a.toFixed(2) : String(a));
  function webhookFor(chargeId, status) {
    const c = charges.get(chargeId);
    if (status) c.status = status;
    const body = { id: c.id, object: 'charge', status: c.status, amount: c.amount, currency: c.currency, reference: c.reference, transaction: c.transaction };
    const msg = `x_id${body.id}x_amount${money(body.amount)}x_currency${body.currency}x_gateway_reference${body.reference.gateway}x_payment_reference${body.reference.payment}x_status${body.status}x_created${body.transaction.created}`;
    const hashstring = crypto.createHmac('sha256', secret).update(msg).digest('hex');
    return { body, headers: { hashstring } };
  }

  return {
    base, secret, charges, refunds, calls, behavior, tokens, payouts,
    capture: (id) => { charges.get(id).status = 'CAPTURED'; },
    setStatus: (id, s) => { charges.get(id).status = s; },
    webhookFor,
    lastCharge: () => [...charges.values()].pop(),
    close: () => new Promise((r) => server.close(r)),
  };
}

module.exports = { startFakeTap };
