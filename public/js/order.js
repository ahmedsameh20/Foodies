import {
  api, requireRoles, mountChrome, $, render, html, raw, spinner, errorBox, money, fmtDate, toast, confirmDialog, t, loc, locKeys, statusLabel, payLabel,
} from './common.js';

mountChrome({ active: 'orders' });
const user = requireRoles('customer');
const id = Number(new URLSearchParams(location.search).get('id'));
let timer;

const STEPS = ['pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered'];

async function load({ verifyPayment = false } = {}) {
  try {
    if (verifyPayment) await api(`/me/orders/${id}/refresh-payment`, { method: 'POST' }); // the server asks the payment provider
    draw(await api(`/me/orders/${id}`));
  } catch (e) { render($('#root'), errorBox(e)); }
}

// One order line exactly as it was sold (a snapshot: later menu edits do not change it). The dish is shown in the customer's language
// with a fallback to whichever language the restaurant provided.
function itemRow(i, o) {
  const m = (c) => money(c, o.currency);
  const discounted = i.originalUnitPriceCents != null && i.baseUnitPriceCents != null && i.originalUnitPriceCents > i.baseUnitPriceCents;
  if (i.kind === 'extra') { // a general extra ordered on its own: a line of its own, not a change to a dish
    return html`<tr><td>${i.quantity} × ${loc(i)} <span class="badge nocap">${t('gx.lineBadge')}</span>
      <div class="small muted"><bdi>${m(i.unitPriceCents)}</bdi> × ${i.quantity}</div></td>
      <td class="num">${m(i.lineTotalCents)}</td></tr>`;
  }
  return html`<tr><td>${i.quantity} × ${loc(i)}
      ${discounted ? html`<div class="small"><span class="price-was">${m(i.originalUnitPriceCents)}</span> ${m(i.baseUnitPriceCents)}</div>` : ''}
      ${i.options.length ? html`<ul class="line-extras">${i.options.map((x) => html`<li>+ ${loc(x)}${x.quantity > 1 ? ` × ${x.quantity}` : ''} <bdi>(${m(x.priceCents * x.quantity)})</bdi></li>`)}</ul>` : ''}
      ${i.instructions ? html`<div class="line-note"><strong>${t('cart.instructions')}:</strong> ${i.instructions}</div>` : ''}</td>
    <td class="num">${m(i.lineTotalCents)}</td></tr>`;
}

function draw({ order: o, history, payment, supportUrl }) {
  const open = !['delivered', 'cancelled', 'rejected'].includes(o.status);
  const steps = o.orderType === 'pickup' ? STEPS.filter((s) => s !== 'out_for_delivery') : STEPS;
  const reached = history.map((h) => h.status);
  render($('#root'), html`
    <div class="toolbar"><h1>${t('order.title', { n: o.orderNumber })}</h1><span class="badge ${o.status}">${statusLabel(o.status)}</span></div>
    <p class="muted"><a href="/restaurant/${o.restaurantSlug}">${locKeys(o, 'restaurantNameAr', 'restaurantNameEn', 'restaurantName')}</a> · ${fmtDate(o.createdAt)} · ${o.orderType === 'delivery' ? t('order.delivery') : t('order.pickup')}${o.branchName ? ` · ${t('order.branch', { name: o.branchName })}` : ''}</p>
    ${o.status === 'awaiting_payment' ? html`<div class="alert warn" role="status">${t('order.waitingPayment')}
        <div style="margin-top:.5rem"><button class="btn sm" data-check>${t('order.checkAgain')}</button></div></div>` : ''}
    ${o.status === 'cancelled' && o.paymentStatus === 'failed' ? html`<div class="alert err" role="alert">${t('order.paymentFailed')}</div>` : ''}
    ${['cancelled', 'rejected'].includes(o.status) && ['refunded', 'partially_refunded'].includes(o.paymentStatus) ? html`<div class="alert info">${t('order.refunded')}</div>` : ''}
    ${o.status === 'rejected' && o.cancelReason ? html`<div class="alert warn">${t('order.reason')}: ${o.cancelReason}</div>` : ''}
    <div class="grid cols-2">
      <div class="card"><h2>${t('order.progress')}</h2>
        ${['cancelled', 'rejected', 'awaiting_payment'].includes(o.status)
    ? html`<ul class="timeline">${history.map((h) => html`<li><span class="dot"></span><span><strong>${statusLabel(h.status)}</strong> <span class="muted small">${fmtDate(h.created_at)}</span></span></li>`)}</ul>`
    : html`<ul class="timeline">${steps.map((s) => html`<li style="${reached.includes(s) ? '' : 'opacity:.4'}"><span class="dot"></span><span><strong>${statusLabel(s)}</strong> ${reached.includes(s) ? html`<span class="muted small">${fmtDate(history.find((h) => h.status === s).created_at)}</span>` : ''}</span></li>`)}</ul>`}
      </div>
      <div class="card"><h2>${t('order.payment')}</h2>
        <p><strong>${payLabel(o.paymentStatus)}</strong>${payment?.refundedCents ? html`<br><span class="muted">${t('order.refundedAmount', { amount: money(payment.refundedCents, o.currency) })}</span>` : ''}</p>
        <p class="muted small">${o.paymentMethod === 'card' ? t('order.cardNote') : t('order.cashNote')}</p>
        ${o.deliveryAddress ? html`<p class="small"><strong>${t('order.deliverTo')}:</strong> ${o.deliveryAddress}</p>` : ''}
        ${o.notes ? html`<p class="small"><strong>${t('order.notes')}:</strong> ${o.notes}</p>` : ''}</div>
    </div>
    <div class="card" style="margin-top:1rem"><h2>${t('order.items')}</h2>
      <div class="table-wrap"><table><tbody>
        ${o.items.map((i) => itemRow(i, o))}
        <tr><td class="muted">${t('cart.subtotal')}</td><td class="num">${money(o.subtotalCents, o.currency)}</td></tr>
        ${o.couponDiscountCents ? html`<tr><td class="muted">${t('coupon.discountRow')} <bdi dir="ltr">(${o.couponCode})</bdi></td><td class="num">−${money(o.couponDiscountCents, o.currency)}</td></tr>` : ''}
        ${o.taxCents ? html`<tr><td class="muted">${t('cart.tax')}</td><td class="num">${money(o.taxCents, o.currency)}</td></tr>` : ''}
        ${o.deliveryFeeCents ? html`<tr><td class="muted">${t('cart.delivery')}</td><td class="num">${money(o.deliveryFeeCents, o.currency)}</td></tr>` : ''}
        ${o.platformFeeCents ? html`<tr><td class="muted">${t('cart.serviceFee')}</td><td class="num">${money(o.platformFeeCents, o.currency)}</td></tr>` : ''}
        <tr><td><strong>${t('cart.total')}</strong></td><td class="num"><strong>${money(o.totalCents, o.currency)}</strong></td></tr></tbody></table></div>
    </div>
    <div class="actions-row" style="margin-top:1rem">
      ${o.status === 'pending' ? raw(`<button class="btn danger" data-cancel>${t('order.cancel')}</button>`) : ''}
      ${supportUrl ? html`<a class="btn secondary" href="${supportUrl}" target="_blank" rel="noopener">${t('order.whatsapp')}</a>` : ''}
      <a class="btn secondary" href="/report.html?order=${o.id}">${t('order.report')}</a>
      <a class="btn secondary" href="/orders.html">${t('order.all')}</a>
    </div>`);
  clearInterval(timer);
  if (open) timer = setInterval(() => { if (!document.hidden) load({ verifyPayment: o.status === 'awaiting_payment' }); }, o.status === 'awaiting_payment' ? 5000 : 15000);
}

$('#root').addEventListener('click', async (e) => {
  try {
    if (e.target.closest('[data-check]')) { await load({ verifyPayment: true }); toast(t('order.checked')); }
    if (e.target.closest('[data-cancel]') && await confirmDialog(t('order.cancelConfirm'), { confirmLabel: t('order.cancel'), danger: true })) {
      await api(`/me/orders/${id}/cancel`, { method: 'POST' });
      toast(t('order.cancelled'), 'ok');
      load();
    }
  } catch (err) { toast(err, 'err'); }
});

if (user) {
  render($('#root'), spinner());
  // returning from the payment page: verify with the provider straight away
  load({ verifyPayment: true });
}
