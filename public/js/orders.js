import { api, requireRoles, mountChrome, $, render, html, raw, spinner, emptyState, errorBox, money, fmtDate, cap } from './common.js';

mountChrome({ active: 'orders' });
const user = requireRoles('customer');

const TONE = { delivered: 'completed', cancelled: 'cancelled', rejected: 'cancelled' };

async function load() {
  render($('#list'), spinner());
  try {
    const { orders } = await api('/me/orders');
    if (!orders.length) return render($('#list'), emptyState('No orders yet', raw('Pick a restaurant and place your first order. <a href="/restaurants.html">Browse restaurants</a>')));
    render($('#list'), html`<div class="grid">${orders.map((o) => html`<a class="card order-card" href="/order.html?id=${o.id}" style="text-decoration:none;color:inherit">
      <header><div><strong>${o.restaurantName}</strong> <span class="muted small">#${o.orderNumber} · ${fmtDate(o.createdAt)}</span></div><span class="badge ${TONE[o.status] || o.status}">${cap(o.status)}</span></header>
      <div class="muted small">${o.orderType === 'delivery' ? 'Delivery' : 'Pickup'} · ${o.paymentMethod === 'card' ? 'Card' : 'Cash on delivery'} · ${cap(o.paymentStatus)}</div>
      <strong>${money(o.totalCents, o.currency)}</strong></a>`)}</div>`);
  } catch (e) { render($('#list'), errorBox(e)); }
}

if (user) load();
