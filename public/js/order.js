import {
  api, requireRoles, mountChrome, $, render, html, raw, spinner, errorBox, money, fmtDate, cap, toast, confirmDialog,
} from './common.js';

mountChrome({ active: 'orders' });
const user = requireRoles('customer');
const id = Number(new URLSearchParams(location.search).get('id'));
let timer;

const STEPS = ['pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered'];
const LABEL = {
  awaiting_payment: 'Waiting for payment', pending: 'Order placed', confirmed: 'Accepted by the restaurant', preparing: 'Being prepared',
  ready: 'Ready', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled', rejected: 'Declined by the restaurant',
};
const PAY_LABEL = {
  awaiting_payment: 'Waiting for your card payment', paid: 'Paid by card', failed: 'Payment failed', cancelled: 'Not charged', cod_pending: 'Pay cash on delivery',
  cash_collected: 'Cash paid', refunded: 'Refunded', partially_refunded: 'Partially refunded',
};

async function load({ verifyPayment = false } = {}) {
  try {
    if (verifyPayment) await api(`/me/orders/${id}/refresh-payment`, { method: 'POST' }); // the server asks the payment provider
    draw(await api(`/me/orders/${id}`));
  } catch (e) { render($('#root'), errorBox(e)); }
}

function draw({ order: o, history, payment, supportUrl }) {
  const open = !['delivered', 'cancelled', 'rejected'].includes(o.status);
  const steps = o.orderType === 'pickup' ? STEPS.filter((s) => s !== 'out_for_delivery') : STEPS;
  const reached = history.map((h) => h.status);
  render($('#root'), html`
    <div class="toolbar"><h1>Order #${o.orderNumber}</h1><span class="badge ${o.status}">${LABEL[o.status] || cap(o.status)}</span></div>
    <p class="muted"><a href="/restaurant/${o.restaurantSlug}">${o.restaurantName}</a> · ${fmtDate(o.createdAt)} · ${o.orderType === 'delivery' ? 'Delivery' : 'Pickup'}</p>
    ${o.status === 'awaiting_payment' ? html`<div class="alert warn" role="status">We are waiting for your payment to be confirmed by the payment provider. If you have already paid, this page updates automatically.
        <div style="margin-top:.5rem"><button class="btn sm" data-check>I have paid &mdash; check again</button></div></div>` : ''}
    ${o.status === 'cancelled' && o.paymentStatus === 'failed' ? html`<div class="alert err" role="alert">Your payment was not completed, so the order was cancelled and you were not charged.</div>` : ''}
    ${['cancelled', 'rejected'].includes(o.status) && ['refunded', 'partially_refunded'].includes(o.paymentStatus) ? html`<div class="alert info">Your payment has been refunded to your original payment method. Banks can take a few days to show it.</div>` : ''}
    ${o.status === 'rejected' && o.cancelReason ? html`<div class="alert warn">Reason: ${o.cancelReason}</div>` : ''}
    <div class="grid cols-2">
      <div class="card"><h2>Progress</h2>
        ${['cancelled', 'rejected', 'awaiting_payment'].includes(o.status)
    ? html`<ul class="timeline">${history.map((h) => html`<li><span class="dot"></span><span><strong>${LABEL[h.status] || cap(h.status)}</strong> <span class="muted small">${fmtDate(h.created_at)}</span></span></li>`)}</ul>`
    : html`<ul class="timeline">${steps.map((s) => html`<li style="${reached.includes(s) ? '' : 'opacity:.4'}"><span class="dot"></span><span><strong>${LABEL[s]}</strong> ${reached.includes(s) ? html`<span class="muted small">${fmtDate(history.find((h) => h.status === s).created_at)}</span>` : ''}</span></li>`)}</ul>`}
      </div>
      <div class="card"><h2>Payment</h2>
        <p><strong>${PAY_LABEL[o.paymentStatus] || cap(o.paymentStatus)}</strong>${payment?.refundedCents ? html`<br><span class="muted">Refunded ${money(payment.refundedCents, o.currency)}</span>` : ''}</p>
        <p class="muted small">${o.paymentMethod === 'card' ? 'Card payments are processed by our payment provider; we never see or store your card details.' : 'Please have the exact amount ready when your order arrives.'}</p>
        ${o.deliveryAddress ? html`<p class="small"><strong>Deliver to:</strong> ${o.deliveryAddress}</p>` : ''}</div>
    </div>
    <div class="card" style="margin-top:1rem"><h2>Items</h2>
      <div class="table-wrap"><table><tbody>
        ${o.items.map((i) => html`<tr><td>${i.quantity} × ${i.name}${i.options.length ? html`<div class="muted small">${i.options.map((x) => x.name).join(', ')}</div>` : ''}</td><td class="num">${money(i.lineTotalCents, o.currency)}</td></tr>`)}
        <tr><td class="muted">Subtotal</td><td class="num">${money(o.subtotalCents, o.currency)}</td></tr>
        ${o.taxCents ? html`<tr><td class="muted">Tax</td><td class="num">${money(o.taxCents, o.currency)}</td></tr>` : ''}
        ${o.deliveryFeeCents ? html`<tr><td class="muted">Delivery</td><td class="num">${money(o.deliveryFeeCents, o.currency)}</td></tr>` : ''}
        ${o.platformFeeCents ? html`<tr><td class="muted">Service fee</td><td class="num">${money(o.platformFeeCents, o.currency)}</td></tr>` : ''}
        <tr><td><strong>Total</strong></td><td class="num"><strong>${money(o.totalCents, o.currency)}</strong></td></tr></tbody></table></div>
    </div>
    <div class="actions-row" style="margin-top:1rem">
      ${o.status === 'pending' ? raw('<button class="btn danger" data-cancel>Cancel order</button>') : ''}
      ${supportUrl ? html`<a class="btn secondary" href="${supportUrl}" target="_blank" rel="noopener">Chat on WhatsApp</a>` : ''}
      <a class="btn secondary" href="/report.html?order=${o.id}">Report a problem</a>
      <a class="btn secondary" href="/orders.html">All orders</a>
    </div>`);
  clearInterval(timer);
  if (open) timer = setInterval(() => { if (!document.hidden) load({ verifyPayment: o.status === 'awaiting_payment' }); }, o.status === 'awaiting_payment' ? 5000 : 15000);
}

$('#root').addEventListener('click', async (e) => {
  try {
    if (e.target.closest('[data-check]')) { await load({ verifyPayment: true }); toast('Checked with the payment provider'); }
    if (e.target.closest('[data-cancel]') && await confirmDialog('Cancel this order? If you paid by card you will be refunded.', { confirmLabel: 'Cancel order', danger: true })) {
      await api(`/me/orders/${id}/cancel`, { method: 'POST' });
      toast('Order cancelled', 'ok');
      load();
    }
  } catch (err) { toast(err, 'err'); }
});

if (user) {
  render($('#root'), spinner());
  // returning from the payment page: verify with the provider straight away
  load({ verifyPayment: true });
}
