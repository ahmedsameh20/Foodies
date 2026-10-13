import { api, requireRoles, mountChrome, $, render, html, raw, esc, spinner, emptyState, errorBox, money, fmtDate, statusLabel, payLabel, t, locKeys } from './common.js';

mountChrome({ active: 'orders' });
const user = requireRoles('customer');

const TONE = { delivered: 'completed', cancelled: 'cancelled', rejected: 'cancelled' };

async function load() {
  render($('#list'), spinner());
  try {
    const { orders } = await api('/me/orders');
    if (!orders.length) return render($('#list'), emptyState(t('orders.none'), raw(`${esc(t('orders.noneText'))} <a href="/restaurants.html">${esc(t('nav.restaurants'))}</a>`)));
    render($('#list'), html`<div class="grid">${orders.map((o) => html`<a class="card order-card" href="/order.html?id=${o.id}" style="text-decoration:none;color:inherit">
      <header><div><strong>${locKeys(o, 'restaurantNameAr', 'restaurantNameEn', 'restaurantName')}</strong> <span class="muted small">#${o.orderNumber} · ${fmtDate(o.createdAt)}</span></div><span class="badge ${TONE[o.status] || o.status}">${statusLabel(o.status)}</span></header>
      <div class="muted small">${o.orderType === 'delivery' ? t('order.delivery') : t('order.pickup')} · ${o.paymentMethod === 'card' ? t('orders.card') : t('orders.cod')} · ${payLabel(o.paymentStatus)}</div>
      <strong>${money(o.totalCents, o.currency)}</strong></a>`)}</div>`);
  } catch (e) { render($('#list'), errorBox(e)); }
}

if (user) load();
