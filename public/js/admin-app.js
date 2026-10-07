import {
  api, session, requireRoles, mountChrome, publicConfig, $, render, html, raw, money, fmtDate, fmtDay, cap, toCents, fromCents,
  spinner, emptyState, errorBox, toast, onSubmit, confirmDialog, promptDialog, wireDialog,
} from './common.js';

mountChrome({ active: 'admin' });
const user = requireRoles('super_admin'); // convenience only: every /admin page and /api/admin call is authorised by the backend

const NAV = [
  ['dashboard', 'Dashboard'], ['restaurants', 'Restaurants'], ['users', 'Users'], ['customers', 'Customers'], ['orders', 'Orders'],
  ['payments', 'Payments'], ['refunds', 'Refunds'], ['payouts', 'Payouts'], ['subscriptions', 'Subscriptions'], ['plans', 'Plans'],
  ['reconciliation', 'Reconciliation'], ['reports', 'Reports'], ['support', 'Support'], ['settings', 'Settings'], ['audit', 'Audit Logs'], ['system', 'System Health'],
];
let currency = 'USD';
let me = null;
const m = (c) => money(c, currency);
const state = {}; // remembered filters/pages per section

const sectionFromPath = () => {
  const s = location.pathname.replace(/^\/admin\/?/, '').split('/')[0] || 'dashboard';
  return [...NAV.map(([k]) => k), 'security'].includes(s) ? s : 'dashboard';
};

async function boot() {
  if (!user) return;
  currency = (await publicConfig()).currency || 'USD';
  try { me = (await api('/admin/me')); } catch (e) { return render($('#root'), errorBox(e)); }
  window.addEventListener('popstate', route);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-nav]');
    if (a) { e.preventDefault(); history.pushState(null, '', a.getAttribute('href')); route(); }
  });
  route();
}

async function route() {
  const id = me.mfaEnrollmentRequired ? 'security' : sectionFromPath();
  const sidebar = html`<nav class="side admin-side" aria-label="Admin sections">${NAV.map(([k, label]) => html`<a data-nav href="/admin/${k}" ${k === id ? raw('aria-current="page"') : ''}>${label}</a>`)}
    <hr style="border:0;border-top:1px solid var(--border);width:100%"><a data-nav href="/admin/security" ${id === 'security' ? raw('aria-current="page"') : ''}>Security (2FA)</a></nav>`;
  render($('#root'), html`<div class="toolbar"><h1>${id === 'security' ? 'Security' : NAV.find(([k]) => k === id)[1]}</h1><span class="muted small">${me.user.email}</span></div>
    ${me.mfaEnrollmentRequired ? html`<div class="alert warn" role="alert"><strong>Two-factor authentication is required.</strong> Enable it below to unlock the admin panel.</div>` : ''}
    <div class="dash">${sidebar}<section id="panel" aria-live="polite"></section></div>`);
  document.title = `${id === 'security' ? 'Security' : NAV.find(([k]) => k === id)[1]} | Admin | Foodies`;
  const panel = $('#panel');
  panel.onclick = null;
  render(panel, spinner());
  try { await views[id](panel); } catch (e) {
    if (e.code === 'mfa_enrollment_required') { me.mfaEnrollmentRequired = true; return route(); }
    render(panel, errorBox(e));
  }
}

// ---------- small helpers ----------
const pager = (total, p, size = 25) => html`<div class="pager"><span class="muted small">${total} result${total === 1 ? '' : 's'}</span>
  <button class="btn secondary sm" data-page="${p - 1}" ${p <= 1 ? raw('disabled') : ''}>Previous</button><span>Page ${p}</span>
  <button class="btn secondary sm" data-page="${p + 1}" ${p * size >= total ? raw('disabled') : ''}>Next</button></div>`;
const select = (name, label, options, value) => html`<div class="field"><label for="f-${name}">${label}</label><select id="f-${name}" name="${name}">${options.map(([v, l]) => html`<option value="${v}" ${String(v) === String(value || '') ? raw('selected') : ''}>${l}</option>`)}</select></div>`;
const qs = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '' && v !== null) p.set(k, v); const s = p.toString(); return s ? `?${s}` : ''; };
const badge = (status, label) => html`<span class="badge ${status}">${label || cap(status)}</span>`;
const statusTone = (s) => (['active', 'succeeded', 'paid', 'cash_collected', 'approved', 'delivered'].includes(s) ? 'ok' : ['failed', 'cancelled', 'rejected', 'suspended', 'expired', 'void'].includes(s) ? 'err' : 'warn');

// Filter form + table + pager; re-runs on submit / paging. `onAction` receives row-action clicks.
function listView(panel, key, { filtersHtml, load, table, onAction }) {
  const st = state[key] ||= { page: 1, f: {} };
  async function draw() {
    const data = await load({ ...st.f, page: st.page });
    render(panel, html`<form class="filters" id="filters">${filtersHtml(st.f)}<button class="btn sm" type="submit">Filter</button></form>
      <div id="results">${table(data)}</div>${data.total !== undefined ? pager(data.total, st.page) : ''}`);
    $('#filters').addEventListener('submit', (e) => { e.preventDefault(); st.f = Object.fromEntries(new FormData(e.target)); st.page = 1; draw(); });
  }
  panel.onclick = async (e) => {
    const pg = e.target.closest('[data-page]');
    if (pg) { st.page = Number(pg.dataset.page); return draw(); }
    try { await onAction?.(e, draw); } catch (err) { toast(err, 'err'); }
  };
  return draw();
}

function dialog(title, body, { wide = false, onClose } = {}) {
  const dlg = document.createElement('dialog');
  dlg.setAttribute('aria-label', title);
  if (wide) dlg.style.width = 'min(760px, calc(100vw - 32px))';
  dlg.innerHTML = html`<h2>${title}</h2>${body}<div class="actions-row" style="margin-top:1rem"><button class="btn secondary" data-close>Close</button></div>`.s;
  document.body.append(dlg);
  wireDialog(dlg, onClose);
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dlg.close(); });
  dlg.showModal();
  return dlg;
}

// Bar chart from real series data (no external library).
function barChart(title, points, key, { format = (v) => v, note = '' } = {}) {
  const max = Math.max(1, ...points.map((p) => Number(p[key] || 0)));
  const total = points.reduce((s, p) => s + Number(p[key] || 0), 0);
  return html`<div class="card"><h3 style="margin-bottom:.25rem">${title}</h3><div class="muted small">${note}${note ? ' · ' : ''}Total ${format(total)}</div>
    <div class="bars" role="img" aria-label="${title}: total ${format(total)} over ${points.length} days">${points.map((p) => html`<div class="bar" style="height:${Math.max(2, Math.round((Number(p[key] || 0) / max) * 100))}%" title="${p.day}: ${format(Number(p[key] || 0))}"></div>`)}</div>
    <div class="muted small" style="display:flex;justify-content:space-between"><span>${points[0]?.day}</span><span>${points[points.length - 1]?.day}</span></div></div>`;
}

const stat = (label, value, sub = '') => html`<div class="card stat"><div class="label">${label}</div><div class="value">${value}</div>${sub ? html`<div class="muted small">${sub}</div>` : ''}</div>`;

// ---------- sections ----------
const views = {
  async dashboard(panel) {
    const days = Number(state.dashDays) || 30;
    const { stats: s, series, currency: cur } = await api(`/admin/dashboard?days=${days}`);
    currency = cur;
    render(panel, html`<div class="toolbar" style="margin-bottom:.5rem"><span class="muted small">All figures are computed live from the database.</span>
      <select id="days" aria-label="Chart period" style="width:auto">${[7, 30, 90, 180].map((d) => html`<option value="${d}" ${d === days ? raw('selected') : ''}>Last ${d} days</option>`)}</select></div>
      <div class="grid cols-4">
        ${stat('Total restaurants', s.totalRestaurants, `${s.activeRestaurants} active`)}
        ${stat('Pending approval', s.pendingRestaurants, raw('<a data-nav href="/admin/restaurants">Review</a>'))}
        ${stat('Suspended', s.suspendedRestaurants)}
        ${stat('Customers', s.totalCustomers)}
        ${stat('Total orders', s.totalOrders)}
        ${stat("Today's orders", s.todaysOrders)}
        ${stat('Orders this month', s.monthlyOrders)}
        ${stat('Gross order value', m(s.grossRevenueCents), 'what customers paid restaurants')}
        ${stat('Platform commission', m(s.platformCommissionCents), 'commission + service fees on orders')}
        ${stat('Restaurant earnings', m(s.restaurantEarningsCents), "restaurants' share of online sales")}
        ${stat('Subscription revenue', m(s.subscriptionRevenueCents), 'SaaS plans paid by restaurants (separate ledger)')}
        ${stat('Open support reports', s.openReports)}
        ${stat('Pending payouts', m(s.pendingPayoutsCents), `${s.pendingPayouts} statement(s)`)}
        ${stat('Completed payouts', m(s.completedPayoutsCents), `${s.completedPayouts} statement(s)`)}
      </div>
      <div class="grid cols-2" style="margin-top:1rem">
        ${barChart('Revenue over time', series.orders, 'revenueCents', { format: m, note: 'order value' })}
        ${barChart('Orders over time', series.orders, 'orders')}
        ${barChart('Platform commission', series.orders, 'commissionCents', { format: m })}
        ${barChart('Payouts completed', series.payouts, 'amountCents', { format: m })}
        ${barChart('Restaurant growth', series.restaurants, 'added', { note: 'new restaurants per day' })}
        ${barChart('Customer growth', series.customers, 'added', { note: 'new customers per day' })}
      </div>
      <div class="card" style="margin-top:1rem"><h3>Subscriptions</h3><p>${Object.entries(s.subscriptionsByStatus).map(([k, v]) => `${cap(k)}: ${v}`).join(' · ') || 'No subscriptions yet'}</p></div>`);
    $('#days').addEventListener('change', (e) => { state.dashDays = e.target.value; route(); });
  },

  restaurants: (panel) => listView(panel, 'restaurants', {
    filtersHtml: (f) => html`<div class="field"><label for="f-q">Search</label><input id="f-q" name="q" value="${f.q || ''}" placeholder="Name, city or slug"></div>
      ${select('approval', 'Approval', [['', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']], f.approval)}`,
    load: (f) => api(`/admin/restaurants${qs(f)}`),
    table: ({ restaurants }) => (restaurants.length ? html`<div class="table-wrap"><table><thead><tr><th>Restaurant</th><th>Owner</th><th>Approval</th><th>Plan</th><th class="num">Orders</th><th>Created</th><th></th></tr></thead><tbody>
      ${restaurants.map((r) => html`<tr><td><strong>${r.name}</strong> ${r.isDemo ? raw('<span class="badge demo">Sample</span>') : ''}<div class="muted small">${r.slug}${r.city ? ` · ${r.city}` : ''}</div></td>
        <td>${r.ownerEmail || '—'}</td>
        <td>${badge(r.approvalStatus === 'approved' ? 'active' : r.approvalStatus === 'rejected' ? 'cancelled' : 'pending', cap(r.approvalStatus))} ${r.isActive ? '' : raw('<span class="badge suspended">Suspended</span>')}${r.rejectionReason ? html`<div class="muted small">${r.rejectionReason}</div>` : ''}</td>
        <td>${r.planName || '—'} ${r.subscriptionStatus ? badge(r.subscriptionStatus) : ''}${r.commissionBpOverride !== null ? html`<div class="muted small">commission ${(r.commissionBpOverride / 100)}%</div>` : ''}</td>
        <td class="num">${r.orders}</td><td>${fmtDay(r.createdAt)}</td>
        <td class="right"><button class="btn secondary sm" data-detail="${r.id}">View</button>
          ${r.approvalStatus !== 'approved' ? raw(`<button class="btn sm" data-approve="${r.id}">Approve</button>`) : ''}
          ${r.approvalStatus === 'pending' ? raw(`<button class="btn danger sm" data-reject="${r.id}">Reject</button>`) : ''}
          ${r.approvalStatus === 'approved' ? (r.isActive ? raw(`<button class="btn danger sm" data-suspend="${r.id}">Suspend</button>`) : raw(`<button class="btn sm" data-reactivate="${r.id}">Activate</button>`)) : ''}</td></tr>`)}</tbody></table></div>` : emptyState('No restaurants match')),
    onAction: async (e, draw) => {
      const id = (k) => e.target.closest(`[data-${k}]`)?.dataset[k];
      if (id('approve')) { await api(`/admin/restaurants/${id('approve')}/approve`, { method: 'POST', body: {} }); toast('Restaurant approved', 'ok'); draw(); }
      if (id('reject')) { const reason = await promptDialog('Reason for rejecting (shown to the owner)', { confirmLabel: 'Reject' }); if (reason) { await api(`/admin/restaurants/${id('reject')}/reject`, { method: 'POST', body: { reason } }); toast('Restaurant rejected', 'ok'); draw(); } }
      if (id('suspend')) { const reason = await promptDialog('Reason for suspending', { confirmLabel: 'Suspend' }); if (reason) { await api(`/admin/restaurants/${id('suspend')}/suspend`, { method: 'POST', body: { reason } }); toast('Restaurant suspended', 'ok'); draw(); } }
      if (id('reactivate')) { await api(`/admin/restaurants/${id('reactivate')}/reactivate`, { method: 'POST', body: {} }); toast('Restaurant activated', 'ok'); draw(); }
      if (id('detail')) restaurantDetail(Number(id('detail')), draw);
    },
  }),

  users: (panel) => listView(panel, 'users', {
    filtersHtml: (f) => html`<div class="field"><label for="f-q">Search</label><input id="f-q" name="q" value="${f.q || ''}" placeholder="Name or email"></div>
      ${select('role', 'Role', [['', 'All'], ['customer', 'Customers'], ['owner', 'Restaurant owners'], ['staff', 'Staff'], ['super_admin', 'Admins']], f.role)}
      ${select('status', 'Status', [['', 'All'], ['active', 'Active'], ['disabled', 'Disabled']], f.status)}`,
    load: (f) => api(`/admin/users${qs(f)}`),
    table: ({ users }) => (users.length ? html`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th class="num">Orders</th><th>Status</th><th>Joined</th><th></th></tr></thead><tbody>
      ${users.map((u) => html`<tr><td>${u.name}</td><td>${u.email}</td><td>${cap(u.role)}</td><td class="num">${u.orders}</td><td>${badge(u.status === 'active' ? 'active' : 'cancelled', u.status)}</td><td>${fmtDay(u.createdAt)}</td>
        <td class="right"><button class="btn ${u.status === 'active' ? 'danger' : ''} sm" data-user-toggle="${u.id}" data-active="${u.status === 'active'}" data-name="${u.name}">${u.status === 'active' ? 'Disable' : 'Enable'}</button></td></tr>`)}</tbody></table></div>` : emptyState('No users match')),
    onAction: async (e, draw) => {
      const t = e.target.closest('[data-user-toggle]');
      if (!t) return;
      const active = t.dataset.active === 'true';
      if (active && !await confirmDialog(`Disable ${t.dataset.name}? They will be signed out immediately.`, { confirmLabel: 'Disable', danger: true })) return;
      await api(`/admin/users/${t.dataset.userToggle}`, { method: 'PATCH', body: { isActive: !active } }); toast(active ? 'User disabled' : 'User enabled', 'ok'); draw();
    },
  }),

  customers: (panel) => listView(panel, 'customers', {
    filtersHtml: (f) => html`<div class="field"><label for="f-q">Search</label><input id="f-q" name="q" value="${f.q || ''}" placeholder="Name or email"></div>`,
    load: (f) => api(`/admin/customers${qs(f)}`),
    table: ({ customers }) => (customers.length ? html`<div class="table-wrap"><table><thead><tr><th>Customer</th><th>Email</th><th class="num">Orders</th><th class="num">Spent</th><th class="num">Restaurants</th><th>Status</th><th>Joined</th><th></th></tr></thead><tbody>
      ${customers.map((c) => html`<tr><td>${c.name}</td><td>${c.email}</td><td class="num">${c.orders}</td><td class="num">${m(c.spentCents)}</td><td class="num">${c.restaurants}</td><td>${badge(c.status === 'active' ? 'active' : 'cancelled', c.status)}</td><td>${fmtDay(c.createdAt)}</td>
        <td class="right"><button class="btn secondary sm" data-user-orders="${c.id}">Orders</button></td></tr>`)}</tbody></table></div>` : emptyState('No customers yet', 'Customers appear when people register and order.')),
    onAction: async (e) => {
      const o = e.target.closest('[data-user-orders]');
      if (!o) return;
      const { orders } = await api(`/admin/users/${o.dataset.userOrders}/orders`);
      dialog('Customer orders', orders.length ? html`<div class="table-wrap"><table><tbody>${orders.map((x) => html`<tr><td>#${x.orderNumber} ${x.restaurantName}</td><td>${cap(x.status)}</td><td class="num">${m(x.totalCents)}</td></tr>`)}</tbody></table></div>` : html`<p>No orders.</p>`);
    },
  }),

  orders: (panel) => listView(panel, 'orders', {
    filtersHtml: (f) => html`<div class="field"><label for="f-q">Search</label><input id="f-q" name="q" value="${f.q || ''}" placeholder="Order #, customer, phone, restaurant"></div>
      ${select('status', 'Status', [['', 'All'], ...['awaiting_payment', 'pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled', 'rejected'].map((s) => [s, cap(s)])], f.status)}
      <div class="field"><label for="f-restaurantId">Restaurant ID</label><input id="f-restaurantId" name="restaurantId" inputmode="numeric" value="${f.restaurantId || ''}"></div>
      <div class="field"><label for="f-from">From</label><input id="f-from" name="from" type="date" value="${f.from || ''}"></div>
      <div class="field"><label for="f-to">To</label><input id="f-to" name="to" type="date" value="${f.to || ''}"></div>`,
    load: (f) => api(`/admin/orders${qs(f)}`),
    table: ({ orders }) => (orders.length ? html`<div class="table-wrap"><table><thead><tr><th>Order</th><th>Restaurant</th><th>Customer</th><th>Payment</th><th class="num">Total</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>
      ${orders.map((o) => html`<tr><td>#${o.orderNumber}</td><td>${o.restaurantName}</td><td>${o.customerName}</td>
        <td>${o.paymentMethod === 'cod' ? raw('<span class="badge warn">Cash on delivery</span>') : raw('<span class="badge info">Card</span>')} <div class="muted small">${cap(o.paymentStatus)}</div></td>
        <td class="num">${m(o.totalCents)}</td><td>${badge(o.status === 'delivered' ? 'completed' : o.status)}</td><td>${fmtDate(o.createdAt)}</td>
        <td class="right"><button class="btn secondary sm" data-order="${o.id}">Details</button>${['delivered', 'cancelled', 'rejected', 'awaiting_payment'].includes(o.status) ? '' : raw(` <button class="btn danger sm" data-order-cancel="${o.id}">Cancel</button>`)}</td></tr>`)}</tbody></table></div>` : emptyState('No orders match')),
    onAction: async (e, draw) => {
      const d = e.target.closest('[data-order]');
      if (d) await orderDetail(Number(d.dataset.order));
      const c = e.target.closest('[data-order-cancel]');
      if (c) {
        const reason = await promptDialog('Reason for cancelling this order', { confirmLabel: 'Cancel order' });
        if (reason) { await api(`/admin/orders/${c.dataset.orderCancel}/cancel`, { method: 'POST', body: { reason } }); toast('Order cancelled (card payments are refunded automatically)', 'ok'); draw(); }
      }
    },
  }),

  payments: (panel) => listView(panel, 'payments', {
    filtersHtml: (f) => html`<div class="field"><label for="f-q">Search</label><input id="f-q" name="q" value="${f.q || ''}" placeholder="Provider ref, order #, restaurant"></div>
      ${select('method', 'Method', [['', 'All'], ['card', 'Card'], ['cod', 'Cash on delivery']], f.method)}
      ${select('status', 'Status', [['', 'All'], ...['pending', 'succeeded', 'failed', 'cancelled', 'cod_pending', 'cash_collected', 'refunded', 'partially_refunded'].map((s) => [s, cap(s)])], f.status)}
      <div class="field"><label for="f-from">From</label><input id="f-from" name="from" type="date" value="${f.from || ''}"></div>
      <div class="field"><label for="f-to">To</label><input id="f-to" name="to" type="date" value="${f.to || ''}"></div>`,
    load: (f) => api(`/admin/payments${qs(f)}`),
    table: ({ payments }) => (payments.length ? html`<div class="alert info small">These are <strong>customer order payments</strong>. Cash on delivery rows are not online payments: the restaurant collects the cash and owes the platform its commission. Restaurant subscription payments are under Subscriptions.</div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Order</th><th>Restaurant</th><th>Method</th><th>Status</th><th class="num">Amount</th><th class="num">Refunded</th><th>Provider ref</th><th></th></tr></thead><tbody>
      ${payments.map((p) => html`<tr><td>${p.id}</td><td>#${p.orderNumber}</td><td>${p.restaurant}</td>
        <td>${p.method === 'cod' ? raw('<span class="badge warn">Cash</span>') : html`Card${p.source ? ` (${p.source})` : ''}`}</td>
        <td><span class="badge ${statusTone(p.status)}">${cap(p.status)}</span>${p.failureReason ? html`<div class="muted small">${p.failureReason}</div>` : ''}</td>
        <td class="num">${m(p.amountCents)}</td><td class="num">${p.refundedCents ? m(p.refundedCents) : '—'}</td><td class="small">${p.providerRef || '—'}</td>
        <td class="right">${p.method === 'card' && ['succeeded', 'partially_refunded'].includes(p.status) ? raw(`<button class="btn danger sm" data-refund="${p.id}" data-left="${p.amountCents - p.refundedCents}">Refund</button>`) : ''}${p.method === 'card' && ['pending', 'initiated', 'failed'].includes(p.status) ? raw(` <button class="btn secondary sm" data-reconcile="${p.id}">Re-check</button>`) : ''}</td></tr>`)}</tbody></table></div>` : emptyState('No payments match')),
    onAction: async (e, draw) => {
      const rf = e.target.closest('[data-refund]');
      if (rf) {
        const left = Number(rf.dataset.left);
        const amount = await promptDialog(`Refund amount in ${currency} (up to ${fromCents(left)})`, { confirmLabel: 'Next', placeholder: fromCents(left) });
        if (!amount) return;
        const cents = toCents(amount);
        if (Number.isNaN(cents) || cents < 1 || cents > left) return toast('Enter a valid amount within the refundable balance', 'err');
        const reason = await promptDialog('Reason for the refund', { confirmLabel: 'Refund' });
        if (!reason) return;
        const key = `rf_${crypto.randomUUID().replace(/-/g, '')}`; // one key per confirmed action: a double click cannot refund twice
        const r = await api(`/admin/payments/${rf.dataset.refund}/refund`, { method: 'POST', body: { amountCents: cents, reason }, headers: { 'Idempotency-Key': key } });
        toast(`Refund ${r.refund.status}`, r.refund.status === 'failed' ? 'err' : 'ok'); draw();
      }
      const rc = e.target.closest('[data-reconcile]');
      if (rc) { const r = await api(`/admin/payments/${rc.dataset.reconcile}/reconcile`, { method: 'POST', body: {} }); toast(`Provider says: ${r.status}`); draw(); }
    },
  }),

  async refunds(panel) {
    const st = state.refunds ||= { status: '' };
    const { refunds } = await api(`/admin/refunds${qs({ status: st.status })}`);
    render(panel, html`<form class="filters" id="rf">${select('status', 'Status', [['', 'All'], ['pending', 'Pending'], ['succeeded', 'Succeeded'], ['failed', 'Failed']], st.status)}<button class="btn sm" type="submit">Filter</button></form>
      ${refunds.length ? html`<div class="table-wrap"><table><thead><tr><th>#</th><th>Order</th><th>Restaurant</th><th class="num">Amount</th><th>Status</th><th>Reason</th><th>Provider ref</th><th>Created</th></tr></thead><tbody>
        ${refunds.map((f) => html`<tr><td>${f.id}</td><td>#${f.orderNumber}</td><td>${f.restaurant}</td><td class="num">${m(f.amountCents)}</td><td><span class="badge ${statusTone(f.status === 'succeeded' ? 'succeeded' : f.status)}">${f.status}</span>${f.failureReason ? html`<div class="muted small">${f.failureReason}</div>` : ''}</td><td>${f.reason}</td><td class="small">${f.providerRefundId || '—'}</td><td>${fmtDate(f.createdAt)}</td></tr>`)}</tbody></table></div>` : emptyState('No refunds', 'Refunds are created from the Payments section or automatically when a paid order is cancelled.')}`);
    $('#rf').addEventListener('submit', (e) => { e.preventDefault(); st.status = new FormData(e.target).get('status'); route(); });
  },

  async payouts(panel) {
    const [{ balances }, { payouts, capabilities: caps }, fin] = await Promise.all([api('/admin/balances'), api('/admin/payouts'), api('/admin/finance/restaurants')]);
    const tapModel = fin.settlementModel === 'TAP_SETTLEMENT';
    render(panel, html`<div class="toolbar"><h2>Restaurant balances</h2>
      <div class="actions-row">${tapModel ? raw('<button class="btn secondary" data-sync-settlements>Sync settlements from Tap</button>') : ''}<button class="btn secondary" data-generate>Generate last week's statements</button><a class="btn secondary" href="/api/admin/reports/payouts?format=csv" download>Export payouts CSV</a></div></div>
      <p class="muted small">Weekly statements are created automatically every Monday (UTC). Generating again is safe: a restaurant can only ever have one payout per week.</p>
      ${balances.length ? html`<div class="table-wrap"><table><thead><tr><th>Restaurant</th><th class="num">Available</th><th class="num">Pending delivery</th><th class="num">In payout</th><th class="num">Paid</th><th class="num">Cash commission due</th><th></th></tr></thead><tbody>
        ${balances.map((b) => html`<tr><td>${b.restaurant}</td><td class="num">${m(b.availableCents)}</td><td class="num">${m(b.pendingCents)}</td><td class="num">${m(b.inPayoutCents)}</td><td class="num">${m(b.paidCents)}</td><td class="num">${m(b.codCommissionDueCents)}</td>
          <td class="right">${b.codCommissionDueCents > 0 ? html`<button class="btn secondary sm" data-cod="${b.restaurantId}" data-name="${b.restaurant}">Mark cash commission collected</button>` : ''}</td></tr>`)}</tbody></table></div>` : emptyState('No approved restaurants yet')}
      <h2 style="margin-top:1.5rem">Restaurant finance ${tapModel ? '&amp; Tap settlement' : ''}</h2>
      ${fin.restaurants.length ? html`<div class="table-wrap"><table><thead><tr><th>Restaurant</th><th class="num">Gross sales</th><th class="num">Commission</th><th class="num">Refunds</th><th class="num">Net earnings</th><th>Destination ID</th><th>Settlement</th><th>Currency</th><th>Last Tap payment</th><th>Last Tap settlement</th></tr></thead><tbody>
        ${fin.restaurants.map((r) => html`<tr><td>${r.restaurant}</td><td class="num">${m(r.grossSalesCents)}</td><td class="num">${m(r.commissionCents)}</td><td class="num">${m(r.refundsCents)}</td><td class="num"><strong>${m(r.netEarningsCents)}</strong></td>
          <td class="small">${r.destinationId ? html`<code>${r.destinationId}</code>` : '—'}<div class="muted">${r.accountStatus.replace('_', ' ')}</div></td><td><span class="badge ${r.settlementStatus === 'PAID_BY_TAP' ? 'ok' : r.settlementStatus === 'FAILED' ? 'err' : 'warn'}">${r.settlementStatus.replace(/_/g, ' ')}</span></td>
          <td>${r.settlementCurrency || '—'}</td><td class="small">${r.lastTapPaymentId ? html`<code>${r.lastTapPaymentId}</code>` : '—'}</td><td class="small">${r.lastTapSettlementId ? html`<code>${r.lastTapSettlementId}</code><div class="muted">${r.lastTapSettlementAmount || ''}</div>` : '—'}</td></tr>`)}</tbody></table></div>` : emptyState('No approved restaurants yet')}
      <p class="muted small">${tapModel ? 'Tap pays restaurants itself; the platform has no payout API. “Settlement” is what Tap reported through its Payouts API (press Sync); an earnings statement is never marked paid by a sync.' : ''}</p>
      <h2 style="margin-top:1.5rem">Weekly ${tapModel ? 'earnings statements' : 'payouts'}</h2>
      <div class="alert info small"><strong>Paid</strong> is only shown when the payment provider confirmed the payout, or when a bank transfer made <em>outside</em> the platform was recorded by an admin (labelled “recorded manually”). An admin cannot mark a payout paid directly: use <strong>Manual payout</strong> first. ${caps.createPayout === 'NOT_SUPPORTED' ? 'Tap has no payout API: Tap settles restaurants itself (see Restaurant finance below); use Manual payout only for transfers you make yourself.' : caps.createPayout === 'NOT_VERIFIED' ? 'Provider payouts cannot be requested from here yet (capability NOT VERIFIED).' : 'Provider payouts can be requested below.'}</div>
      ${payouts.length ? html`<div class="table-wrap"><table><thead><tr><th>#</th><th>Restaurant</th><th>Period</th><th class="num">Gross</th><th class="num">Commission</th><th class="num">Refunds</th><th class="num">Net</th><th>Status</th><th>Provider ref / account</th><th></th></tr></thead><tbody>
        ${payouts.map((p) => html`<tr><td>${p.id}</td><td>${p.restaurant}</td><td>${p.periodStart} → ${p.periodEnd}<div class="muted small">${p.currency}${p.settlementCurrency && p.settlementCurrency !== p.currency ? ` → settles ${p.settlementCurrency}` : ''}</div></td>
          <td class="num">${m(p.grossCents)}</td><td class="num">${m(p.commissionCents)}</td><td class="num">${m(p.refundsCents)}</td><td class="num"><strong>${m(p.netCents)}</strong></td>
          <td><span class="badge ${p.status === 'paid' ? 'ok' : ['failed', 'reversed'].includes(p.status) ? 'err' : p.status === 'cancelled' ? '' : 'warn'}">${p.status.replace('_', ' ')}</span>${p.status === 'paid' ? html`<div class="muted small">${p.confirmationSource === 'provider' ? 'confirmed by provider' : 'recorded manually'}</div>` : ''}${p.failureReason ? html`<div class="muted small">${p.failureReason}</div>` : ''}</td>
          <td class="small">${p.reference ? String(p.reference).replace(/^manual:/, 'manual: ') : '—'}<div class="muted">${p.providerAccountId ? 'acct ' + p.providerAccountId : 'no provider account'}</div></td>
          <td class="right">${{
    pending: raw(`<button class="btn secondary sm" data-payout="${p.id}" data-to="manual_payout">Manual payout</button> <button class="btn secondary sm" data-payout="${p.id}" data-to="cancelled">Cancel</button>`),
    eligible: raw(`${/^(IMPLEMENTED|VERIFIED)/.test(caps.createPayout || '') ? `<button class="btn sm" data-request="${p.id}">Request provider payout</button> ` : ''}<button class="btn secondary sm" data-payout="${p.id}" data-to="manual_payout">Manual payout</button> <button class="btn secondary sm" data-payout="${p.id}" data-to="cancelled">Cancel</button>`),
    manual_payout: raw(`<button class="btn sm" data-payout="${p.id}" data-to="paid">Record bank transfer</button> <button class="btn danger sm" data-payout="${p.id}" data-to="failed">Failed</button>`),
    failed: raw(`<button class="btn sm" data-payout="${p.id}" data-to="pending">Retry</button> <button class="btn secondary sm" data-payout="${p.id}" data-to="cancelled">Cancel</button>`) }[p.status] || ''}</td></tr>`)}</tbody></table></div>` : emptyState('No payouts yet')}`);
    panel.onclick = async (e) => {
      try {
        if (e.target.closest('[data-generate]')) {
          const r = await api('/admin/payouts/generate', { method: 'POST', body: {} });
          toast(`${r.created.length} payout(s) created for ${r.period.periodStart} – ${r.period.periodEnd}`, 'ok'); route();
        }
        const cod = e.target.closest('[data-cod]');
        if (cod && await confirmDialog(`Record that the cash-order commission owed by ${cod.dataset.name} has been collected?`, { confirmLabel: 'Record' })) {
          await api(`/admin/restaurants/${cod.dataset.cod}/cod-settlement`, { method: 'POST', body: {} }); toast('Recorded', 'ok'); route();
        }
        if (e.target.closest('[data-sync-settlements]')) {
          const r = (await api('/admin/settlements/sync', { method: 'POST', body: {} })).sync; toast(`Synced ${r.fetched} Tap payout(s), ${r.matched} matched to restaurants`, 'ok'); route();
        }
        const rq = e.target.closest('[data-request]');
        if (rq && await confirmDialog('Ask the payment provider to pay this statement now?', { confirmLabel: 'Request payout' })) {
          await api(`/admin/payouts/${rq.dataset.request}/request`, { method: 'POST', body: {} }); toast('Payout requested; waiting for the provider', 'ok'); route();
        }
        const p = e.target.closest('[data-payout]');
        if (p) {
          const body = { status: p.dataset.to };
          if (p.dataset.to === 'manual_payout' && !await confirmDialog('Mark this statement as a MANUAL payout? You will pay the restaurant yourself and record the bank transfer reference afterwards. This is not a provider payout.', { confirmLabel: 'Manual payout' })) return;
          if (p.dataset.to === 'paid') { body.reference = await promptDialog('Reference of the bank transfer you made outside the platform', { confirmLabel: 'Record as paid (manual)' }); if (!body.reference) return; }
          if (p.dataset.to === 'failed') { body.failureReason = await promptDialog('Why did the payout fail?', { confirmLabel: 'Mark failed' }); if (!body.failureReason) return; }
          await api(`/admin/payouts/${p.dataset.payout}`, { method: 'PATCH', body }); toast(`Payout ${p.dataset.to.replace('_', ' ')}`, 'ok'); route();
        }
      } catch (err) { toast(err, 'err'); }
    };
  },

  async subscriptions(panel) {
    const st = state.subscriptions ||= { page: 1, f: {} };
    const [list, { invoices }] = await Promise.all([api(`/admin/subscriptions${qs({ ...st.f, page: st.page })}`), api('/admin/invoices?status=open')]);
    render(panel, html`<div class="alert info small">Subscriptions are what <strong>restaurants pay the platform</strong>. This is a separate ledger from customer order payments.</div>
      <form class="filters" id="filters"><div class="field"><label for="f-q">Search</label><input id="f-q" name="q" value="${st.f.q || ''}" placeholder="Restaurant name or slug"></div>
        ${select('status', 'Status', [['', 'All'], ...['trialing', 'active', 'past_due', 'cancelled', 'expired', 'suspended'].map((s) => [s, cap(s)])], st.f.status)}<button class="btn sm" type="submit">Filter</button></form>
      ${list.subscriptions.length ? html`<div class="table-wrap"><table><thead><tr><th>Restaurant</th><th>Plan</th><th>Status</th><th class="num">Price</th><th>Renews / ends</th><th>Trial ends</th><th></th></tr></thead><tbody>
        ${list.subscriptions.map((s) => html`<tr><td>${s.restaurant}<div class="muted small">${s.slug}</div></td><td>${s.plan}</td><td><span class="badge ${statusTone(s.status)}">${cap(s.status)}</span>${s.cancelledAt ? html`<div class="muted small">ends, not renewing</div>` : ''}</td>
          <td class="num">${s.priceCents ? `${m(s.priceCents)}/${s.billingInterval}` : 'Free'}</td><td>${s.endDate ? fmtDay(s.endDate) : '—'}</td><td>${s.trialEnd ? fmtDay(s.trialEnd) : '—'}</td>
          <td class="right"><button class="btn secondary sm" data-detail="${s.restaurantId}">Manage</button>${s.openInvoices ? html` <span class="badge warn">${s.openInvoices} open invoice</span>` : ''}</td></tr>`)}</tbody></table></div>${pager(list.total, st.page)}` : emptyState('No subscriptions match')}
      <h3 style="margin-top:1.5rem">Open invoices</h3>
      ${invoices.length ? html`<div class="table-wrap"><table><thead><tr><th>#</th><th>Restaurant</th><th>Plan</th><th class="num">Amount</th><th>Period</th><th></th></tr></thead><tbody>
        ${invoices.map((i) => html`<tr><td>${i.id}</td><td>${i.restaurant}</td><td>${i.plan}</td><td class="num">${m(i.amountCents)}</td><td>${fmtDay(i.periodStart)} → ${fmtDay(i.periodEnd)}</td>
          <td class="right"><button class="btn sm" data-mark-paid="${i.id}">Mark paid (manual)</button> <button class="btn secondary sm" data-void="${i.id}">Void</button></td></tr>`)}</tbody></table></div>` : emptyState('No open invoices')}`);
    $('#filters').addEventListener('submit', (e) => { e.preventDefault(); st.f = Object.fromEntries(new FormData(e.target)); st.page = 1; route(); });
    panel.onclick = async (e) => {
      try {
        const pg = e.target.closest('[data-page]');
        if (pg) { st.page = Number(pg.dataset.page); return route(); }
        const d = e.target.closest('[data-detail]');
        if (d) return restaurantDetail(Number(d.dataset.detail), route);
        const mp = e.target.closest('[data-mark-paid]');
        if (mp) {
          const reference = await promptDialog('Payment reference (bank transfer id, receipt number…)', { confirmLabel: 'Mark paid' });
          if (reference) { await api(`/admin/invoices/${mp.dataset.markPaid}/mark-paid`, { method: 'POST', body: { reference } }); toast('Invoice marked paid; subscription activated', 'ok'); route(); }
        }
        const v = e.target.closest('[data-void]');
        if (v && await confirmDialog('Void this invoice?', { confirmLabel: 'Void', danger: true })) { await api(`/admin/invoices/${v.dataset.void}/void`, { method: 'POST', body: {} }); route(); }
      } catch (err) { toast(err, 'err'); }
    };
  },

  async plans(panel) {
    const { plans } = await api('/admin/plans');
    render(panel, html`<div class="toolbar"><p class="muted small" style="margin:0">Plans are fully configurable. Leave a limit empty for unlimited. Changes apply immediately to enforcement; a restaurant keeps the price it subscribed at.</p><button class="btn" data-new>New plan</button></div>
      <div class="table-wrap"><table><thead><tr><th>Plan</th><th class="num">Price</th><th>Trial</th><th class="num">Products</th><th class="num">Staff</th><th class="num">Orders / month</th><th>Features</th><th class="num">Restaurants</th><th>Status</th><th></th></tr></thead><tbody>
      ${plans.map((p) => html`<tr><td><strong>${p.name}</strong><div class="muted small">${p.code}</div></td><td class="num">${p.priceCents ? `${m(p.priceCents)}/${p.billingInterval}` : 'Free'}</td><td>${p.trialDays ? `${p.trialDays} days` : '—'}</td>
        <td class="num">${p.maxMenuItems ?? '∞'}</td><td class="num">${p.maxStaff ?? '∞'}</td><td class="num">${p.maxOrdersPerMonth ?? '∞'}</td>
        <td class="small">${[p.analytics ? 'Analytics' : '', p.advancedReports ? 'Advanced reports' : ''].filter(Boolean).join(', ') || '—'}</td><td class="num">${p.restaurants}</td>
        <td>${badge(p.isActive ? 'active' : 'cancelled', p.isActive ? 'Active' : 'Inactive')}</td><td class="right"><button class="btn secondary sm" data-edit="${p.code}">Edit</button></td></tr>`)}</tbody></table></div>`);
    panel.onclick = (e) => {
      if (e.target.closest('[data-new]')) planDialog(null);
      const ed = e.target.closest('[data-edit]');
      if (ed) planDialog(plans.find((p) => p.code === ed.dataset.edit));
    };
  },

  async reports(panel) {
    const types = [['revenue', 'Revenue'], ['orders', 'Orders'], ['restaurants', 'Restaurants'], ['customers', 'Customers'], ['payments', 'Payments'], ['commissions', 'Commissions'], ['payouts', 'Payouts'], ['refunds', 'Refunds'], ['cod', 'Cash on delivery'], ['finance', 'Finance summary']];
    const st = state.reports ||= { type: 'revenue', from: '', to: '' };
    const data = await api(`/admin/reports/${st.type}${qs({ from: st.from, to: st.to })}`);
    render(panel, html`<form class="filters" id="rf">${select('type', 'Report', types, st.type)}
      <div class="field"><label for="f-from">From</label><input id="f-from" name="from" type="date" value="${st.from}"></div>
      <div class="field"><label for="f-to">To</label><input id="f-to" name="to" type="date" value="${st.to}"></div>
      <button class="btn sm" type="submit">Run</button>
      <a class="btn secondary sm" href="/api/admin/reports/${st.type}${qs({ from: st.from, to: st.to, format: 'csv' })}" download>Export CSV</a></form>
      ${data.rows.length ? html`<div class="table-wrap"><table><thead><tr>${data.columns.map((c) => html`<th class="${c.money ? 'num' : ''}">${c.label}</th>`)}</tr></thead><tbody>
        ${data.rows.slice(0, 500).map((r) => html`<tr>${data.columns.map((c) => html`<td class="${c.money ? 'num' : ''}">${c.money ? m(r[c.key]) : (r[c.key] ?? '—')}</td>`)}</tr>`)}</tbody></table></div>
        ${data.rows.length > 500 ? html`<p class="muted small">Showing the first 500 rows. Export CSV for everything.</p>` : ''}` : emptyState('No data for this period')}`);
    $('#rf').addEventListener('submit', (e) => { e.preventDefault(); Object.assign(st, Object.fromEntries(new FormData(e.target))); route(); });
  },

  async support(panel) {
    const st = state.support ||= { status: 'open' };
    const { reports } = await api(`/admin/support-reports${qs({ status: st.status })}`);
    render(panel, html`<form class="filters" id="sf">${select('status', 'Status', [['', 'All'], ['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['closed', 'Closed']], st.status)}<button class="btn sm" type="submit">Filter</button></form>
      ${reports.length ? html`<div class="grid">${reports.map((r) => html`<article class="card"><div class="toolbar" style="margin-bottom:.25rem"><div><strong>${r.subject}</strong> <span class="badge ${r.priority === 'high' || r.priority === 'urgent' ? 'err' : ''}">${r.priority}</span></div><span class="badge ${r.status === 'resolved' || r.status === 'closed' ? 'ok' : 'warn'}">${cap(r.status)}</span></div>
        <div class="muted small">${cap(r.category)} · ${r.user} (${r.userEmail})${r.restaurant ? ` · ${r.restaurant}` : ''}${r.orderId ? ` · order ${r.orderId}` : ''} · ${fmtDate(r.createdAt)}</div>
        <p>${r.description}</p>${r.adminResponse ? html`<div class="alert info small"><strong>Reply:</strong> ${r.adminResponse}</div>` : ''}
        <form data-report="${r.id}" class="filters" novalidate>${select('status', 'Status', [['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['closed', 'Closed']], r.status)}
          ${select('priority', 'Priority', [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']], r.priority)}
          <div class="field" style="flex:3"><label>Reply to the user<input name="adminResponse" maxlength="2000" value="${r.adminResponse || ''}"></label></div><button class="btn sm" type="submit">Save</button></form></article>`)}</div>` : emptyState('No reports', 'Nothing needs attention.')}`);
    $('#sf').addEventListener('submit', (e) => { e.preventDefault(); st.status = new FormData(e.target).get('status'); route(); });
    for (const f of panel.querySelectorAll('form[data-report]')) {
      onSubmit(f, async (d) => { await api(`/admin/support-reports/${f.dataset.report}`, { method: 'PATCH', body: { status: d.status, priority: d.priority, adminResponse: d.adminResponse || undefined } }); toast('Report updated', 'ok'); route(); });
    }
  },

  async settings(panel) {
    const [{ settings, payoutMode, currency: cur, payoutSchedule, refundRules, settlementRules }, { payments: pay }] = await Promise.all([api('/admin/settings'), api('/admin/payment-settings')]);
    currency = cur;
    const tone = (v) => (['CONFIGURED', 'HEALTHY', 'AVAILABLE', 'IMPLEMENTED_UNVERIFIED'].includes(v) ? 'warn' : v === 'VERIFIED' ? 'ok' : ['ERROR', 'MISCONFIGURED'].includes(v) ? 'err' : '');
    const row = (k, v) => html`<tr><td>${k}</td><td><span class="badge ${tone(String(v))}">${String(v).replace(/_/g, ' ')}</span></td></tr>`;
    render(panel, html`<div class="grid cols-2">
      <form class="card" id="commission" novalidate><div class="form-alert"></div><h3>Marketplace: commission, fees &amp; payouts</h3>
        <p class="muted small">Applies to <strong>new</strong> orders only; each order stores the rule it was placed with. A restaurant can have its own percentage and fixed override (Restaurants → View).</p>
        <div class="field"><label for="c-bp">Default commission (%)</label><input id="c-bp" name="commission" inputmode="decimal" value="${settings.commission_bp / 100}"><div class="hint">Charged on the food value of each order.</div></div>
        <div class="field"><label for="c-fx">Fixed commission per order (${cur})</label><input id="c-fx" name="commissionFixed" inputmode="decimal" value="${fromCents(settings.commission_fixed_cents)}"><div class="hint">Added to the percentage (percentage + fixed); never more than the food value.</div></div>
        <div class="field"><label for="c-min">Minimum payout (${cur})</label><input id="c-min" name="minPayout" inputmode="decimal" value="${fromCents(settings.min_payout_cents)}"><div class="hint">Smaller weekly statements are carried forward to the next week.</div></div>
        <div class="field"><label for="c-sfp">Customer service fee (%)</label><input id="c-sfp" name="serviceFeePct" inputmode="decimal" value="${settings.service_fee_bp / 100}"></div>
        <div class="field"><label for="c-sff">Customer service fee, fixed (${cur})</label><input id="c-sff" name="serviceFeeFixed" inputmode="decimal" value="${fromCents(settings.service_fee_fixed_cents)}"></div>
        <button class="btn" type="submit">Save</button>
        <h4 style="margin-top:1rem">Fixed rules</h4>
        <p class="muted small"><strong>Payout schedule:</strong> ${payoutSchedule}<br><strong>Refund rules:</strong> ${refundRules}<br><strong>Settlement:</strong> ${settlementRules}</p></form>
      <div class="card"><h3>Payment provider</h3>
        <table><tbody>
          <tr><td>Provider</td><td><strong>${pay.provider === 'none' ? 'not configured' : pay.provider}</strong></td></tr>
          <tr><td>Environment</td><td><strong>${pay.environment}</strong></td></tr>
          ${row('Configuration', pay.configuration)}${pay.missing.length ? html`<tr><td>Missing</td><td><code>${pay.missing.join(', ')}</code></td></tr>` : ''}
          ${row('Provider credentials', pay.providerConnected)}${row('Webhook', pay.webhook.status)}
          ${row('Marketplace split', pay.marketplace)}${row('Automated restaurant payouts', pay.restaurantPayouts.automated)}
          ${row('Subscription checkout', pay.subscriptionBilling.hostedCheckout)}${row('Saved-card recurring billing', pay.subscriptionBilling.recurringTokenisation)}
          ${row('Apple Pay', pay.paymentMethods.applePay)}${row('Google Pay', pay.paymentMethods.googlePay)}${row('Mada', pay.paymentMethods.mada)}${row('USD settlement', pay.usdSettlement)}
          ${row('Sandbox', pay.sandbox)}${row('Production', pay.production)}
          <tr><td>Currency</td><td>${pay.currency}</td></tr><tr><td>Payout mode</td><td>${payoutMode.replace('_', ' ')}</td></tr></tbody></table>
        <p class="muted small">Webhook URL for the provider dashboard: <code>${pay.webhook.url}</code>. Secret keys are environment variables and are never shown. <strong>NOT VERIFIED</strong> / <strong>IMPLEMENTED UNVERIFIED</strong> means the capability has not been confirmed in the provider's sandbox yet. Plans are under <a data-nav href="/admin/plans">Plans</a>.</p></div></div>`);
    onSubmit($('#commission'), async (d) => {
      const pct = (v) => Math.round(parseFloat(String(v).replace(',', '.')) * 100);
      const body = { commissionBp: pct(d.commission), commissionFixedCents: toCents(d.commissionFixed), minPayoutCents: toCents(d.minPayout), serviceFeeBp: pct(d.serviceFeePct), serviceFeeFixedCents: toCents(d.serviceFeeFixed) };
      if (Object.values(body).some(Number.isNaN)) throw new Error('Enter valid numbers');
      await api('/admin/settings', { method: 'PUT', body }); toast('Settings saved', 'ok');
    });
  },

  async reconciliation(panel) {
    const [apps] = await Promise.all([api('/admin/payment-applications')]);
    render(panel, html`<div class="toolbar"><h2>Reconciliation</h2><div class="actions-row"><select id="rc-days" aria-label="Window"><option value="1">Last day</option><option value="7" selected>Last 7 days</option><option value="30">Last 30 days</option></select><button class="btn" data-run>Run reconciliation</button></div></div>
      <p class="muted small">Compares this platform's records with the payment provider (each card payment is re-fetched from the provider: amount, currency, order reference, paid state) and checks internal invariants (ledger, refunds, payouts). Nothing is changed by running it.</p>
      <div id="rc-result">${emptyState('Not run yet', 'Press “Run reconciliation”.')}</div>
      <h3 style="margin-top:1.5rem">Restaurant payout-account applications</h3>
      ${apps.applications.length ? html`<div class="table-wrap"><table><thead><tr><th>Restaurant</th><th>Legal name</th><th>CR no.</th><th>Contact</th><th>Status</th><th>Submitted</th></tr></thead><tbody>
        ${apps.applications.map((a) => html`<tr><td>${a.restaurant}</td><td>${a.legalName}</td><td>${a.registrationNumber}</td><td>${a.contactName}<div class="muted small">${a.contactPhone} · ${a.contactEmail}</div></td><td><span class="badge ${a.status === 'VERIFIED' ? 'ok' : 'warn'}">${a.status.replace('_', ' ')}</span></td><td>${fmtDate(a.submittedAt)}</td></tr>`)}</tbody></table></div>
        <p class="muted small">Complete the provider-side business registration (KYC/KYB) in the provider dashboard, then link its account id under Restaurants → View → Payment account. The account is VERIFIED only after the provider confirms it.</p>` : emptyState('No applications', 'Restaurants that ask to set up a payout account appear here.')}`);
    panel.onclick = async (e) => {
      if (!e.target.closest('[data-run]')) return;
      try {
        const r = (await api('/admin/reconciliation/run', { method: 'POST', body: { days: Number($('#rc-days').value) } })).reconciliation;
        render($('#rc-result'), html`<div class="alert ${r.status === 'CLEAN' ? 'info' : 'error'}"><strong>${r.status}</strong> · ${r.providerChecked ? `${r.checked} provider payment(s) re-fetched` : html`${r.skippedReason}`} · ${r.findings.length} finding(s)</div>
          ${r.findings.length ? html`<div class="table-wrap"><table><thead><tr><th>Severity</th><th>Type</th><th>Reference</th><th>Detail</th></tr></thead><tbody>${r.findings.map((f) => html`<tr><td><span class="badge ${f.severity === 'critical' ? 'err' : 'warn'}">${f.severity}</span></td><td><code>${f.type}</code></td><td>${f.ref}</td><td class="small">${f.detail}</td></tr>`)}</tbody></table></div>` : ''}`);
      } catch (err) { toast(err, 'err'); }
    };
  },

  async audit(panel) {
    const { entries } = await api('/admin/audit?limit=300');
    render(panel, entries.length ? html`<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th></tr></thead><tbody>
      ${entries.map((a) => html`<tr><td>${fmtDate(a.createdAt)}</td><td>${a.actor || a.role}</td><td><code>${a.action}</code></td><td>${a.targetType ? `${a.targetType} ${a.targetId ?? ''}` : '—'}</td><td class="small">${a.details ? JSON.stringify(a.details) : ''}</td></tr>`)}</tbody></table></div>` : emptyState('No audit entries yet', 'Admin actions are recorded here as they happen.'));
  },

  async system(panel) {
    const s = await api('/admin/system');
    const kb = (b) => (b === null ? 'n/a' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
    const flag = (ok, yes, no) => html`<span class="badge ${ok ? 'ok' : 'warn'}">${ok ? yes : no}</span>`;
    render(panel, html`<div class="grid cols-3">
      <div class="card"><h3>Application</h3><p>${s.environment} · Node ${s.node}<br>Up ${Math.floor(s.uptimeSeconds / 3600)}h ${Math.floor((s.uptimeSeconds % 3600) / 60)}m<br>URL: ${s.appUrl}<br>Tenant domain: ${s.tenantBaseDomain || 'not configured (path-based URLs)'}</p></div>
      <div class="card"><h3>Database</h3><p>${s.database.engine} · ${kb(s.database.sizeBytes)}<br>${s.database.migrations.length} migrations applied</p><p class="muted small">${s.database.recommendation}</p></div>
      <div class="card"><h3>Payments</h3><p>Provider: ${s.payments.provider} ${flag(s.payments.enabled, 'configured', 'not configured')} · ${s.payments.environment}<br>Configuration: ${flag(s.payments.configuration === 'CONFIGURED', 'CONFIGURED', s.payments.configuration)}<br>Webhook: ${flag(s.payments.webhook.status === 'HEALTHY', 'HEALTHY', s.payments.webhook.status.replace(/_/g, ' '))}<br>Marketplace: ${flag(s.payments.marketplace === 'VERIFIED', 'VERIFIED', s.payments.marketplace.replace(/_/g, ' '))}<br>Restaurant payouts (automated): ${flag(s.payments.restaurantPayouts.automated === 'VERIFIED', 'VERIFIED', s.payments.restaurantPayouts.automated.replace(/_/g, ' '))}<br>Subscription billing: ${flag(s.payments.subscriptionBilling.hostedCheckout === 'VERIFIED', 'VERIFIED', s.payments.subscriptionBilling.hostedCheckout.replace(/_/g, ' '))}<br>Sandbox: ${s.payments.sandbox.replace(/_/g, ' ')} · Production: ${s.payments.production.replace(/_/g, ' ')}<br>Payout mode: ${s.payments.payoutMode.replace('_', ' ')} · Currency: ${s.payments.currency}</p></div>
      <div class="card"><h3>Security</h3><p>Admin 2FA required: ${flag(s.security.admin2faRequired, 'yes', 'no')}<br>Admins without 2FA: <strong>${s.security.adminsWithout2fa}</strong><br>Secure cookies: ${flag(s.security.secureCookies, 'on', 'off (development)')}<br>Email: ${flag(s.email.configured, 'configured', 'not configured')}</p></div>
      <div class="card"><h3>Queues &amp; attention</h3><p>Unpaid card orders: ${s.queues.unpaidCardOrders}<br>Pending refunds: ${s.queues.pendingRefunds} · failed: ${s.queues.failedRefunds}<br>Failed webhooks (24h): ${s.queues.failedWebhooks24h}<br>Open invoices: ${s.queues.openInvoices}<br>Failed payouts: ${s.queues.failedPayouts}</p></div>
      <div class="card"><h3>Data</h3><p>Users ${s.counts.users} · Restaurants ${s.counts.restaurants} · Orders ${s.counts.orders}<br>Audit entries ${s.counts.auditEntries}<br>Weekly payout job: ${flag(s.jobs.weeklyPayoutScheduler, 'on', 'off')}</p></div></div>`);
  },

  async security(panel) {
    const render2fa = async () => {
      me = await api('/admin/me').catch(() => me);
      const enabled = me.user.totpEnabled;
      render(panel, html`<div class="card" style="max-width:640px"><h2>Two-factor authentication</h2>
        <p>Status: ${enabled ? raw('<span class="badge ok">Enabled</span>') : raw('<span class="badge warn">Not enabled</span>')}</p>
        ${enabled ? html`<p class="muted">Your account needs a code from your authenticator app each time you sign in.</p>
          <div class="actions-row"><button class="btn secondary" data-codes>Regenerate backup codes</button><button class="btn danger" data-disable>Disable 2FA</button></div>`
    : html`<p class="muted">Use an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…). <strong>Required before production launch.</strong></p>
          <button class="btn" data-setup>Set up two-factor authentication</button>`}
        <div id="twofa-area" style="margin-top:1rem"></div></div>`);
    };
    await render2fa();
    const area = () => $('#twofa-area');
    const showCodes = (codes) => render(area(), html`<div class="alert warn"><strong>Save your backup codes now.</strong> Each can be used once if you lose your phone. They are shown only this time.</div>
      <pre style="background:var(--bg);padding:1rem;border-radius:8px;user-select:all">${codes.join('\n')}</pre><button class="btn" data-done>I have saved them</button>`);
    panel.onclick = async (e) => {
      try {
        if (e.target.closest('[data-setup]')) {
          const s = await api('/auth/2fa/setup', { method: 'POST', body: {} });
          render(area(), html`<ol><li>Open your authenticator app and add an account <em>manually</em> (time-based) using this key:<br><code style="user-select:all;font-size:1.1rem">${s.secret}</code></li>
            <li>Or open this link on a device with an authenticator app: <a href="${s.otpauthUri}">otpauth link</a></li><li>Enter the 6-digit code it shows:</li></ol>
            <form id="enable" novalidate><div class="form-alert"></div><div class="field"><label for="tc">Code</label><input id="tc" name="code" inputmode="numeric" autocomplete="one-time-code" required></div><button class="btn" type="submit">Enable 2FA</button></form>`);
          onSubmit($('#enable'), async (d) => {
            const r = await api('/auth/2fa/enable', { method: 'POST', body: { code: d.code } });
            me.mfaEnrollmentRequired = false; me.user.totpEnabled = true;
            toast('Two-factor authentication enabled', 'ok');
            showCodes(r.backupCodes);
          });
        }
        if (e.target.closest('[data-done]')) route();
        if (e.target.closest('[data-codes]') || e.target.closest('[data-disable]')) {
          const disabling = !!e.target.closest('[data-disable]');
          render(area(), html`<form id="reauth" novalidate><div class="form-alert"></div><p>Confirm it is you.</p>
            <div class="field"><label for="rp">Password</label><input id="rp" name="password" type="password" autocomplete="current-password" required></div>
            <div class="field"><label for="rc">Authenticator or backup code</label><input id="rc" name="code" required></div>
            <button class="btn ${disabling ? 'danger' : ''}" type="submit">${disabling ? 'Disable 2FA' : 'Generate new codes'}</button></form>`);
          onSubmit($('#reauth'), async (d) => {
            if (disabling) { await api('/auth/2fa/disable', { method: 'POST', body: d }); session.clear(); location.href = '/admin/login'; return; }
            showCodes((await api('/auth/2fa/backup-codes', { method: 'POST', body: d })).backupCodes);
          });
        }
      } catch (err) { toast(err, 'err'); }
    };
  },
};

// ---------- dialogs ----------
async function orderDetail(id) {
  const r = await api(`/admin/orders/${id}`);
  const o = r.order;
  dialog(`Order #${o.orderNumber} · ${o.restaurantName}`, html`<p>${cap(o.status)} · ${o.orderType} · ${o.paymentMethod === 'cod' ? 'Cash on delivery' : 'Card'} (${cap(o.paymentStatus)})</p>
    <p><strong>${o.customerName}</strong> · ${o.customerPhone}${o.deliveryAddress ? ` · ${o.deliveryAddress}` : ''}</p>
    <table><tbody>${o.items.map((i) => html`<tr><td>${i.quantity} × ${i.name}${i.options.length ? html`<div class="muted small">${i.options.map((x) => x.name).join(', ')}</div>` : ''}</td><td class="num">${m(i.lineTotalCents)}</td></tr>`)}
      <tr><td class="muted">Subtotal</td><td class="num">${m(o.subtotalCents)}</td></tr><tr><td class="muted">Tax / delivery / service fee</td><td class="num">${m(o.taxCents)} / ${m(o.deliveryFeeCents)} / ${m(o.platformFeeCents)}</td></tr>
      <tr><td><strong>Total</strong></td><td class="num"><strong>${m(o.totalCents)}</strong></td></tr>
      <tr><td class="muted">Platform commission (${o.commissionBp / 100}%)</td><td class="num">${m(o.commissionCents)}</td></tr><tr><td class="muted">Restaurant share</td><td class="num">${m(o.restaurantAmountCents)}</td></tr></tbody></table>
    ${r.payment ? html`<p class="small muted">Payment #${r.payment.id}: ${r.payment.provider} ${r.payment.provider_transaction_id || ''} · ${cap(r.payment.status)}${r.payment.failure_reason ? ` · ${r.payment.failure_reason}` : ''}</p>` : ''}
    ${r.refunds.length ? html`<p class="small">Refunds: ${r.refunds.map((f) => `${m(f.amount_cents)} (${f.status})`).join(', ')}</p>` : ''}
    <ul class="timeline">${r.history.map((h) => html`<li><span class="dot"></span><span>${cap(h.status)} <span class="muted small">${fmtDate(h.created_at)}</span></span></li>`)}</ul>`, { wide: true });
}

async function restaurantDetail(id, refresh) {
  const d = await api(`/admin/restaurants/${id}`);
  const { restaurant: r, paymentAccount: a, earnings, subscription: sub, invoices, recentOrders, payouts, reportLast30Days: rep } = d;
  const plans = (await api('/admin/plans')).plans;
  const dlg = dialog(r.name, html`<p class="muted small">${r.slug} · owner ${r.ownerEmail || '—'} · ${r.city || ''} · ${cap(r.approvalStatus)}${r.isActive ? '' : ' · suspended'} · <a href="/restaurant/${r.slug}" target="_blank" rel="noopener">public page</a></p>
    <div class="grid cols-3"><div class="card stat"><div class="label">Orders (all time)</div><div class="value">${r.orders}</div></div><div class="card stat"><div class="label">Revenue</div><div class="value">${m(earnings.gmvCents)}</div><div class="muted small">30 days: ${m(rep.revenueCents)} (${rep.orders})</div></div>
      <div class="card stat"><div class="label">Platform commission</div><div class="value">${m(earnings.commissionCents)}</div></div></div>
    <table style="margin-top:.5rem"><tbody><tr><td>Restaurant earnings: available / pending / paid</td><td class="num">${m(earnings.availableCents)} / ${m(earnings.pendingCents)} / ${m(earnings.paidCents)}</td></tr>
      <tr><td>Cash commission due</td><td class="num">${m(earnings.codCommissionDueCents)}</td></tr></tbody></table>
    <h3>Subscription</h3>
    <p>${sub.plan.name} · <span class="badge ${statusTone(sub.status)}">${cap(sub.status)}</span> ${sub.endDate && sub.status !== 'trialing' ? `· ${sub.cancelledAt ? 'ends' : 'renews'} ${fmtDay(sub.endDate)}` : ''}${sub.status === 'trialing' ? ` · trial ends ${fmtDay(sub.trialEnd)} (invoiced after)` : ''}<br>
      Usage: ${sub.usage.menuItems}/${sub.plan.limits.menuItems ?? '∞'} products · ${sub.usage.staff}/${sub.plan.limits.staff ?? '∞'} staff · ${sub.usage.ordersPerMonth}/${sub.plan.limits.ordersPerMonth ?? '∞'} orders this month</p>
    <form id="sf" novalidate><div class="form-alert"></div><div class="row">
      <div class="field"><label for="sf-plan">Plan</label><select id="sf-plan" name="planCode">${plans.map((p) => html`<option value="${p.code}" ${p.code === sub.plan.code ? raw('selected') : ''}>${p.name}${p.isActive ? '' : ' (inactive)'}</option>`)}</select></div>
      ${select('status', 'Status', ['trialing', 'active', 'past_due', 'cancelled', 'expired', 'suspended'].map((s) => [s, cap(s)]), sub.status)}
      <div class="field"><label for="sf-end">Period end (optional)</label><input id="sf-end" name="endDate" type="date" value="${sub.endDate ? sub.endDate.slice(0, 10) : ''}"></div></div>
      <button class="btn" type="submit">Assign plan / status</button> <span class="muted small">Recorded in the audit log. No payment is taken.</span></form>
    ${invoices.length ? html`<h3>Subscription invoices</h3><div class="table-wrap"><table><tbody>${invoices.map((i) => html`<tr><td>#${i.id}</td><td>${fmtDay(i.periodStart)} → ${fmtDay(i.periodEnd)}</td><td class="num">${m(i.amountCents)}</td><td><span class="badge ${statusTone(i.status)}">${i.status}</span></td><td class="small">${i.provider || ''} ${i.reference || ''}</td></tr>`)}</tbody></table></div>` : ''}
    ${recentOrders.length ? html`<h3>Recent orders</h3><div class="table-wrap"><table><tbody>${recentOrders.map((o) => html`<tr><td>#${o.orderNumber}</td><td>${cap(o.status)}</td><td>${o.paymentMethod === 'cod' ? 'Cash' : 'Card'}</td><td class="num">${m(o.totalCents)}</td><td>${fmtDay(o.createdAt)}</td></tr>`)}</tbody></table></div>` : ''}
    ${payouts.length ? html`<h3>Payouts</h3><div class="table-wrap"><table><tbody>${payouts.map((p) => html`<tr><td>${p.periodStart} → ${p.periodEnd}</td><td class="num">${m(p.amountCents)}</td><td>${p.status}</td><td class="small">${p.reference || ''}</td></tr>`)}</tbody></table></div>` : ''}
    <form id="rd" novalidate style="margin-top:1rem"><div class="form-alert"></div><h3>Profile &amp; commission</h3>
      <div class="row"><div class="field"><label for="rd-name">Name</label><input id="rd-name" name="name" value="${r.name}"></div><div class="field"><label for="rd-city">City</label><input id="rd-city" name="city" value="${r.city || ''}"></div></div>
      <div class="row"><div class="field"><label for="rd-phone">Phone</label><input id="rd-phone" name="phone" value="${r.phone || ''}"></div><div class="field"><label for="rd-wa">WhatsApp</label><input id="rd-wa" name="whatsapp" value="${r.whatsapp || ''}"></div>
        <div class="field"><label for="rd-comm">Commission override (%)</label><input id="rd-comm" name="commission" inputmode="decimal" value="${r.commissionBpOverride === null ? '' : r.commissionBpOverride / 100}" placeholder="platform default"></div>
        <div class="field"><label for="rd-cfx">Fixed commission override</label><input id="rd-cfx" name="commissionFixed" inputmode="decimal" value="${r.commissionFixedOverride === null || r.commissionFixedOverride === undefined ? '' : fromCents(r.commissionFixedOverride)}" placeholder="platform default"></div></div>
      <button class="btn" type="submit">Save profile</button></form>
    <form id="pa" novalidate style="margin-top:1rem"><div class="form-alert"></div><h3>Payment account (restaurant payouts)</h3>
      ${a?.application ? html`<div class="alert info small"><strong>Application:</strong> ${a.application.legalName} · CR ${a.application.registrationNumber} · ${a.application.contactName} (${a.application.contactPhone}, ${a.application.contactEmail}) — submitted ${fmtDate(a.applicationSubmittedAt)}</div>` : ''}
      <p class="muted small">Status: <strong>${(a?.status || 'NOT_ONBOARDED').replace('_', ' ')}</strong>. After the provider has completed the restaurant's KYC/KYB, paste the provider's destination id. It is confirmed with the provider before it is saved; <em>Verified</em> and <em>Enable</em> are refused unless the provider confirms the account. Never enter bank or card details here: only a masked display value.</p>
      <div class="field"><label for="pa-id">Connected account id</label><input id="pa-id" name="connectedAccountId" value="${a?.connectedAccountId || ''}"></div>
      <div class="row">${select('onboardingStatus', 'Onboarding', [['not_started', 'Not started'], ['in_progress', 'In progress'], ['completed', 'Completed'], ['rejected', 'Rejected']], a?.onboardingStatus)}
        ${select('verificationStatus', 'Verification', [['unverified', 'Unverified'], ['pending', 'Pending'], ['verified', 'Verified'], ['rejected', 'Rejected']], a?.verificationStatus)}
        ${select('payoutAccountStatus', 'Payout account', [['inactive', 'Inactive'], ['active', 'Active'], ['restricted', 'Restricted']], a?.payoutAccountStatus)}</div>
      <div class="row"><div class="field"><label for="pa-mb">Masked bank (display only)</label><input id="pa-mb" name="maskedBank" value="${a?.maskedBank || ''}" placeholder="****1234"></div>
        <div class="field"><label for="pa-sc">Settlement currency</label><input id="pa-sc" name="settlementCurrency" value="${a?.settlementCurrency || ''}" placeholder="SAR" maxlength="3"></div>
        <div class="field"><label for="pa-rj">Rejection reason</label><input id="pa-rj" name="rejectionReason" value="${a?.rejectionReason || ''}"></div></div>
      <div class="check"><input type="checkbox" id="pa-dis" name="disabled" ${a?.status === 'DISABLED' ? raw('checked') : ''}><label for="pa-dis">Disable this payout account</label></div>
      <div class="check"><input type="checkbox" id="pa-en" name="payoutEnabled" ${a?.payoutEnabled ? raw('checked') : ''}><label for="pa-en">Enable card payments &amp; payouts for this restaurant</label></div>
      <button class="btn" type="submit" style="margin-top:.75rem">Save payment account</button></form>
    <div style="margin-top:1rem"><button class="btn danger sm" data-delete>Delete restaurant…</button> <span class="muted small">Only possible when it has no orders or paid invoices; otherwise suspend it.</span></div>`, { wide: true, onClose: refresh });
  onSubmit($('#sf', dlg), async (f) => {
    await api(`/admin/restaurants/${id}/subscription`, { method: 'PUT', body: { planCode: f.planCode, status: f.status, endDate: f.endDate || undefined } });
    toast('Subscription updated', 'ok');
  }, { alertBox: $('#sf .form-alert', dlg) });
  onSubmit($('#rd', dlg), async (f) => {
    const comm = String(f.commission).trim() === '' ? null : Math.round(parseFloat(f.commission.replace(',', '.')) * 100);
    if (Number.isNaN(comm)) throw new Error('Commission must be a number');
    const fixed = String(f.commissionFixed).trim() === '' ? null : toCents(f.commissionFixed);
    if (Number.isNaN(fixed)) throw new Error('Fixed commission must be a number');
    await api(`/admin/restaurants/${id}`, { method: 'PATCH', body: { name: f.name, city: f.city, phone: f.phone || null, whatsapp: f.whatsapp || null, commissionBpOverride: comm, commissionFixedOverride: fixed } });
    toast('Restaurant updated', 'ok');
  }, { alertBox: $('#rd .form-alert', dlg) });
  onSubmit($('#pa', dlg), async (f) => {
    await api(`/admin/restaurants/${id}/payment-account`, { method: 'PUT', body: { ...f, connectedAccountId: f.connectedAccountId || null } });
    toast('Payment account saved', 'ok');
  }, { alertBox: $('#pa .form-alert', dlg) });
  dlg.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-delete]')) return;
    if (!await confirmDialog(`Permanently delete ${r.name}? This cannot be undone.`, { confirmLabel: 'Delete', danger: true })) return;
    try { await api(`/admin/restaurants/${id}`, { method: 'DELETE' }); toast('Restaurant deleted', 'ok'); dlg.close(); } catch (err) { toast(err, 'err'); }
  });
}

function planDialog(p) {
  const dlg = dialog(p ? `Edit plan: ${p.name}` : 'New plan', html`<form id="pf" novalidate><div class="form-alert"></div>
    <div class="row"><div class="field"><label for="p-code">Code</label><input id="p-code" name="code" value="${p?.code || ''}" ${p ? raw('disabled') : ''} placeholder="e.g. starter" required></div>
      <div class="field"><label for="p-name">Name</label><input id="p-name" name="name" value="${p?.name || ''}" required></div></div>
    <div class="field"><label for="p-desc">Description</label><input id="p-desc" name="description" value="${p?.description || ''}"></div>
    <div class="row"><div class="field"><label for="p-price">Price (${currency})</label><input id="p-price" name="price" inputmode="decimal" value="${p ? fromCents(p.priceCents) : '0.00'}"></div>
      ${select('billingInterval', 'Billing interval', [['month', 'Monthly'], ['year', 'Yearly']], p?.billingInterval || 'month')}
      <div class="field"><label for="p-trial">Trial days</label><input id="p-trial" name="trialDays" type="number" min="0" max="365" value="${p?.trialDays ?? 0}"></div></div>
    <div class="row"><div class="field"><label for="p-items">Max products</label><input id="p-items" name="maxMenuItems" inputmode="numeric" placeholder="unlimited" value="${p?.maxMenuItems ?? ''}"></div>
      <div class="field"><label for="p-staff">Max staff users</label><input id="p-staff" name="maxStaff" inputmode="numeric" placeholder="unlimited" value="${p?.maxStaff ?? ''}"></div>
      <div class="field"><label for="p-orders">Max orders / month</label><input id="p-orders" name="maxOrdersPerMonth" inputmode="numeric" placeholder="unlimited" value="${p?.maxOrdersPerMonth ?? ''}"></div>
      <div class="field"><label for="p-br">Max branches</label><input id="p-br" name="maxBranches" inputmode="numeric" placeholder="unlimited" value="${p?.maxBranches ?? ''}"></div></div>
    <div class="check"><input type="checkbox" id="p-an" name="analytics" ${p?.analytics ? raw('checked') : ''}><label for="p-an">Sales analytics</label></div>
    <div class="check"><input type="checkbox" id="p-ad" name="advancedReports" ${p?.advancedReports ? raw('checked') : ''}><label for="p-ad">Advanced reports &amp; export</label></div>
    <div class="check"><input type="checkbox" id="p-ac" name="isActive" ${!p || p.isActive ? raw('checked') : ''}><label for="p-ac">Active (available to choose)</label></div>
    <div class="field" style="margin-top:.75rem"><label for="p-feat">Feature bullet points (one per line, shown on the plan card)</label><textarea id="p-feat" name="features" rows="4">${(p?.features || []).join('\n')}</textarea></div>
    <button class="btn" type="submit">Save plan</button></form>`, { wide: true, onClose: () => route() });
  onSubmit($('#pf', dlg), async (d) => {
    const lim = (v) => (String(v).trim() === '' ? null : Number(v));
    const price = toCents(d.price);
    if (Number.isNaN(price)) throw Object.assign(new Error('price: enter an amount like 29.00'), { details: { field: 'price' } });
    const body = {
      name: d.name, description: d.description, priceCents: price, currency, billingInterval: d.billingInterval, trialDays: Number(d.trialDays || 0),
      maxMenuItems: lim(d.maxMenuItems), maxStaff: lim(d.maxStaff), maxOrdersPerMonth: lim(d.maxOrdersPerMonth), maxBranches: lim(d.maxBranches),
      analytics: d.analytics, advancedReports: d.advancedReports, isActive: d.isActive, features: d.features.split('\n').map((x) => x.trim()).filter(Boolean),
    };
    if (p) await api(`/admin/plans/${p.code}`, { method: 'PUT', body }); else await api('/admin/plans', { method: 'POST', body: { ...body, code: d.code } });
    toast('Plan saved', 'ok');
    dlg.close();
  }, { alertBox: $('.form-alert', dlg) });
}

boot();
