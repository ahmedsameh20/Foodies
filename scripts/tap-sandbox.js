// REAL Tap SANDBOX verification runner. This talks to api.tap.company with YOUR sandbox key. It is NOT part of `npm test`
// and it never uses tests/fakeTap.js. Without credentials it does nothing except say so:  TAP SANDBOX NOT VERIFIED.
//
//   TAP_SECRET_KEY=sk_test_...  TAP_MERCHANT_ID=merchant_...  node scripts/tap-sandbox.js
//   optional: TAP_TEST_DESTINATION_ID  (a sandbox business destination, enables the split + destination checks)
//             TAP_TEST_PHONE           (payer phone, enables the save-card / merchant-initiated renewal check)
//             TAP_PUBLIC_URL           (public https URL that reaches this machine, e.g. a tunnel; enables the webhook check,
//                                       listener on TAP_LISTEN_PORT, default 3999)
//             TAP_WAIT_SECONDS         (how long to wait for you to pay in the browser, default 300)
//
// Safety: refuses any key that is not sk_test_. Writes a redacted evidence file to sandbox-results/ (no keys, no card data).
// Steps that need a person (paying on Tap's hosted page with a Tap TEST card) print the URL and wait.
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const config = require('../server/config');
const { createTapProvider } = require('../server/payments/tap');
const { ProviderError } = require('../server/payments/provider');

const key = process.env.TAP_SECRET_KEY || process.env.PAYMENT_SECRET_KEY || '';
if (!key) {
  console.log('TAP SANDBOX NOT VERIFIED');
  console.log('No sandbox credentials found. Set TAP_SECRET_KEY=sk_test_... (and TAP_MERCHANT_ID) and run again. See docs/PAYMENTS.md section 13.');
  process.exit(2);
}
if (!/^sk_test_/.test(key)) { console.error('Refusing to run: this runner only accepts a sandbox key (sk_test_...).'); process.exit(3); }

const merchantId = process.env.TAP_MERCHANT_ID || process.env.PAYMENT_MERCHANT_ID || '';
const apiBase = (process.env.PAYMENT_API_BASE || 'https://api.tap.company/v2').replace(/\/+$/, '');
const publicUrl = (process.env.TAP_PUBLIC_URL || '').replace(/\/+$/, '');
const destId = process.env.TAP_TEST_DESTINATION_ID || '';
const phone = process.env.TAP_TEST_PHONE || '';
const waitMs = (Number(process.env.TAP_WAIT_SECONDS) || 300) * 1000;
const cur = process.env.CURRENCY || 'SAR';

const provider = createTapProvider({ payment: { secretKey: key, apiBase, merchantId, webhookSecret: process.env.TAP_WEBHOOK_SECRET || key } }, ProviderError);
const results = [];
const evidence = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redact = (v) => JSON.parse(JSON.stringify(v, (k, x) => (/email|phone|name|ip|token|secret|authorization/i.test(k) && typeof x === 'string' ? '[redacted]' : x)));
const record = (name, status, detail = '') => { results.push({ name, status, detail }); console.log(`${status.padEnd(5)} ${name}${detail ? ` — ${detail}` : ''}`); };
async function step(name, fn) {
  try { const r = await fn(); record(name, r === 'SKIP' ? 'SKIP' : 'PASS', typeof r === 'string' && r !== 'SKIP' ? r : ''); } catch (e) { record(name, 'FAIL', `${e.code || ''} ${e.message}`.trim()); }
}
async function raw(method, p, body) { // raw JSON for documenting the real response structure
  const r = await fetch(`${apiBase}${p}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const shape = (o, d = 0) => (o && typeof o === 'object' && d < 4 ? (Array.isArray(o) ? [o.length ? shape(o[0], d + 1) : null] : Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v, d + 1)]))) : typeof o);

// ---- optional webhook listener
const received = [];
let server = null;
if (publicUrl) {
  server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { try { received.push({ headers: { hashstring: req.headers.hashstring }, body: JSON.parse(b || '{}'), at: Date.now() }); } catch { /* ignore */ } res.writeHead(200); res.end('ok'); });
  }).listen(Number(process.env.TAP_LISTEN_PORT) || 3999);
}
const webhookUrl = publicUrl ? `${publicUrl}/webhooks/tap` : 'https://example.com/webhooks/tap';

async function waitForPayment(id, label) {
  console.log(`  ... waiting up to ${Math.round(waitMs / 1000)}s for the ${label} to be paid with a Tap TEST card on the checkout page`);
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    const c = await provider.retrieveCharge(id);
    if (!['INITIATED', 'PENDING', 'IN_PROGRESS'].includes(c.status)) return c;
    await sleep(5000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

(async () => {
  console.log(`Tap SANDBOX run · currency ${cur} · merchant ${merchantId ? 'set' : 'NOT set'} · destination ${destId ? 'set' : 'not set'} · webhook ${publicUrl ? 'listening' : 'off'}\n`);
  let chargeId = null;
  let paid = null;

  await step('1. create charge (SAR, hosted checkout)', async () => {
    const ref = `ord_sbx${Date.now()}`;
    const c = await provider.createCharge({ paymentId: 0, orderId: 0, referenceTransaction: `pay_${ref}`, referenceOrder: ref, amountCents: 1000, currency: cur,
      customer: { firstName: 'Sandbox', email: 'sandbox@example.com' }, description: 'sandbox verification', returnUrl: 'https://example.com/return', webhookUrl });
    chargeId = c.providerTransactionId;
    evidence.createCharge = { id: chargeId, status: c.status, hasRedirectUrl: Boolean(c.redirectUrl) };
    console.log(`  Pay here with a Tap test card: ${c.redirectUrl}`);
    return `charge ${chargeId} status ${c.status}`;
  });

  await step('2. customer pays; provider re-fetch shows CAPTURED, amount/currency/reference match', async () => {
    if (!chargeId) throw new Error('no charge');
    paid = await waitForPayment(chargeId, 'charge');
    const r = await raw('GET', `/charges/${chargeId}`);
    evidence.chargeResponseShape = shape(r.json);
    evidence.chargePaymentSource = r.json?.source?.payment_method || r.json?.source?.channel || null;
    if (paid.status !== 'CAPTURED') throw new Error(`status ${paid.status}`);
    if (paid.amountCents !== 1000 || paid.currency !== cur.toUpperCase()) throw new Error(`amount/currency mismatch ${paid.amountCents} ${paid.currency}`);
    if (!/^ord_sbx/.test(paid.orderRef || '')) throw new Error(`order reference missing: ${paid.orderRef}`);
    return `source ${evidence.chargePaymentSource}`;
  });

  await step('3. webhook delivered and hashstring verifies (needs TAP_PUBLIC_URL)', async () => {
    if (!publicUrl) return 'SKIP';
    const end = Date.now() + 60000;
    while (Date.now() < end && !received.some((w) => w.body.id === chargeId)) await sleep(2000);
    const w = received.find((x) => x.body.id === chargeId);
    if (!w) throw new Error('no webhook received');
    evidence.webhook = { fields: shape(w.body), hasHashstring: Boolean(w.headers.hashstring) };
    if (!provider.verifyWebhook(w.headers, w.body)) throw new Error('hashstring did NOT verify with our formula (check x_created field mapping)');
    if (provider.verifyWebhook({ hashstring: 'a'.repeat(64) }, w.body)) throw new Error('forged signature accepted');
    return 'signature verified; forged signature rejected';
  });

  await step('4. partial refund then full refund of the remainder, idempotent replay', async () => {
    if (!paid || paid.status !== 'CAPTURED') return 'SKIP';
    const k = `sbx-${crypto.randomBytes(5).toString('hex')}`;
    const a = await provider.createRefund({ providerTransactionId: chargeId, amountCents: 200, currency: cur, reason: 'requested_by_customer', idempotencyKey: `${k}-a` });
    const replay = await provider.createRefund({ providerTransactionId: chargeId, amountCents: 200, currency: cur, reason: 'requested_by_customer', idempotencyKey: `${k}-a` });
    const b = await provider.createRefund({ providerTransactionId: chargeId, amountCents: 800, currency: cur, reason: 'requested_by_customer', idempotencyKey: `${k}-b` });
    evidence.refunds = { partial: a.status, replayedSameId: a.providerRefundId === replay.providerRefundId, remainder: b.status };
    if (a.status !== 'succeeded' || b.status !== 'succeeded') throw new Error(`partial ${a.status}, remainder ${b.status}`);
    if (a.providerRefundId !== replay.providerRefundId) throw new Error('idempotent replay produced a different refund id');
    return 'partial + remainder succeeded';
  });

  await step('5. destination lookup: documented fields only, no KYC/status field', async () => {
    if (!destId) return 'SKIP';
    const r = await raw('GET', `/destination/${encodeURIComponent(destId)}`);
    evidence.destinationShape = shape(r.json);
    const d = await provider.retrieveDestination(destId);
    evidence.destinationHasStatusField = Boolean(r.json && ('status' in r.json || 'kyc_status' in r.json));
    return `wallet ${d.walletId || '—'} business ${d.businessId || '—'} liveMode ${d.liveMode}; status field present: ${evidence.destinationHasStatusField}`;
  });

  await step('6. marketplace split: charge with destinations, restaurant share only', async () => {
    if (!destId) return 'SKIP';
    const ref = `ord_sbxs${Date.now()}`;
    const c = await provider.createCharge({ paymentId: 0, orderId: 0, referenceTransaction: `pay_${ref}`, referenceOrder: ref, amountCents: 10000, currency: cur,
      customer: { firstName: 'Sandbox', email: 'sandbox@example.com' }, destination: { id: destId, amountCents: 9000 }, description: 'sandbox split', returnUrl: 'https://example.com/return', webhookUrl });
    console.log(`  Pay the SPLIT charge with a Tap test card: ${c.redirectUrl}`);
    const done = await waitForPayment(c.providerTransactionId, 'split charge');
    const r = await raw('GET', `/charges/${c.providerTransactionId}`);
    evidence.splitChargeShape = shape(r.json);
    evidence.splitDestinationsEchoed = r.json?.destinations || null;
    if (done.status !== 'CAPTURED') throw new Error(`status ${done.status}`);
    return `captured; destinations echoed: ${JSON.stringify(r.json?.destinations ?? null)} — CONFIRM the allocation in the Tap dashboard (wallet balances) before trusting it`;
  });

  await step('7. payouts list (read-only): structure and statuses', async () => {
    const r = await raw('POST', '/payouts/list/', { merchants: merchantId ? [merchantId] : [] });
    evidence.payoutsListShape = shape(r.json);
    evidence.payoutsHttp = r.status;
    const rows = await provider.listPayouts({ merchantIds: merchantId ? [merchantId] : [] }).catch((e) => { throw e; });
    evidence.payoutStatusesSeen = [...new Set(rows.map((p) => p.statusRaw))];
    return `HTTP ${r.status}, ${rows.length} payout(s), statuses seen: ${evidence.payoutStatusesSeen.join(', ') || 'none'}`;
  });

  await step('8. save card + merchant-initiated renewal (needs TAP_TEST_PHONE)', async () => {
    if (!phone) return 'SKIP';
    const ref = `inv_sbx${Date.now()}`;
    const c = await provider.createCharge({ paymentId: 0, orderId: 0, referenceTransaction: `sub_${ref}`, referenceOrder: ref, amountCents: 1000, currency: cur,
      customer: { firstName: 'Sandbox', email: 'sandbox@example.com', phone }, description: 'sandbox save card', returnUrl: 'https://example.com/return', webhookUrl, saveCard: true });
    console.log(`  Pay (and save the card) with a Tap test card: ${c.redirectUrl}`);
    const first = await waitForPayment(c.providerTransactionId, 'first (card-saving) charge');
    evidence.savedCardIds = { card: Boolean(first.card?.id), customer: Boolean(first.customerId), agreement: Boolean(first.agreementId) };
    if (!first.card?.id || !first.customerId || !first.agreementId) throw new Error('charge response lacked card.id / customer.id / payment_agreement.id');
    const mit = await provider.chargeSavedCard({ customerId: first.customerId, cardId: first.card.id, agreementId: first.agreementId, referenceTransaction: `sub_${ref}_a1`, referenceOrder: ref, amountCents: 1000, currency: cur, description: 'sandbox renewal', webhookUrl, idempotencyKey: `${ref}_a1` });
    const check = await provider.retrieveCharge(mit.providerTransactionId);
    evidence.mit = { status: check.status };
    if (check.status !== 'CAPTURED') throw new Error(`merchant-initiated charge ended ${check.status}`);
    return 'renewal charged without customer interaction';
  });

  server?.close();
  const summary = { ranAt: new Date().toISOString(), apiBase, currency: cur, results, evidence: redact(evidence) };
  fs.mkdirSync(path.join(config.ROOT, 'sandbox-results'), { recursive: true });
  const file = path.join(config.ROOT, 'sandbox-results', `tap-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
  const n = (s) => results.filter((r) => r.status === s).length;
  console.log(`\nTAP SANDBOX: ${n('PASS')} passed, ${n('FAIL')} failed, ${n('SKIP')} skipped (skipped steps are NOT VERIFIED). Evidence: ${file}`);
  process.exit(n('FAIL') ? 1 : 0);
})();
