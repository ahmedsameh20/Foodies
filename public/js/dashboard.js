import {
  api, requireRoles, mountChrome, $, render, html, raw, money, fmtDate, fmtDay, cap, toCents, fromCents,
  spinner, emptyState, errorBox, toast, onSubmit, confirmDialog, promptDialog, wireDialog,
} from './common.js';

mountChrome({ active: 'dashboard' });
const user = requireRoles('owner', 'staff');

let ctx; // { restaurant, subscription, paymentAccount, role }
let refreshTimer;
const isOwner = () => ctx.role === 'owner';
const m = (c) => money(c, ctx.restaurant.currency);

const TABS = [
  { id: 'overview', label: 'Overview', roles: ['owner', 'staff'] },
  { id: 'orders', label: 'Orders', roles: ['owner', 'staff'] },
  { id: 'menu', label: 'Menu', roles: ['owner', 'staff'] },
  { id: 'earnings', label: 'Finance & settlement', roles: ['owner'] },
  { id: 'customers', label: 'Customers', roles: ['owner'] },
  { id: 'reports', label: 'Reports', roles: ['owner'] },
  { id: 'team', label: 'Team & branches', roles: ['owner'] },
  { id: 'subscription', label: 'Subscription', roles: ['owner'] },
  { id: 'settings', label: 'Profile & settings', roles: ['owner'] },
];

async function boot() {
  if (!user) return;
  try {
    ctx = await api('/manage/restaurant');
  } catch (e) {
    if (e.code === 'onboarding_required') return (location.href = '/onboarding.html');
    return render($('#root'), errorBox(e));
  }
  window.addEventListener('hashchange', route);
  route();
}

function shell(active) {
  const tabs = TABS.filter((t) => t.roles.includes(ctx.role));
  const r = ctx.restaurant;
  const sub = ctx.subscription;
  render($('#root'), html`
    ${r.approvalStatus === 'pending' ? html`<div class="alert info" role="status"><strong>Waiting for approval.</strong> Your restaurant is not visible to customers yet. You can prepare your menu in the meantime.</div>` : ''}
    ${r.approvalStatus === 'rejected' ? html`<div class="alert err" role="alert"><strong>Application not approved.</strong> ${r.rejectionReason || ''} Please contact support.</div>` : ''}
    ${['expired', 'cancelled', 'past_due'].includes(sub.status) && r.isActive ? html`<div class="alert ${sub.status === 'past_due' ? 'warn' : 'err'}" role="alert"><strong>Subscription ${cap(sub.status)}.</strong> ${sub.status === 'past_due' ? 'Payment is due.' : 'Customers cannot order from you.'} <a href="#subscription">Open subscription</a></div>` : ''}
    ${!r.isActive ? html`<div class="alert err" role="alert"><strong>Your restaurant is suspended.</strong> Customers cannot order. Please contact support.</div>` : ''}
    <div class="toolbar"><div><h1 style="margin:0">${r.name} ${r.isDemo ? raw('<span class="badge demo">Sample</span>') : ''}</h1>
      <span class="muted small">${ctx.role === 'owner' ? 'Owner' : 'Staff'} · ${sub.plan.name} plan · <span class="badge ${['active', 'trialing'].includes(sub.status) ? 'ok' : 'warn'}">${cap(sub.status)}</span></span></div>
      ${r.approvalStatus === 'approved' ? html`<a class="btn secondary" href="/restaurant/${r.slug}" target="_blank" rel="noopener">View public page ↗</a>` : ''}</div>
    <div class="dash">
      <nav class="side" aria-label="Dashboard">${tabs.map((t) => html`<a href="#${t.id}" ${t.id === active ? raw('aria-current="page"') : ''}>${t.label}</a>`)}</nav>
      <section id="panel" aria-live="polite" aria-busy="true"></section>
    </div>`);
}

async function route() {
  clearInterval(refreshTimer);
  let id = location.hash.slice(1) || 'overview';
  const tab = TABS.find((t) => t.id === id && t.roles.includes(ctx.role));
  if (!tab) { id = 'overview'; history.replaceState(null, '', '#overview'); }
  shell(id);
  const panel = $('#panel');
  panel.onclick = null; panel.onchange = null;
  render(panel, spinner());
  try { await views[id](panel); } catch (e) { render(panel, errorBox(e)); } finally { panel.removeAttribute('aria-busy'); }
}

const reload = async (refreshCtx = true) => { if (refreshCtx) ctx = await api('/manage/restaurant'); route(); };

// ---------------- views ----------------
const views = {
  async overview(panel) {
    const o = await api('/manage/overview');
    const sub0 = ctx.subscription;
    const u = sub0.usage;
    const lim = sub0.plan.limits;
    render(panel, html`
      <div class="grid cols-4">
        <div class="card stat"><div class="label">New orders</div><div class="value">${o.pending}</div></div>
        <div class="card stat"><div class="label">In progress</div><div class="value">${o.inProgress}</div></div>
        <div class="card stat"><div class="label">Orders today</div><div class="value">${o.ordersToday}</div></div>
        ${isOwner() ? html`<div class="card stat"><div class="label">Order value today</div><div class="value">${m(o.revenueTodayCents)}</div></div>` : html`<div class="card stat"><div class="label">Menu items</div><div class="value">${o.menuItems}</div></div>`}
      </div>
      ${o.pending ? html`<div class="alert info" style="margin-top:1rem">${o.pending} new order${o.pending === 1 ? '' : 's'} waiting for you. <a href="#orders">Review orders</a></div>` : ''}
      ${ctx.restaurant.approvalStatus === 'approved' ? html`<div class="card" style="margin-top:1rem"><h2>Your public page</h2>
        <p>Share this link with customers: <a href="/restaurant/${ctx.restaurant.slug}" target="_blank" rel="noopener"><code>${location.origin}/restaurant/${ctx.restaurant.slug}</code></a></p>
        ${!ctx.restaurant.acceptingOrders ? raw('<div class="alert warn">You are currently <strong>not accepting orders</strong>. Change this in Profile &amp; settings.</div>') : ''}</div>` : ''}
      ${u.menuItems === 0 ? raw('<div class="alert info" style="margin-top:1rem">Your menu is empty. <a href="#menu">Add your first dishes</a>.</div>') : ''}
      ${isOwner() ? html`<div class="card"><h2>Online payments</h2>${paymentAccountBlock(ctx.paymentAccount)}</div>
        <div class="card"><h2>Plan usage</h2><p class="muted small" style="margin-top:0">${sub0.plan.name} plan · ${cap(sub0.status)}${sub0.nextBillingDate ? ` · next billing ${fmtDay(sub0.nextBillingDate)}` : ''} · <a href="#subscription">Manage subscription</a></p>${usageMeter('Menu items', u.menuItems, lim.menuItems)}${usageMeter('Staff accounts', u.staff, lim.staff)}${usageMeter('Branches', u.branches, lim.branches)}${usageMeter('Orders this month', u.ordersPerMonth, lim.ordersPerMonth)}</div>` : ''}`);
  },

  async orders(panel) {
    let filter = sessionStorage.getItem('dash.orderFilter') || 'active';
    async function draw() {
      const q = filter === 'all' ? '' : `?status=${filter}`;
      const { orders } = await api(`/manage/orders${q}`);
      const list = filter === 'active' ? orders.reverse() : orders; // oldest open order first
      const tabs = ['active', 'pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled', 'rejected', 'all'];
      render(panel, html`<div class="toolbar"><h2>Orders</h2><span class="muted small">Refreshes every 20 seconds</span></div>
        <div class="actions-row" role="group" aria-label="Filter by status" style="margin-bottom:1rem">${tabs.map((t) => html`<button class="btn sm ${t === filter ? '' : 'secondary'}" data-filter="${t}">${cap(t)}</button>`)}</div>
        ${list.length ? html`<div class="grid">${list.map(orderCard)}</div>` : emptyState('No orders here', filter === 'active' ? 'New orders will appear automatically.' : 'Nothing matches this filter.')}`);
    }
    panel.onclick = async (e) => {
      const f = e.target.closest('[data-filter]');
      const s = e.target.closest('[data-status]');
      try {
        if (f) { filter = f.dataset.filter; sessionStorage.setItem('dash.orderFilter', filter); await draw(); }
        if (s) {
          let reason;
          if (s.dataset.status === 'rejected' || s.dataset.status === 'cancelled') {
            reason = await promptDialog(s.dataset.status === 'rejected' ? 'Why are you declining this order?' : 'Why are you cancelling this order?', { confirmLabel: 'Confirm', placeholder: 'e.g. Out of stock' });
            if (!reason) return;
            if (s.dataset.paid === '1' && !await confirmDialog('This order was paid online. The customer will be refunded in full automatically.', { confirmLabel: 'Refund and continue', danger: true })) return;
          }
          s.disabled = true;
          await api(`/manage/orders/${s.dataset.id}/status`, { method: 'PATCH', body: { status: s.dataset.status, reason } });
          toast(`Order ${cap(s.dataset.status)}`, 'ok');
          await draw();
        }
      } catch (err) { toast(err, 'err'); draw(); }
    };
    await draw();
    refreshTimer = setInterval(() => { if (location.hash === '#orders' && !document.hidden) draw().catch(() => {}); }, 20000);
  },

  async menu(panel) {
    const [{ categories }, { products }] = await Promise.all([api('/manage/categories'), api('/manage/products')]);
    const catName = new Map(categories.map((c) => [c.id, c.name]));
    const lim = ctx.subscription.plan.limits.menuItems;
    render(panel, html`
      <div class="toolbar"><h2>Menu</h2>${isOwner() ? raw('<div class="actions-row"><button class="btn secondary" data-act="add-cat">Add category</button><button class="btn" data-act="add-prod">Add dish</button></div>') : ''}</div>
      ${isOwner() ? html`<div class="card" style="margin-bottom:1rem">${usageMeter('Menu items used', products.length, lim)}</div>` : ''}
      ${isOwner() && categories.length ? html`<div class="card" style="margin-bottom:1rem"><h3>Categories</h3><div class="actions-row">${categories.map((c) => html`<span class="badge">${c.name} (${c.itemCount}) <button class="link small" data-act="rename-cat" data-id="${c.id}" data-name="${c.name}" aria-label="Rename ${c.name}">✎</button> <button class="link small" data-act="del-cat" data-id="${c.id}" aria-label="Delete ${c.name}" style="color:var(--err)">✕</button></span>`)}</div></div>` : ''}
      ${products.length ? html`<div class="table-wrap"><table><thead><tr><th>Dish</th><th>Category</th><th class="num">Price</th><th>Available</th>${isOwner() ? raw('<th></th>') : ''}</tr></thead><tbody>
        ${products.map((p) => html`<tr><td><div style="display:flex;gap:.6rem;align-items:center">${p.imageUrl ? html`<img src="${p.imageUrl}" alt="" width="40" height="40" style="border-radius:8px;object-fit:cover">` : ''}<div><strong>${p.name}</strong>${p.description ? html`<div class="muted small">${p.description.slice(0, 80)}</div>` : ''}</div></div></td>
          <td>${catName.get(p.categoryId) || '—'}</td><td class="num">${m(p.priceCents)}</td>
          <td><label class="check"><input type="checkbox" data-avail="${p.id}" ${p.isAvailable ? raw('checked') : ''}><span class="sr-only">${p.name} available</span>${p.isAvailable ? 'Yes' : 'Sold out'}</label></td>
          ${isOwner() ? html`<td class="right"><button class="btn secondary sm" data-act="options" data-id="${p.id}">Options</button> <button class="btn secondary sm" data-act="edit-prod" data-id="${p.id}">Edit</button> <button class="btn danger sm" data-act="del-prod" data-id="${p.id}">Delete</button></td>` : ''}</tr>`)}</tbody></table></div>`
        : emptyState('No dishes yet', isOwner() ? 'Click “Add dish” to create your first menu item.' : 'The owner has not added dishes yet.')}`);

    panel.onchange = async (e) => {
      const a = e.target.closest('[data-avail]');
      if (!a) return;
      try { await api(`/manage/products/${a.dataset.avail}/availability`, { method: 'PATCH', body: { isAvailable: a.checked } }); toast('Availability updated', 'ok'); route(); }
      catch (err) { toast(err, 'err'); a.checked = !a.checked; }
    };
    panel.onclick = async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      try {
        const id = b.dataset.id;
        const act = b.dataset.act;
        if (act === 'add-cat') {
          const name = await promptDialog('Category name', { confirmLabel: 'Add' });
          if (name) { await api('/manage/categories', { method: 'POST', body: { name } }); toast('Category added', 'ok'); route(); }
        } else if (act === 'rename-cat') {
          const name = await promptDialog('New category name', { confirmLabel: 'Rename' });
          if (name) { await api(`/manage/categories/${id}`, { method: 'PUT', body: { name } }); route(); }
        } else if (act === 'del-cat') {
          if (await confirmDialog('Delete this category? Its dishes are kept but become uncategorised.', { confirmLabel: 'Delete', danger: true })) { await api(`/manage/categories/${id}`, { method: 'DELETE' }); route(); }
        } else if (act === 'del-prod') {
          if (await confirmDialog('Delete this dish? Past orders keep its name and price.', { confirmLabel: 'Delete', danger: true })) { await api(`/manage/products/${id}`, { method: 'DELETE' }); toast('Dish deleted', 'ok'); route(); }
        } else if (act === 'add-prod') productDialog(null, categories);
        else if (act === 'edit-prod') productDialog(products.find((p) => String(p.id) === id), categories);
        else if (act === 'options') optionsEditor(products.find((p) => String(p.id) === id));
      } catch (err) { toast(err, 'err'); }
    };
  },

  async earnings(panel) {
    const [e, { payouts }, { entries }, { payments }, acct, { finance: f }, settle] = await Promise.all([
      api('/manage/earnings'), api('/manage/payouts'), api('/manage/earnings/ledger?limit=100'), api('/manage/payments'), api('/manage/payment-account'), api('/manage/finance'), api('/manage/settlements'),
    ]);
    const tap = f.settlementModel === 'TAP_SETTLEMENT';
    const SETTLE = { AWAITING_ACCOUNT_VERIFICATION: ['warn', 'Waiting for payout-account verification'], AWAITING_TAP_SETTLEMENT: ['warn', 'Waiting for Tap to settle'], PROCESSING: ['warn', 'Processing at Tap'], PAID_BY_TAP: ['ok', 'Paid by Tap'], FAILED: ['err', 'Failed at Tap'], UNKNOWN: ['warn', 'Unknown status reported by Tap'] };
    const [stTone, stLabel] = SETTLE[f.settlementState] || ['warn', f.settlementState];
    render(panel, html`<div class="toolbar"><h2>Finance &amp; ${tap ? 'settlement' : 'payouts'}</h2></div>
      <h3 style="margin-bottom:.25rem">Earnings</h3>
      <div class="grid cols-4">
        <div class="card stat"><div class="label">Earnings (gross sales)</div><div class="value">${m(f.totalSalesCents)}</div><div class="muted small">customer payments for your orders</div></div>
        <div class="card stat"><div class="label">Platform commission</div><div class="value">${m(f.platformFeesCents)}</div><div class="muted small">kept by the platform</div></div>
        <div class="card stat"><div class="label">Refunds</div><div class="value">${m(f.refundsCents)}</div></div>
        <div class="card stat"><div class="label">Net earnings</div><div class="value">${m(f.netEarningsCents)}</div><div class="muted small">after commission and refunds</div></div>
        <div class="card stat"><div class="label">Pending</div><div class="value">${m(f.pendingBalanceCents)}</div><div class="muted small">waiting for delivery</div></div>
        <div class="card stat"><div class="label">Available</div><div class="value">${m(f.availableForPayoutCents)}</div><div class="muted small">delivered; next weekly statement ${fmtDay(f.nextPayoutDate)}</div></div>
        <div class="card stat"><div class="label">${tap ? 'Tap settlement' : 'Payout status'}</div><div class="value" style="font-size:1rem"><span class="badge ${stTone}">${stLabel}</span></div><div class="muted small">${tap ? 'what Tap reports, not our estimate' : 'platform payouts'}</div></div>
        <div class="card stat"><div class="label">Recorded as paid out</div><div class="value">${m(f.paidOutCents)}</div><div class="muted small">${f.paidOutByProviderCents ? `${m(f.paidOutByProviderCents)} confirmed by provider` : 'confirmed only'}${f.paidOutManuallyRecordedCents ? ` · ${m(f.paidOutManuallyRecordedCents)} recorded manually by the platform` : ''}</div></div>
      </div>
      ${tap ? html`<div class="alert info small" style="margin-top:1rem"><strong>How you get paid:</strong> when a customer pays online, Tap allocates your share to your Tap account at once. <strong>Tap</strong> then settles that balance to your bank account on its own schedule (after Tap has verified your business). This page shows <em>earnings</em> calculated by the platform; the <em>Tap settlements</em> table below shows what Tap itself reports.</div>` : ''}
      ${f.payoutBlockedReason ? html`<div class="alert warn" style="margin-top:1rem">${f.payoutBlockedReason}.</div>` : ''}
      <div class="grid cols-2" style="margin-top:1rem">
        <div class="card"><h3>How your money is calculated</h3>
          <table><tbody>
            <tr><td>Online sales (gross)</td><td class="num">${m(e.onlineGrossCents)}</td></tr>
            <tr><td>Platform commission</td><td class="num">−${m(e.commissionCents)}</td></tr>
            ${e.platformFeeCents ? html`<tr><td>Platform service fee</td><td class="num">−${m(e.platformFeeCents)}</td></tr>` : ''}
            ${e.paymentFeeCents ? html`<tr><td>Payment fees</td><td class="num">−${m(e.paymentFeeCents)}</td></tr>` : ''}
            <tr><td><strong>Your online earnings</strong></td><td class="num"><strong>${m(e.onlineNetCents)}</strong></td></tr></tbody></table>
          <p class="muted small">Earnings become payable once an order is delivered. Refunds reverse the commission in proportion.</p></div>
        <div class="card"><h3>Cash orders</h3>
          <p>${e.cashOrders} cash order${e.cashOrders === 1 ? '' : 's'} delivered · ${m(e.cashCollectedCents)} collected by you.</p>
          <p>Commission owed to the platform on cash orders: <strong>${m(e.codCommissionDueCents)}</strong></p>
          <p class="muted small">You keep the cash you collect. The platform's commission on those orders is settled with you separately.</p></div>
      </div>
      <div class="card" style="margin-top:1rem"><h3>Payments &amp; payout account</h3>${paymentAccountBlock(acct.paymentAccount, true)}</div>
      <h3 style="margin-top:1.5rem">${tap ? 'Weekly earnings statements' : 'Weekly payouts'}</h3>
      ${payouts.length ? html`<div class="table-wrap"><table><thead><tr><th>Period</th><th class="num">Amount</th><th>Status</th><th>Reference</th><th>Destination</th><th>Paid</th></tr></thead><tbody>
        ${payouts.map((p) => html`<tr><td>${p.periodStart} → ${p.periodEnd}</td><td class="num">${m(p.amountCents)}</td><td><span class="badge ${p.status === 'paid' ? 'ok' : ['failed', 'reversed'].includes(p.status) ? 'err' : 'warn'}">${p.status.replace('_', ' ')}</span>${p.confirmedBy ? html`<div class="muted small">${p.confirmedBy}</div>` : ''}${p.failureReason ? html`<div class="muted small">${p.failureReason}</div>` : ''}</td><td>${p.reference || '—'}</td><td>${p.destination || '—'}</td><td>${p.paidAt ? fmtDay(p.paidAt) : '—'}</td></tr>`)}</tbody></table></div>`
        : emptyState('No payouts yet', 'A statement is created every Monday for the previous week once you have delivered online orders.')}
      <p class="muted small">A statement is shown as <strong>paid</strong> only when the payment provider confirmed it, or when the platform recorded a bank transfer it made itself (labelled “recorded manually”). ${tap ? 'Statements are the platform\'s record of what you earned; they are not Tap payouts.' : ''}</p>
      ${tap ? html`<h3 style="margin-top:1.5rem">Settlements reported by Tap</h3>
        ${settle.settlements.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Tap payout ID</th><th class="num">Amount (as reported)</th><th>Status</th></tr></thead><tbody>
          ${settle.settlements.map((x) => html`<tr><td>${x.date ? fmtDay(x.date) : '—'}</td><td><code>${x.id}</code></td><td class="num">${x.amount} ${x.currency || ''}</td><td><span class="badge ${x.status === 'paid' ? 'ok' : x.status === 'failed' ? 'err' : 'warn'}">${x.status === 'paid' ? 'Paid' : x.status === 'failed' ? 'Failed' : x.status === 'processing' ? 'Processing' : 'Unknown'}</span><div class="muted small">${x.statusRaw}</div></td></tr>`)}</tbody></table></div>`
          : emptyState('No Tap settlements recorded yet', 'Once Tap pays your bank account, the settlement appears here after the platform syncs with Tap.')}` : ''}
      <h3 style="margin-top:1.5rem">Payments</h3>
      ${payments.length ? html`<div class="table-wrap"><table><thead><tr><th>Order</th><th>Method</th><th>Status</th><th class="num">Amount</th><th class="num">Refunded</th><th>Date</th></tr></thead><tbody>
        ${payments.slice(0, 50).map((p) => html`<tr><td>#${p.orderNumber}</td><td>${p.method === 'card' ? `Card${p.source ? ` (${p.source})` : ''}` : 'Cash on delivery'}</td><td><span class="badge ${p.status === 'succeeded' || p.status === 'cash_collected' ? 'ok' : p.status === 'failed' ? 'err' : 'warn'}">${cap(p.status)}</span></td><td class="num">${m(p.amountCents)}</td><td class="num">${p.refundedCents ? m(p.refundedCents) : '—'}</td><td>${fmtDay(p.createdAt)}</td></tr>`)}</tbody></table></div>` : emptyState('No payments yet')}
      <h3 style="margin-top:1.5rem">Ledger</h3>
      ${entries.length ? html`<div class="table-wrap"><table><thead><tr><th>Order</th><th>Type</th><th class="num">Gross</th><th class="num">Commission</th><th class="num">Fees</th><th class="num">Your amount</th><th>Payout</th></tr></thead><tbody>
        ${entries.map((l) => html`<tr><td>#${l.orderNumber}</td><td>${l.type === 'cod_commission' ? 'Cash commission' : cap(l.type)}</td><td class="num">${m(l.grossCents)}</td><td class="num">${m(l.commissionCents)}</td><td class="num">${m(l.platformFeeCents + l.paymentFeeCents)}</td><td class="num">${m(l.restaurantAmountCents)}</td><td>${l.payoutId ? `#${l.payoutId} (${l.payoutStatus.replace('_', ' ')})` : l.eligibleAt ? 'Next payout' : 'After delivery'}</td></tr>`)}</tbody></table></div>` : emptyState('No ledger entries yet')}`);
    panel.onclick = (e) => { if (e.target.closest('[data-apply-payout]')) payoutApplicationDialog(acct.paymentAccount.application); };
  },

  async customers(panel) {
    const { customers } = await api('/manage/customers');
    render(panel, html`<div class="toolbar"><h2>Customers</h2><span class="muted small">People who have ordered from your restaurant</span></div>
      ${customers.length ? html`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th class="num">Orders</th><th class="num">Spent</th><th>Last order</th></tr></thead><tbody>
        ${customers.map((c) => html`<tr><td>${c.name}</td><td>${c.email}</td><td>${c.phone || '—'}</td><td class="num">${c.orderCount}</td><td class="num">${m(c.totalSpentCents)}</td><td>${fmtDay(c.lastOrderAt)}</td></tr>`)}</tbody></table></div>`
        : emptyState('No customers yet', 'Customers appear here after their first order.')}`);
  },

  async reports(panel) {
    const days = Number(sessionStorage.getItem('dash.days')) || 30;
    let s;
    try { s = await api(`/manage/reports/summary?days=${days}`); }
    catch (e) { if (e.code === 'feature_not_in_plan') return render(panel, lockedPanel('Sales analytics', 'Sales analytics are not included in your plan. Contact support to upgrade.')); throw e; }
    let adv = null;
    try { adv = await api(`/manage/reports/advanced?days=${days}`); } catch (e) { if (e.code !== 'feature_not_in_plan') throw e; }
    const max = Math.max(1, ...s.daily.map((d) => d.revenueCents));
    render(panel, html`<div class="toolbar"><h2>Sales reports</h2>
      <div class="actions-row"><label class="sr-only" for="days">Period</label><select id="days" style="width:auto">${[7, 30, 90].map((d) => html`<option value="${d}" ${d === days ? raw('selected') : ''}>Last ${d} days</option>`)}</select>
      ${adv ? raw('<button class="btn secondary" data-csv>Export CSV</button>') : ''}</div></div>
      <div class="grid cols-4">
        <div class="card stat"><div class="label">Order value</div><div class="value">${m(s.revenueCents)}</div></div>
        <div class="card stat"><div class="label">Orders</div><div class="value">${s.orders}</div></div>
        <div class="card stat"><div class="label">Avg. order</div><div class="value">${m(s.avgOrderCents)}</div></div>
        <div class="card stat"><div class="label">Cancelled / declined</div><div class="value">${s.cancelled}</div></div></div>
      <div class="card" style="margin-top:1rem"><h3>Daily order value</h3>
        ${s.daily.length ? html`<div class="bars" role="img" aria-label="Daily order value bar chart">${s.daily.map((d) => html`<div class="bar" style="height:${Math.round((d.revenueCents / max) * 100)}%" title="${d.day}: ${m(d.revenueCents)} (${d.orders} orders)"></div>`)}</div>
          <div class="muted small" style="display:flex;justify-content:space-between"><span>${s.daily[0].day}</span><span>${s.daily[s.daily.length - 1].day}</span></div>` : emptyState('No orders in this period')}</div>
      ${adv ? html`<div class="grid cols-2" style="margin-top:1rem">
        <div class="card"><h3>Top dishes</h3>${adv.topProducts.length ? html`<table><tbody>${adv.topProducts.map((p) => html`<tr><td>${p.name}</td><td class="num">${p.quantity} sold</td><td class="num">${m(p.revenueCents)}</td></tr>`)}</tbody></table>` : emptyState('No sales yet')}</div>
        <div class="card"><h3>Customers & order types</h3>
          <p>Returning customers: <strong>${adv.repeatCustomers.returning}</strong> of ${adv.repeatCustomers.total}</p>
          ${adv.byOrderType.map((t) => html`<p style="margin:0">${cap(t.type)}: <strong>${t.orders}</strong> orders · ${m(t.revenueCents)}</p>`)}
          <h3 style="margin-top:1rem">Orders by hour (UTC)</h3>
          ${adv.ordersByHourUtc.length ? html`<div class="bars" role="img" aria-label="Orders by hour">${adv.ordersByHourUtc.map((h) => html`<div class="bar" style="height:${Math.round((h.orders / Math.max(...adv.ordersByHourUtc.map((x) => x.orders))) * 100)}%" title="${h.hour}:00 — ${h.orders} orders"></div>`)}</div>` : emptyState('No data')}</div>
      </div>` : html`<div class="locked" style="margin-top:1rem"><strong>Advanced reports</strong><p class="muted">Top dishes, peak hours, repeat customers and CSV export are not included in your plan. Contact support to upgrade.</p></div>`}`);
    $('#days')?.addEventListener('change', (e) => { sessionStorage.setItem('dash.days', e.target.value); route(); });
    panel.onclick = async (e) => {
      if (!e.target.closest('[data-csv]')) return;
      try {
        const res = await api('/manage/reports/orders.csv');
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement('a'); a.href = url; a.download = 'orders.csv'; a.click(); URL.revokeObjectURL(url);
      } catch (err) { toast(err, 'err'); }
    };
  },

  async team(panel) {
    const [{ staff }, { branches }] = await Promise.all([api('/manage/staff'), api('/manage/branches')]);
    const lim = ctx.subscription.plan.limits;
    render(panel, html`<div class="toolbar"><h2>Staff</h2></div>
      <div class="card">${usageMeter('Staff accounts', staff.length, lim.staff)}
        ${staff.length ? html`<div class="table-wrap" style="margin:1rem 0"><table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th></th></tr></thead><tbody>
          ${staff.map((s) => html`<tr><td>${s.name}</td><td>${s.email}</td><td><span class="badge ${s.isActive ? 'active' : 'cancelled'}">${s.isActive ? 'active' : 'disabled'}</span></td>
          <td class="right"><button class="btn secondary sm" data-toggle="${s.id}" data-active="${s.isActive}">${s.isActive ? 'Disable' : 'Enable'}</button> <button class="btn danger sm" data-del-staff="${s.id}">Remove</button></td></tr>`)}</tbody></table></div>` : html`<p class="muted">No staff yet. Staff can manage orders and mark dishes sold out, but cannot change prices, settings or see earnings.</p>`}
        <h3>Add staff member</h3>
        <form id="staff-form" novalidate><div class="form-alert"></div><div class="row">
          <div class="field"><label for="s-name">Name</label><input id="s-name" name="name" required></div>
          <div class="field"><label for="s-email">Email</label><input id="s-email" name="email" type="email" required></div>
          <div class="field"><label for="s-pw">Temporary password</label><input id="s-pw" name="password" type="password" autocomplete="new-password" required></div></div>
          <button class="btn" type="submit">Add staff</button></form></div>
      <div class="toolbar" style="margin-top:2rem"><h2>Branches</h2></div>
      <div class="card">${usageMeter('Branches', branches.length, lim.branches)}
        ${branches.length ? html`<ul>${branches.map((b) => html`<li>${b.name}${b.address ? ` — ${b.address}` : ''} <button class="link small" data-del-branch="${b.id}" style="color:var(--err)">Remove</button></li>`)}</ul>` : html`<p class="muted">No branches added.</p>`}
        <form id="branch-form" novalidate><div class="form-alert"></div><div class="row">
          <div class="field"><label for="b-name">Branch name</label><input id="b-name" name="name" required></div>
          <div class="field"><label for="b-addr">Address</label><input id="b-addr" name="address"></div></div>
          <button class="btn" type="submit">Add branch</button></form></div>`);
    onSubmit($('#staff-form'), async (d) => { await api('/manage/staff', { method: 'POST', body: d }); toast('Staff member added', 'ok'); reload(); });
    onSubmit($('#branch-form'), async (d) => { await api('/manage/branches', { method: 'POST', body: d }); toast('Branch added', 'ok'); reload(); });
    panel.onclick = async (e) => {
      const t = e.target.closest('[data-toggle],[data-del-staff],[data-del-branch]');
      if (!t) return;
      try {
        if (t.dataset.toggle) await api(`/manage/staff/${t.dataset.toggle}`, { method: 'PATCH', body: { isActive: t.dataset.active !== 'true' } });
        else if (t.dataset.delStaff) { if (!await confirmDialog('Remove this staff account?', { confirmLabel: 'Remove', danger: true })) return; await api(`/manage/staff/${t.dataset.delStaff}`, { method: 'DELETE' }); }
        else if (t.dataset.delBranch) { if (!await confirmDialog('Remove this branch?', { confirmLabel: 'Remove', danger: true })) return; await api(`/manage/branches/${t.dataset.delBranch}`, { method: 'DELETE' }); }
        reload();
      } catch (err) { toast(err, 'err'); }
    };
  },

  async subscription(panel) {
    // returning from the provider's checkout page: ask the server to verify any open invoice with the provider
    const first = await api('/manage/subscription');
    const open = first.invoices.find((i) => i.status === 'open' && i.reference);
    if (open && sessionStorage.getItem('dash.invoicePaying') === String(open.id)) {
      await api(`/manage/invoices/${open.id}/refresh`, { method: 'POST' }).catch(() => {});
      sessionStorage.removeItem('dash.invoicePaying');
    }
    const { subscription: sub, plans, invoices, cardPaymentsAvailable } = (open ? await api('/manage/subscription') : first);
    ctx.subscription = sub;
    const lim = sub.plan.limits;
    const inv = sub.openInvoice;
    const priceLabel = (p) => (p.priceCents ? `${m(p.priceCents)} / ${p.billingInterval}` : 'Free');
    const rank = (p) => p.priceCents;
    render(panel, html`<div class="toolbar"><h2>Subscription</h2></div>
      ${['expired', 'cancelled'].includes(sub.status) ? html`<div class="alert err" role="alert"><strong>Your subscription is ${sub.status}.</strong> Customers cannot order from you until you ${inv ? 'pay the open invoice below' : 'choose a plan'}.</div>` : ''}
      ${sub.status === 'past_due' ? html`<div class="alert warn" role="alert"><strong>Payment is due.</strong> Pay the open invoice before ${fmtDay(sub.endDate)} + grace period to avoid losing access.</div>` : ''}
      ${sub.status === 'trialing' ? html`<div class="alert info">Free trial of the <strong>${sub.plan.name}</strong> plan ends on <strong>${fmtDay(sub.trialEnd)}</strong>. You will be invoiced then.</div>` : ''}
      <div class="grid cols-2">
        <div class="card"><h3 style="margin:0">Current plan: ${sub.plan.name}</h3>
          <p style="margin:.25rem 0"><span class="badge ${['active', 'trialing'].includes(sub.status) ? 'ok' : ['past_due'].includes(sub.status) ? 'warn' : 'err'}">${cap(sub.status)}</span> ${sub.cancelledAt ? html`<span class="badge warn">ends ${fmtDay(sub.endDate)} (not renewing)</span>` : ''}</p>
          <p class="muted">${priceLabel({ priceCents: sub.priceCents, billingInterval: sub.billingInterval })}${sub.nextBillingDate ? ` · next billing date ${fmtDay(sub.nextBillingDate)}` : sub.priceCents ? '' : ' · no billing'}</p>
          ${sub.autoRenewal?.available ? html`<p class="small">Automatic renewal: ${sub.autoRenewal.savedCard ? html`<span class="badge ok">On</span> ${sub.autoRenewal.savedCard.brand || 'Card'} ${sub.autoRenewal.savedCard.last4 ? '•••• ' + sub.autoRenewal.savedCard.last4 : ''} <button class="btn secondary sm" data-remove-card>Turn off</button>` : html`<span class="badge warn">Off</span> invoices are paid manually`}</p>` : html`<p class="muted small">Renewals are invoices you pay manually.</p>`}
          ${sub.priceCents && !sub.cancelledAt && ['active', 'trialing'].includes(sub.status) ? raw('<button class="btn danger sm" data-cancel>Cancel at end of period</button>') : ''}</div>
        <div class="card"><h3 style="margin:0 0 .5rem">Plan usage</h3>
          ${usageMeter('Menu items', sub.usage.menuItems, lim.menuItems)}${usageMeter('Staff accounts', sub.usage.staff, lim.staff)}${usageMeter('Branches', sub.usage.branches, lim.branches)}${usageMeter('Orders this month', sub.usage.ordersPerMonth, lim.ordersPerMonth)}</div></div>
      ${inv ? html`<div class="card" style="margin-top:1rem;border-color:var(--brand)"><h3 style="margin-top:0">Invoice #${inv.id} — ${m(inv.amountCents)} due</h3>
        <p class="muted">${fmtDay(inv.periodStart)} → ${fmtDay(inv.periodEnd)}</p>
        ${sub.autoRenewal?.available && !sub.autoRenewal.savedCard ? html`<div class="check"><input type="checkbox" id="save-card"><label for="save-card">Save this card for automatic renewal (the provider stores it; this platform never sees card numbers)</label></div>
          <div class="field" style="max-width:260px"><label for="save-phone">Mobile number (required by the provider to save a card)</label><input id="save-phone" inputmode="tel" placeholder="+9665…"></div>` : ''}
        ${cardPaymentsAvailable ? html`<button class="btn" data-pay="${inv.id}">Pay now</button>` : html`<div class="alert warn" style="margin:0">Online payment is not enabled on this platform yet. Contact support and quote invoice #${inv.id}; the platform team will activate your plan once payment is received.</div>`}</div>` : ''}
      <h3 style="margin-top:1.5rem">Plans</h3>
      <div class="grid cols-4">${plans.map((p) => {
    const current = p.code === sub.plan.code && !['expired', 'cancelled'].includes(sub.status);
    const label = current ? 'Current plan' : p.trialDays && !sub.trialEnd && p.priceCents ? `Start ${p.trialDays}-day trial` : rank(p) > sub.priceCents ? `Upgrade to ${p.name}` : p.priceCents ? `Switch to ${p.name}` : `Downgrade to ${p.name}`;
    return html`<article class="card plan ${current ? 'current' : ''}"><h3>${p.name}</h3><div class="price">${p.priceCents ? m(p.priceCents) : 'Free'}<span class="muted small">${p.priceCents ? ` / ${p.billingInterval}` : ''}</span></div>
          <p class="muted small">${p.description}</p>
          <ul>${(p.highlights.length ? p.highlights : [`${p.limits.menuItems ?? 'Unlimited'} products`, `${p.limits.staff ?? 'Unlimited'} staff`]).map((h) => html`<li>${h}</li>`)}</ul>
          ${current ? raw('<button class="btn secondary block" disabled>Current plan</button>') : html`<button class="btn ${rank(p) > sub.priceCents ? '' : 'secondary'} block" data-plan="${p.code}">${label}</button>`}</article>`;
  })}</div>
      <h3 style="margin-top:1.5rem">Billing history</h3>
      ${invoices.length ? html`<div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Period</th><th class="num">Amount</th><th>Status</th><th>Paid</th></tr></thead><tbody>
        ${invoices.map((i) => html`<tr><td>#${i.id}</td><td>${fmtDay(i.periodStart)} → ${fmtDay(i.periodEnd)}</td><td class="num">${m(i.amountCents)}</td><td><span class="badge ${i.status === 'paid' ? 'ok' : i.status === 'open' ? 'warn' : ''}">${i.status}</span></td><td>${i.paidAt ? fmtDay(i.paidAt) : '—'}</td></tr>`)}</tbody></table></div>` : emptyState('No invoices yet', 'Invoices appear here when a paid plan is chosen or renewed.')}
      <p class="muted small" style="margin-top:1rem">Subscriptions are what your restaurant pays the platform for the software. They are separate from the money customers pay you for orders (see Earnings &amp; payouts).</p>`);
    panel.onclick = async (e) => {
      try {
        const pl = e.target.closest('[data-plan]');
        if (pl) {
          pl.disabled = true;
          const r = await api('/manage/subscription/change', { method: 'POST', body: { planCode: pl.dataset.plan } });
          if (r.paymentUrl) { sessionStorage.setItem('dash.invoicePaying', String(r.invoice.id)); location.href = r.paymentUrl; return; }
          toast(r.applied ? (r.trial ? 'Trial started' : 'Plan changed') : 'Invoice created — see the payment box above', 'ok');
          return reload();
        }
        if (e.target.closest('[data-remove-card]') && await confirmDialog('Stop automatic renewal? You will pay renewal invoices manually.', { confirmLabel: 'Turn off' })) { await api('/manage/subscription/payment-method', { method: 'DELETE' }); toast('Automatic renewal turned off', 'ok'); return reload(); }
        const pay = e.target.closest('[data-pay]');
        if (pay) { const saveCard = !!document.getElementById('save-card')?.checked;
          const r = await api(`/manage/invoices/${pay.dataset.pay}/pay`, { method: 'POST', body: saveCard ? { saveCard: true, phone: document.getElementById('save-phone')?.value } : {} }); sessionStorage.setItem('dash.invoicePaying', pay.dataset.pay); location.href = r.paymentUrl; }
        if (e.target.closest('[data-cancel]') && await confirmDialog('Cancel your subscription? You keep access until the end of the period you have paid for; it will not renew.', { confirmLabel: 'Cancel subscription', danger: true })) {
          await api('/manage/subscription/cancel', { method: 'POST' }); toast('Subscription will end at the end of the period', 'ok'); reload();
        }
      } catch (err) { toast(err, 'err'); route(); }
    };
  },

  async settings(panel) {
    const r = ctx.restaurant;
    const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
    const hours = r.openingHours || {};
    render(panel, html`<div class="toolbar"><h2>Profile &amp; settings</h2></div>
      <form class="card" id="settings" novalidate><div class="form-alert"></div>
        <div style="display:flex;gap:1rem;align-items:center;margin-bottom:1rem;flex-wrap:wrap"><img src="${r.logoUrl || '/Images/Restaurants/download.png'}" alt="Current logo" width="72" height="72" style="border-radius:12px;object-fit:cover">
          <div class="field" style="margin:0"><label for="logo">Logo</label><input id="logo" type="file" accept="image/png,image/jpeg,image/webp"></div>
          <div class="field" style="margin:0"><label for="cover">Cover image</label><input id="cover" type="file" accept="image/png,image/jpeg,image/webp"></div></div>
        <div class="field"><label for="name">Name</label><input id="name" name="name" value="${r.name}" required maxlength="100"></div>
        <div class="field"><label for="description">Description</label><textarea id="description" name="description" maxlength="1000">${r.description}</textarea></div>
        <div class="row"><div class="field"><label for="phone">Phone</label><input id="phone" name="phone" value="${r.phone || ''}"></div>
          <div class="field"><label for="whatsapp">WhatsApp</label><input id="whatsapp" name="whatsapp" value="${r.whatsapp || ''}" placeholder="+9665…"></div>
          <div class="field"><label for="email">Contact email</label><input id="email" name="email" type="email" value="${r.email || ''}"></div></div>
        <div class="row"><div class="field"><label for="address">Address</label><input id="address" name="address" value="${r.address || ''}"></div>
          <div class="field"><label for="city">City</label><input id="city" name="city" value="${r.city || ''}"></div></div>
        <div class="row">
          <div class="field"><label for="deliveryFee">Delivery fee (${r.currency})</label><input id="deliveryFee" name="deliveryFee" inputmode="decimal" value="${fromCents(r.deliveryFeeCents)}"></div>
          <div class="field"><label for="minOrder">Minimum order (${r.currency})</label><input id="minOrder" name="minOrder" inputmode="decimal" value="${fromCents(r.minOrderCents)}"></div>
          <div class="field"><label for="tax">Tax rate (%)</label><input id="tax" name="tax" inputmode="decimal" value="${(r.taxRateBp / 100).toString()}"></div></div>
        <fieldset class="field" style="border:1px solid var(--border);border-radius:10px;padding:.75rem"><legend style="font-weight:700">Opening hours</legend>
          <p class="muted small" style="margin-top:0">Leave a day empty to mean closed. Leave every day empty to accept orders at any time. Time zone:
            <input id="timezone" name="timezone" value="${r.timezone}" style="width:12rem;display:inline-block" aria-label="Time zone"></p>
          <div class="hours-grid">${DAYS.map(([d, label]) => html`<strong>${label}</strong>
            <input type="time" name="open-${d}" value="${hours[d]?.[0]?.open || ''}" aria-label="${label} opens"><input type="time" name="close-${d}" value="${hours[d]?.[0]?.close || ''}" aria-label="${label} closes">`)}</div></fieldset>
        <div class="field check"><input type="checkbox" id="acceptingOrders" name="acceptingOrders" ${r.acceptingOrders ? raw('checked') : ''}><label for="acceptingOrders">Accepting orders</label></div>
        <button class="btn" type="submit">Save changes</button></form>`);
    const upload = async (file) => (await api('/manage/uploads', { method: 'POST', raw: true, body: file, headers: { 'Content-Type': file.type } })).url;
    onSubmit($('#settings'), async (d) => {
      const openingHours = {};
      for (const [k] of DAYS) if (d[`open-${k}`] && d[`close-${k}`]) openingHours[k] = [{ open: d[`open-${k}`], close: d[`close-${k}`] }];
      const body = {
        name: d.name, description: d.description, phone: d.phone || null, whatsapp: d.whatsapp || null, email: d.email || null,
        address: d.address || null, city: d.city || null, acceptingOrders: d.acceptingOrders, timezone: d.timezone,
        openingHours: Object.keys(openingHours).length ? openingHours : null,
        deliveryFeeCents: toCents(d.deliveryFee || 0), minOrderCents: toCents(d.minOrder || 0),
        taxRateBp: Math.round(parseFloat(String(d.tax || 0).replace(',', '.')) * 100),
      };
      if ([body.deliveryFeeCents, body.minOrderCents, body.taxRateBp].some(Number.isNaN)) throw new Error('Fees and tax must be numbers');
      if ($('#logo').files[0]) body.logoUrl = await upload($('#logo').files[0]);
      if ($('#cover').files[0]) body.coverUrl = await upload($('#cover').files[0]);
      await api('/manage/restaurant', { method: 'PUT', body });
      toast('Settings saved', 'ok');
      reload();
    });
  },
};

// ---------------- helpers ----------------
const ACCOUNT_BADGE = { VERIFIED: ['ok', '✓ Verified — ready to receive payouts'], UNDER_REVIEW: ['warn', '⏳ Under review by the payment provider'], PENDING: ['warn', '⏳ Application received — the platform is completing provider onboarding'], NOT_STARTED: ['warn', '⚠ Not connected'], REJECTED: ['err', '✗ Rejected'], SUSPENDED: ['err', 'Suspended'], DISABLED: ['err', 'Disabled'] };
function paymentAccountBlock(a, withApply = false) {
  if (!a.providerEnabled) return html`<p class="muted">Online payments are not enabled on this platform yet, so customers pay cash on delivery. Payout accounts can be connected once the platform enables its payment provider.</p>`;
  const [tone, label] = ACCOUNT_BADGE[a.displayStatus] || ['warn', a.displayStatus];
  const canApply = withApply && ['NOT_STARTED', 'REJECTED', 'PENDING'].includes(a.displayStatus);
  return html`<table><tbody>
    <tr><td>Payout account status</td><td><span class="badge ${tone}">${label}</span></td></tr>
    <tr><td>Provider</td><td>${cap(a.provider)} (${a.environment})</td></tr>
    <tr><td>KYC / KYB</td><td>${cap(a.kycStatus)}</td></tr>
    <tr><td>Settlement currency</td><td>${a.settlementCurrency || '—'}</td></tr>
    <tr><td>Payout schedule</td><td>Weekly (every Monday)</td></tr>
    <tr><td>Bank account</td><td>${a.maskedBank || '—'}</td></tr>
    <tr><td>Last verified</td><td>${a.lastVerifiedAt ? fmtDay(a.lastVerifiedAt) : '—'}</td></tr>
    <tr><td>Online payments for customers</td><td><span class="badge ${a.onlinePaymentsEnabled ? 'ok' : 'warn'}">${a.onlinePaymentsEnabled ? 'Enabled' : 'Not enabled'}</span></td></tr></tbody></table>
    ${a.rejectionReason ? html`<div class="alert error small">Reason: ${a.rejectionReason}</div>` : ''}
    ${a.onlinePaymentsEnabled ? '' : html`<p class="muted small">Customers can still pay cash on delivery. To receive online payments, your business must be verified by the payment provider (KYC/KYB). Bank details are collected by the provider, never by this platform.</p>`}
    ${canApply ? html`<button class="btn" data-apply-payout>${a.displayStatus === 'PENDING' ? 'Update application' : 'Set up payout account'}</button>` : ''}`;
}

function payoutApplicationDialog(acctApp) {
  const dlg = document.createElement('dialog');
  dlg.setAttribute('aria-labelledby', 'pa-title');
  dlg.innerHTML = html`<h2 id="pa-title">Set up payout account</h2>
    <p class="muted small">Tell us who your business is. The platform submits you to the payment provider for verification (KYC/KYB); the provider will contact you for documents and your bank account. Do <strong>not</strong> enter bank, card or password details here.</p>
    <form id="pa-apply" novalidate><div class="form-alert"></div>
      <div class="field"><label for="pa-ln">Legal business name</label><input id="pa-ln" name="legalName" required maxlength="150" value="${acctApp?.legalName || ''}"></div>
      <div class="field"><label for="pa-cr">Commercial registration number</label><input id="pa-cr" name="registrationNumber" required maxlength="40" value="${acctApp?.registrationNumber || ''}"></div>
      <div class="row"><div class="field"><label for="pa-cn">Contact person</label><input id="pa-cn" name="contactName" required maxlength="100" value="${acctApp?.contactName || ''}"></div>
        <div class="field"><label for="pa-cp">Contact phone</label><input id="pa-cp" name="contactPhone" required inputmode="tel" value="${acctApp?.contactPhone || ''}"></div></div>
      <div class="field"><label for="pa-ce">Contact email</label><input id="pa-ce" name="contactEmail" type="email" required maxlength="150" value="${acctApp?.contactEmail || ''}"></div>
      <div class="actions-row"><button class="btn" type="submit">Submit application</button><button class="btn secondary" type="button" data-close>Cancel</button></div></form>`.s;
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dlg.close(); });
  wireDialog(dlg);
  onSubmit($('#pa-apply', dlg), async (d) => {
    await api('/manage/payment-account/apply', { method: 'POST', body: d });
    toast('Application submitted. The platform will complete provider onboarding and your status will update here.', 'ok');
    dlg.close();
    route();
  }, { alertBox: $('#pa-apply .form-alert', dlg) });
}

function usageMeter(label, used, limit) {
  const pct = limit === null ? 0 : Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  return html`<div style="margin-bottom:.75rem"><div style="display:flex;justify-content:space-between" class="small"><span>${label}</span><span class="muted">${used} / ${limit === null ? 'unlimited' : limit}</span></div>
    <div class="meter ${limit !== null && used >= limit ? 'full' : ''}" role="progressbar" aria-label="${label}" aria-valuenow="${used}" aria-valuemin="0" aria-valuemax="${limit ?? used}"><div style="width:${limit === null ? 8 : pct}%"></div></div></div>`;
}

function lockedPanel(title, text) {
  return html`<div class="locked"><h2>${title}</h2><p class="muted">${text}</p></div>`;
}

const NEXT = {
  pending: [['confirmed', 'Accept']],
  confirmed: [['preparing', 'Start preparing']],
  preparing: [['ready', 'Mark ready']],
};
function orderCard(o) {
  let next = NEXT[o.status] || [];
  if (o.status === 'ready') next = [o.orderType === 'pickup' ? ['delivered', 'Handed to customer'] : ['out_for_delivery', 'Out for delivery']];
  if (o.status === 'out_for_delivery') next = [['delivered', 'Delivered']];
  const canClose = ['pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery'].includes(o.status);
  const paid = o.paymentMethod === 'card';
  return html`<article class="card order-card">
    <header><div><strong>#${o.orderNumber}</strong> <span class="muted small">${fmtDate(o.createdAt)}</span></div><span class="badge ${o.status}">${cap(o.status)}</span></header>
    <div><strong>${o.customerName}</strong> · <a href="tel:${o.customerPhone}">${o.customerPhone}</a> · ${o.orderType === 'delivery' ? 'Delivery' : 'Pickup'}</div>
    ${o.deliveryAddress ? html`<div class="muted small">📍 ${o.deliveryAddress}</div>` : ''}
    <ul style="margin:0;padding-left:1.1rem">${o.items.map((i) => html`<li>${i.quantity} × ${i.name}${i.options.length ? html` <span class="muted small">(${i.options.map((x) => x.name).join(', ')})</span>` : ''}</li>`)}</ul>
    ${o.notes ? html`<div class="alert info small" style="margin:0">Note: ${o.notes}</div>` : ''}
    <div class="actions-row"><strong style="margin-right:auto">${m(o.totalCents)}
      ${paid ? html`<span class="badge ${['refunded', 'partially_refunded'].includes(o.paymentStatus) ? 'warn' : 'ok'}">${o.paymentStatus === 'paid' ? 'Paid online' : cap(o.paymentStatus)}</span>`
    : o.paymentStatus === 'cash_collected' ? raw('<span class="badge ok">Cash collected</span>')
      : o.paymentStatus === 'cancelled' ? raw('<span class="badge">No payment</span>') : html`<span class="badge warn">Collect cash: ${m(o.totalCents)}</span>`}</strong>
      ${next.map(([s, label]) => raw(`<button class="btn sm" data-id="${o.id}" data-status="${s}">${label}</button>`))}
      ${canClose ? raw(`<button class="btn danger sm" data-id="${o.id}" data-status="${o.status === 'pending' ? 'rejected' : 'cancelled'}" data-paid="${paid ? 1 : 0}">${o.status === 'pending' ? 'Decline' : 'Cancel'}</button>`) : ''}</div>
  </article>`;
}

// ---- product dialog ----
function productDialog(p, categories) {
  const dlg = document.createElement('dialog');
  dlg.setAttribute('aria-labelledby', 'pd-title');
  dlg.innerHTML = html`<h2 id="pd-title">${p ? 'Edit dish' : 'Add dish'}</h2>
    <form id="pd" novalidate><div class="form-alert"></div>
      <div class="field"><label for="pd-name">Name</label><input id="pd-name" name="name" required maxlength="120" value="${p?.name || ''}"></div>
      <div class="field"><label for="pd-desc">Description</label><textarea id="pd-desc" name="description" maxlength="1000">${p?.description || ''}</textarea></div>
      <div class="row"><div class="field"><label for="pd-price">Price (${ctx.restaurant.currency})</label><input id="pd-price" name="price" inputmode="decimal" required value="${p ? fromCents(p.priceCents) : ''}"></div>
        <div class="field"><label for="pd-cat">Category</label><select id="pd-cat" name="categoryId"><option value="">— none —</option>${categories.map((c) => html`<option value="${c.id}" ${p?.categoryId === c.id ? raw('selected') : ''}>${c.name}</option>`)}</select></div></div>
      <div class="field"><label for="pd-img">Image</label><input id="pd-img" type="file" accept="image/png,image/jpeg,image/webp">
        ${p?.imageUrl ? html`<div class="hint">Current image is kept unless you choose a new file.</div>` : ''}</div>
      <div class="field check"><input type="checkbox" id="pd-av" name="isAvailable" ${!p || p.isAvailable ? raw('checked') : ''}><label for="pd-av">Available</label></div>
      <div class="actions-row"><button class="btn" type="submit">Save</button><button class="btn secondary" type="button" data-close>Cancel</button></div></form>`.s;
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dlg.close(); });
  wireDialog(dlg);
  onSubmit($('#pd', dlg), async (d) => {
    const price = toCents(d.price);
    if (Number.isNaN(price)) throw Object.assign(new Error('price: enter a valid amount, e.g. 9.50'), { details: { field: 'price' } });
    const body = { name: d.name, description: d.description, priceCents: price, categoryId: d.categoryId ? Number(d.categoryId) : null, isAvailable: d.isAvailable };
    const file = $('#pd-img', dlg).files[0];
    if (file) body.imageUrl = (await api('/manage/uploads', { method: 'POST', raw: true, body: file, headers: { 'Content-Type': file.type } })).url;
    await api(p ? `/manage/products/${p.id}` : '/manage/products', { method: p ? 'PUT' : 'POST', body });
    dlg.close();
    toast(p ? 'Dish updated' : 'Dish added', 'ok');
    reload();
  }, { alertBox: $('.form-alert', dlg) });
}

// ---- options / add-ons editor ----
async function optionsEditor(product) {
  const dlg = document.createElement('dialog');
  dlg.setAttribute('aria-labelledby', 'oe-title');
  dlg.style.width = 'min(640px, calc(100vw - 32px))';
  document.body.append(dlg);
  wireDialog(dlg);

  async function draw(editing = null) {
    const { groups } = await api(`/manage/products/${product.id}/option-groups`);
    const g = editing === 'new' ? { name: '', minSelect: 0, maxSelect: 1, options: [] } : groups.find((x) => x.id === editing);
    dlg.innerHTML = html`<h2 id="oe-title">Options for ${product.name}</h2>
      <p class="muted small">Add-ons customers can choose, such as size or extras. Each group has a minimum and maximum number of choices.</p>
      ${groups.length ? html`<ul style="padding-left:1.1rem">${groups.map((x) => html`<li><strong>${x.name}</strong> <span class="muted small">(${x.minSelect}–${x.maxSelect})</span>: ${x.options.map((o) => `${o.name}${o.priceCents ? ` +${m(o.priceCents)}` : ''}`).join(', ')}
        <button class="btn secondary sm" data-edit="${x.id}">Edit</button> <button class="btn danger sm" data-del="${x.id}">Delete</button></li>`)}</ul>` : html`<p class="muted">No option groups yet.</p>`}
      ${g ? html`<form id="og" novalidate><div class="form-alert"></div><h3>${editing === 'new' ? 'New option group' : 'Edit group'}</h3>
        <div class="field"><label for="og-name">Group name</label><input id="og-name" name="name" value="${g.name}" required maxlength="80" placeholder="e.g. Size"></div>
        <div class="row"><div class="field"><label for="og-min">Minimum choices</label><input id="og-min" name="minSelect" type="number" min="0" max="30" value="${g.minSelect}"></div>
          <div class="field"><label for="og-max">Maximum choices</label><input id="og-max" name="maxSelect" type="number" min="1" max="30" value="${g.maxSelect}"></div></div>
        <div class="field"><label for="og-opts">Options (one per line: name | extra price)</label><textarea id="og-opts" name="options" rows="5" placeholder="Large | 3.00&#10;Regular | 0">${g.options.map((o) => `${o.name} | ${fromCents(o.priceCents)}`).join('\n')}</textarea></div>
        <div class="actions-row"><button class="btn" type="submit">Save group</button><button class="btn secondary" type="button" data-cancel>Cancel</button></div></form>`
    : raw('<div class="actions-row"><button class="btn" data-new>Add option group</button></div>')}
      <div class="actions-row" style="margin-top:1rem"><button class="btn secondary" data-close>Close</button></div>`.s;
    const form = $('#og', dlg);
    if (form) {
      onSubmit(form, async (d) => {
        const options = d.options.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
          const [name, price = '0'] = l.split('|').map((s) => s.trim());
          const priceCents = toCents(price || '0');
          if (!name || Number.isNaN(priceCents)) throw Object.assign(new Error(`options: "${l}" is not in the form name | price`), { details: { field: 'options' } });
          return { name, priceCents };
        });
        const body = { name: d.name, minSelect: Number(d.minSelect), maxSelect: Number(d.maxSelect), options };
        await api(editing === 'new' ? `/manage/products/${product.id}/option-groups` : `/manage/option-groups/${editing}`, { method: editing === 'new' ? 'POST' : 'PUT', body });
        toast('Options saved', 'ok');
        draw();
      }, { alertBox: $('.form-alert', dlg) });
    }
  }
  dlg.addEventListener('click', async (e) => {
    try {
      if (e.target.closest('[data-close]')) dlg.close();
      else if (e.target.closest('[data-new]')) draw('new');
      else if (e.target.closest('[data-cancel]')) draw();
      else if (e.target.closest('[data-edit]')) draw(Number(e.target.closest('[data-edit]').dataset.edit));
      else if (e.target.closest('[data-del]')) {
        if (await confirmDialog('Delete this option group?', { confirmLabel: 'Delete', danger: true })) {
          await api(`/manage/option-groups/${e.target.closest('[data-del]').dataset.del}`, { method: 'DELETE' });
          draw();
        }
      }
    } catch (err) { toast(err, 'err'); }
  });
  dlg.showModal();
  draw();
}

boot();
