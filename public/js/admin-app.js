import {
  api, session, requireRoles, mountChrome, publicConfig, $, render, html, raw, money, fmtDate, fmtDay, cap, toCents, fromCents,
  spinner, emptyState, errorBox, toast, onSubmit, confirmDialog, promptDialog, wireDialog, t, has, isDefaultText, statusLabel, payLabel,
} from './common.js';

mountChrome({ active: 'admin' });
const user = requireRoles('super_admin'); // convenience only: every /admin page and /api/admin call is authorised by the backend

const NAV = ['dashboard', 'restaurants', 'users', 'customers', 'orders', 'payments', 'refunds', 'payouts', 'subscriptions', 'plans', 'reconciliation', 'reports', 'support', 'settings', 'audit', 'system'];
const navLabel = (k) => t(`adm.nav.${k}`);
let currency = 'USD';
let me = null;
const m = (c) => money(c, currency);
const state = {}; // remembered filters/pages per section

// translated label for a server code, with the raw code (underscores removed) as a last resort
const label = (prefix, code) => (has(`${prefix}.${code}`) ? t(`${prefix}.${code}`) : cap(code));
const capability = (v) => label('adm.cap', String(v));
// Server-written diagnostics (rules text, recommendations) are shown translated while they are still the unedited defaults.
const srv = (key, text) => (isDefaultText(key, text) ? t(key) : text);
const tech = (text) => html`<bdi dir="ltr">${text}</bdi>`; // identifiers, references and provider text keep their own direction
const sectionFromPath = () => {
  const s = location.pathname.replace(/^\/admin\/?/, '').split('/')[0] || 'dashboard';
  return [...NAV, 'security'].includes(s) ? s : 'dashboard';
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
  const title = id === 'security' ? t('adm.title.security') : navLabel(id);
  const sidebar = html`<nav class="side admin-side" aria-label="${t('adm.navLabel')}"><div class="side-list">${NAV.map((k) => html`<a class="side-link" data-nav href="/admin/${k}" ${k === id ? raw('aria-current="page"') : ''}><span class="side-label">${navLabel(k)}</span></a>`)}
    <hr style="border:0;border-top:1px solid var(--border);width:100%"><a class="side-link" data-nav href="/admin/security" ${id === 'security' ? raw('aria-current="page"') : ''}><span class="side-label">${t('adm.nav.security')}</span></a></div></nav>`;
  render($('#root'), html`<div class="toolbar"><h1>${title}</h1><span class="muted small"><bdi>${me.user.email}</bdi></span></div>
    ${me.mfaEnrollmentRequired ? html`<div class="alert warn" role="alert"><strong>${t('adm.mfaRequired')}</strong> ${t('adm.mfaRequiredText')}</div>` : ''}
    <div class="dash">${sidebar}<section id="panel" aria-live="polite"></section></div>`);
  document.title = `${title} | ${t('adm.admin')} | Foodies`;
  const panel = $('#panel');
  panel.onclick = null;
  render(panel, spinner());
  try { await views[id](panel); } catch (e) {
    if (e.code === 'mfa_enrollment_required') { me.mfaEnrollmentRequired = true; return route(); }
    render(panel, errorBox(e));
  }
}

// ---------- small helpers ----------
const pager = (total, p, size = 25) => html`<div class="pager"><span class="muted small">${total === 1 ? t('adm.resultsOne') : t('adm.resultsMany', { n: total })}</span>
  <button class="btn secondary sm" data-page="${p - 1}" ${p <= 1 ? raw('disabled') : ''}>${t('adm.prev')}</button><span>${t('adm.page', { n: p })}</span>
  <button class="btn secondary sm" data-page="${p + 1}" ${p * size >= total ? raw('disabled') : ''}>${t('adm.next')}</button></div>`;
const select = (name, labelText, options, value) => html`<div class="field"><label for="f-${name}">${labelText}</label><select id="f-${name}" name="${name}">${options.map(([v, l]) => html`<option value="${v}" ${String(v) === String(value || '') ? raw('selected') : ''}>${l}</option>`)}</select></div>`;
const qs = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '' && v !== null) p.set(k, v); const s = p.toString(); return s ? `?${s}` : ''; };
const badge = (status, text) => html`<span class="badge nocap ${status}">${text}</span>`;
const statusTone = (s) => (['active', 'succeeded', 'paid', 'cash_collected', 'approved', 'delivered'].includes(s) ? 'ok' : ['failed', 'cancelled', 'rejected', 'suspended', 'expired', 'void'].includes(s) ? 'err' : 'warn');
const ALL = () => ['', t('adm.all')];
const subStatus = (s) => label('sub.status', s);
const approval = (s) => label('adm.approval', s);
const dateRange = (a, b) => html`<bdi>${a}</bdi> – <bdi>${b}</bdi>`;

// Filter form + table + pager; re-runs on submit / paging. `onAction` receives row-action clicks.
function listView(panel, key, { filtersHtml, load, table, onAction }) {
  const st = state[key] ||= { page: 1, f: {} };
  async function draw() {
    const data = await load({ ...st.f, page: st.page });
    render(panel, html`<form class="filters" id="filters">${filtersHtml(st.f)}<button class="btn sm" type="submit">${t('adm.filter')}</button></form>
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
  dlg.innerHTML = html`<h2>${title}</h2>${body}<div class="actions-row" style="margin-top:1rem"><button class="btn secondary" data-close>${t('common.close')}</button></div>`.s;
  document.body.append(dlg);
  wireDialog(dlg, onClose);
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dlg.close(); });
  dlg.showModal();
  return dlg;
}

// Bar chart from real series data (no external library). Charts read left to right (time axis) in both languages.
function barChart(title, points, key, { format = (v) => v, note = '' } = {}) {
  const max = Math.max(1, ...points.map((p) => Number(p[key] || 0)));
  const total = points.reduce((s, p) => s + Number(p[key] || 0), 0);
  return html`<div class="card"><h3 style="margin-bottom:.25rem">${title}</h3><div class="muted small">${note}${note ? ' · ' : ''}${t('adm.total', { value: format(total) })}</div>
    <div class="bars" dir="ltr" role="img" aria-label="${t('adm.chartAria', { title, total: format(total), n: points.length })}">${points.map((p) => html`<div class="bar" style="height:${Math.max(2, Math.round((Number(p[key] || 0) / max) * 100))}%" title="${p.day}: ${format(Number(p[key] || 0))}"></div>`)}</div>
    <div class="muted small" style="display:flex;justify-content:space-between"><bdi>${points[0]?.day}</bdi><bdi>${points[points.length - 1]?.day}</bdi></div></div>`;
}

const stat = (labelText, value, sub = '') => html`<div class="card stat"><div class="label">${labelText}</div><div class="value">${value}</div>${sub ? html`<div class="muted small">${sub}</div>` : ''}</div>`;

// ---------- sections ----------
const views = {
  async dashboard(panel) {
    const days = Number(state.dashDays) || 30;
    const { stats: s, series, currency: cur } = await api(`/admin/dashboard?days=${days}`);
    currency = cur;
    render(panel, html`<div class="toolbar" style="margin-bottom:.5rem"><span class="muted small">${t('adm.dash.live')}</span>
      <select id="days" aria-label="${t('adm.dash.chartPeriod')}" style="width:auto">${[7, 30, 90, 180].map((d) => html`<option value="${d}" ${d === days ? raw('selected') : ''}>${t('rep.lastDays', { n: d })}</option>`)}</select></div>
      <div class="grid cols-4">
        ${stat(t('adm.dash.totalRestaurants'), s.totalRestaurants, t('adm.dash.nActive', { n: s.activeRestaurants }))}
        ${stat(t('adm.dash.pendingApproval'), s.pendingRestaurants, html`<a data-nav href="/admin/restaurants">${t('adm.dash.review')}</a>`)}
        ${stat(t('adm.dash.suspended'), s.suspendedRestaurants)}
        ${stat(t('adm.dash.customers'), s.totalCustomers)}
        ${stat(t('adm.dash.totalOrders'), s.totalOrders)}
        ${stat(t('adm.dash.todaysOrders'), s.todaysOrders)}
        ${stat(t('adm.dash.monthlyOrders'), s.monthlyOrders)}
        ${stat(t('adm.dash.gross'), m(s.grossRevenueCents), t('adm.dash.grossSub'))}
        ${stat(t('adm.dash.commission'), m(s.platformCommissionCents), t('adm.dash.commissionSub'))}
        ${stat(t('adm.dash.earnings'), m(s.restaurantEarningsCents), t('adm.dash.earningsSub'))}
        ${stat(t('adm.dash.subRevenue'), m(s.subscriptionRevenueCents), t('adm.dash.subRevenueSub'))}
        ${stat(t('adm.dash.openReports'), s.openReports)}
        ${stat(t('adm.dash.pendingPayouts'), m(s.pendingPayoutsCents), t('adm.dash.statements', { n: s.pendingPayouts }))}
        ${stat(t('adm.dash.completedPayouts'), m(s.completedPayoutsCents), t('adm.dash.statements', { n: s.completedPayouts }))}
      </div>
      <div class="grid cols-2" style="margin-top:1rem">
        ${barChart(t('adm.dash.revenueOverTime'), series.orders, 'revenueCents', { format: m, note: t('adm.dash.orderValue') })}
        ${barChart(t('adm.dash.ordersOverTime'), series.orders, 'orders')}
        ${barChart(t('adm.dash.commission'), series.orders, 'commissionCents', { format: m })}
        ${barChart(t('adm.dash.payoutsCompleted'), series.payouts, 'amountCents', { format: m })}
        ${barChart(t('adm.dash.restaurantGrowth'), series.restaurants, 'added', { note: t('adm.dash.newRestaurantsPerDay') })}
        ${barChart(t('adm.dash.customerGrowth'), series.customers, 'added', { note: t('adm.dash.newCustomersPerDay') })}
      </div>
      <div class="card" style="margin-top:1rem"><h3>${t('adm.nav.subscriptions')}</h3><p>${Object.entries(s.subscriptionsByStatus).map(([k, v]) => `${subStatus(k)}: ${v}`).join(' · ') || t('adm.dash.noSubscriptions')}</p></div>`);
    $('#days').addEventListener('change', (e) => { state.dashDays = e.target.value; route(); });
  },

  restaurants: (panel) => listView(panel, 'restaurants', {
    filtersHtml: (f) => html`<div class="field"><label for="f-q">${t('adm.search')}</label><input id="f-q" name="q" value="${f.q || ''}" placeholder="${t('adm.rest.searchPh')}"></div>
      ${select('approval', t('adm.rest.approval'), [ALL(), ['pending', approval('pending')], ['approved', approval('approved')], ['rejected', approval('rejected')]], f.approval)}`,
    load: (f) => api(`/admin/restaurants${qs(f)}`),
    table: ({ restaurants }) => (restaurants.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('adm.rest.restaurant')}</th><th>${t('adm.rest.owner')}</th><th>${t('adm.rest.approval')}</th><th>${t('adm.rest.plan')}</th><th class="num">${t('adm.col.orders')}</th><th>${t('adm.col.created')}</th><th></th></tr></thead><tbody>
      ${restaurants.map((r) => html`<tr><td><strong>${r.name}</strong> ${r.isDemo ? html`<span class="badge demo">${t('rest.sample')}</span>` : ''}<div class="muted small">${tech(r.slug)}${r.city ? ` · ${r.city}` : ''}</div></td>
        <td>${r.ownerEmail ? tech(r.ownerEmail) : '—'}</td>
        <td>${badge(r.approvalStatus === 'approved' ? 'active' : r.approvalStatus === 'rejected' ? 'cancelled' : 'pending', approval(r.approvalStatus))} ${r.isActive ? '' : html`<span class="badge nocap suspended">${t('adm.rest.suspended')}</span>`}${r.rejectionReason ? html`<div class="muted small">${r.rejectionReason}</div>` : ''}</td>
        <td>${r.planName || '—'} ${r.subscriptionStatus ? badge(statusTone(r.subscriptionStatus), subStatus(r.subscriptionStatus)) : ''}${r.commissionBpOverride !== null ? html`<div class="muted small">${t('adm.rest.commissionOverride', { n: r.commissionBpOverride / 100 })}</div>` : ''}</td>
        <td class="num">${r.orders}</td><td>${fmtDay(r.createdAt)}</td>
        <td class="right"><button class="btn secondary sm" data-detail="${r.id}">${t('adm.view')}</button>
          ${r.approvalStatus !== 'approved' ? html`<button class="btn sm" data-approve="${r.id}">${t('adm.rest.approve')}</button>` : ''}
          ${r.approvalStatus === 'pending' ? html`<button class="btn danger sm" data-reject="${r.id}">${t('adm.rest.reject')}</button>` : ''}
          ${r.approvalStatus === 'approved' ? (r.isActive ? html`<button class="btn danger sm" data-suspend="${r.id}">${t('adm.rest.suspend')}</button>` : html`<button class="btn sm" data-reactivate="${r.id}">${t('adm.rest.activate')}</button>`) : ''}</td></tr>`)}</tbody></table></div>` : emptyState(t('adm.rest.none'))),
    onAction: async (e, draw) => {
      const id = (k) => e.target.closest(`[data-${k}]`)?.dataset[k];
      if (id('approve')) { await api(`/admin/restaurants/${id('approve')}/approve`, { method: 'POST', body: {} }); toast(t('adm.rest.approved'), 'ok'); draw(); }
      if (id('reject')) { const reason = await promptDialog(t('adm.rest.rejectReason'), { confirmLabel: t('adm.rest.reject') }); if (reason) { await api(`/admin/restaurants/${id('reject')}/reject`, { method: 'POST', body: { reason } }); toast(t('adm.rest.rejected'), 'ok'); draw(); } }
      if (id('suspend')) { const reason = await promptDialog(t('adm.rest.suspendReason'), { confirmLabel: t('adm.rest.suspend') }); if (reason) { await api(`/admin/restaurants/${id('suspend')}/suspend`, { method: 'POST', body: { reason } }); toast(t('adm.rest.suspendedToast'), 'ok'); draw(); } }
      if (id('reactivate')) { await api(`/admin/restaurants/${id('reactivate')}/reactivate`, { method: 'POST', body: {} }); toast(t('adm.rest.activated'), 'ok'); draw(); }
      if (id('detail')) restaurantDetail(Number(id('detail')), draw);
    },
  }),

  users: (panel) => listView(panel, 'users', {
    filtersHtml: (f) => html`<div class="field"><label for="f-q">${t('adm.search')}</label><input id="f-q" name="q" value="${f.q || ''}" placeholder="${t('adm.users.searchPh')}"></div>
      ${select('role', t('adm.users.role'), [ALL(), ['customer', t('adm.users.roleCustomers')], ['owner', t('adm.users.roleOwners')], ['staff', t('adm.users.roleStaff')], ['super_admin', t('adm.users.roleAdmins')]], f.role)}
      ${select('status', t('adm.col.status'), [ALL(), ['active', t('team.active')], ['disabled', t('team.disabled')]], f.status)}`,
    load: (f) => api(`/admin/users${qs(f)}`),
    table: ({ users }) => (users.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('cust.name')}</th><th>${t('cust.email')}</th><th>${t('adm.users.role')}</th><th class="num">${t('adm.col.orders')}</th><th>${t('adm.col.status')}</th><th>${t('adm.col.joined')}</th><th></th></tr></thead><tbody>
      ${users.map((u) => html`<tr><td>${u.name}</td><td>${tech(u.email)}</td><td>${label('role', u.role)}</td><td class="num">${u.orders}</td><td>${badge(u.status === 'active' ? 'active' : 'cancelled', u.status === 'active' ? t('team.active') : t('team.disabled'))}</td><td>${fmtDay(u.createdAt)}</td>
        <td class="right"><button class="btn ${u.status === 'active' ? 'danger' : ''} sm" data-user-toggle="${u.id}" data-active="${u.status === 'active'}" data-name="${u.name}">${u.status === 'active' ? t('team.disable') : t('team.enable')}</button></td></tr>`)}</tbody></table></div>` : emptyState(t('adm.users.none'))),
    onAction: async (e, draw) => {
      const tg = e.target.closest('[data-user-toggle]');
      if (!tg) return;
      const active = tg.dataset.active === 'true';
      if (active && !await confirmDialog(t('adm.users.disableConfirm', { name: tg.dataset.name }), { confirmLabel: t('team.disable'), danger: true })) return;
      await api(`/admin/users/${tg.dataset.userToggle}`, { method: 'PATCH', body: { isActive: !active } }); toast(active ? t('adm.users.disabled') : t('adm.users.enabled'), 'ok'); draw();
    },
  }),

  customers: (panel) => listView(panel, 'customers', {
    filtersHtml: (f) => html`<div class="field"><label for="f-q">${t('adm.search')}</label><input id="f-q" name="q" value="${f.q || ''}" placeholder="${t('adm.users.searchPh')}"></div>`,
    load: (f) => api(`/admin/customers${qs(f)}`),
    table: ({ customers }) => (customers.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('role.customer')}</th><th>${t('cust.email')}</th><th class="num">${t('adm.col.orders')}</th><th class="num">${t('cust.spent')}</th><th class="num">${t('adm.nav.restaurants')}</th><th>${t('adm.col.status')}</th><th>${t('adm.col.joined')}</th><th></th></tr></thead><tbody>
      ${customers.map((c) => html`<tr><td>${c.name}</td><td>${tech(c.email)}</td><td class="num">${c.orders}</td><td class="num">${m(c.spentCents)}</td><td class="num">${c.restaurants}</td><td>${badge(c.status === 'active' ? 'active' : 'cancelled', c.status === 'active' ? t('team.active') : t('team.disabled'))}</td><td>${fmtDay(c.createdAt)}</td>
        <td class="right"><button class="btn secondary sm" data-user-orders="${c.id}">${t('adm.col.orders')}</button></td></tr>`)}</tbody></table></div>` : emptyState(t('cust.none'), t('adm.cust.noneText'))),
    onAction: async (e) => {
      const o = e.target.closest('[data-user-orders]');
      if (!o) return;
      const { orders } = await api(`/admin/users/${o.dataset.userOrders}/orders`);
      dialog(t('adm.cust.ordersTitle'), orders.length ? html`<div class="table-wrap"><table><tbody>${orders.map((x) => html`<tr><td>#${x.orderNumber} ${x.restaurantName}</td><td>${statusLabel(x.status)}</td><td class="num">${m(x.totalCents)}</td></tr>`)}</tbody></table></div>` : html`<p>${t('adm.cust.noOrders')}</p>`);
    },
  }),

  orders: (panel) => listView(panel, 'orders', {
    filtersHtml: (f) => html`<div class="field"><label for="f-q">${t('adm.search')}</label><input id="f-q" name="q" value="${f.q || ''}" placeholder="${t('adm.orders.searchPh')}"></div>
      ${select('status', t('adm.col.status'), [ALL(), ...['awaiting_payment', 'pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled', 'rejected'].map((s) => [s, statusLabel(s)])], f.status)}
      <div class="field"><label for="f-restaurantId">${t('adm.orders.restaurantId')}</label><input id="f-restaurantId" name="restaurantId" inputmode="numeric" dir="ltr" value="${f.restaurantId || ''}"></div>
      <div class="field"><label for="f-from">${t('adm.from')}</label><input id="f-from" name="from" type="date" dir="ltr" value="${f.from || ''}"></div>
      <div class="field"><label for="f-to">${t('adm.to')}</label><input id="f-to" name="to" type="date" dir="ltr" value="${f.to || ''}"></div>`,
    load: (f) => api(`/admin/orders${qs(f)}`),
    table: ({ orders }) => (orders.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('fin.col.order')}</th><th>${t('adm.rest.restaurant')}</th><th>${t('role.customer')}</th><th>${t('order.payment')}</th><th class="num">${t('cart.total')}</th><th>${t('adm.col.status')}</th><th>${t('adm.col.created')}</th><th></th></tr></thead><tbody>
      ${orders.map((o) => html`<tr><td>#${o.orderNumber}</td><td>${o.restaurantName}</td><td>${o.customerName}</td>
        <td>${o.paymentMethod === 'cod' ? html`<span class="badge nocap warn">${t('fin.method.cod')}</span>` : html`<span class="badge nocap info">${t('fin.method.card')}</span>`} <div class="muted small">${payLabel(o.paymentStatus)}</div></td>
        <td class="num">${m(o.totalCents)}</td><td>${badge(o.status === 'delivered' ? 'completed' : o.status, statusLabel(o.status))}</td><td>${fmtDate(o.createdAt)}</td>
        <td class="right"><button class="btn secondary sm" data-order="${o.id}">${t('adm.details')}</button>${['delivered', 'cancelled', 'rejected', 'awaiting_payment'].includes(o.status) ? '' : html` <button class="btn danger sm" data-order-cancel="${o.id}">${t('common.cancel')}</button>`}</td></tr>`)}</tbody></table></div>` : emptyState(t('adm.orders.none'))),
    onAction: async (e, draw) => {
      const d = e.target.closest('[data-order]');
      if (d) await orderDetail(Number(d.dataset.order));
      const c = e.target.closest('[data-order-cancel]');
      if (c) {
        const reason = await promptDialog(t('adm.orders.cancelReason'), { confirmLabel: t('order.cancel') });
        if (reason) { await api(`/admin/orders/${c.dataset.orderCancel}/cancel`, { method: 'POST', body: { reason } }); toast(t('adm.orders.cancelled'), 'ok'); draw(); }
      }
    },
  }),

  payments: (panel) => listView(panel, 'payments', {
    filtersHtml: (f) => html`<div class="field"><label for="f-q">${t('adm.search')}</label><input id="f-q" name="q" value="${f.q || ''}" placeholder="${t('adm.pay.searchPh')}"></div>
      ${select('method', t('fin.col.method'), [ALL(), ['card', t('fin.method.card')], ['cod', t('fin.method.cod')]], f.method)}
      ${select('status', t('adm.col.status'), [ALL(), ...['pending', 'succeeded', 'failed', 'cancelled', 'cod_pending', 'cash_collected', 'refunded', 'partially_refunded'].map((s) => [s, label('pstat', s)])], f.status)}
      <div class="field"><label for="f-from">${t('adm.from')}</label><input id="f-from" name="from" type="date" dir="ltr" value="${f.from || ''}"></div>
      <div class="field"><label for="f-to">${t('adm.to')}</label><input id="f-to" name="to" type="date" dir="ltr" value="${f.to || ''}"></div>`,
    load: (f) => api(`/admin/payments${qs(f)}`),
    table: ({ payments }) => (payments.length ? html`<div class="alert info small">${t('adm.pay.note')}</div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>${t('fin.col.order')}</th><th>${t('adm.rest.restaurant')}</th><th>${t('fin.col.method')}</th><th>${t('adm.col.status')}</th><th class="num">${t('fin.col.amount')}</th><th class="num">${t('fin.col.refunded')}</th><th>${t('adm.col.providerRef')}</th><th></th></tr></thead><tbody>
      ${payments.map((p) => html`<tr><td>${p.id}</td><td>#${p.orderNumber}</td><td>${p.restaurant}</td>
        <td>${p.method === 'cod' ? html`<span class="badge nocap warn">${t('adm.pay.cash')}</span>` : (p.source ? t('fin.method.cardVia', { source: p.source }) : t('fin.method.card'))}</td>
        <td><span class="badge nocap ${statusTone(p.status)}">${label('pstat', p.status)}</span>${p.failureReason ? html`<div class="muted small">${p.failureReason}</div>` : ''}</td>
        <td class="num">${m(p.amountCents)}</td><td class="num">${p.refundedCents ? m(p.refundedCents) : '—'}</td><td class="small">${p.providerRef ? tech(p.providerRef) : '—'}</td>
        <td class="right">${p.method === 'card' && ['succeeded', 'partially_refunded'].includes(p.status) ? html`<button class="btn danger sm" data-refund="${p.id}" data-left="${p.amountCents - p.refundedCents}">${t('adm.pay.refund')}</button>` : ''}${p.method === 'card' && ['pending', 'initiated', 'failed'].includes(p.status) ? html` <button class="btn secondary sm" data-reconcile="${p.id}">${t('adm.pay.recheck')}</button>` : ''}</td></tr>`)}</tbody></table></div>` : emptyState(t('adm.pay.none'))),
    onAction: async (e, draw) => {
      const rf = e.target.closest('[data-refund]');
      if (rf) {
        const left = Number(rf.dataset.left);
        const amount = await promptDialog(t('adm.pay.refundAmount', { currency, max: fromCents(left) }), { confirmLabel: t('adm.next'), placeholder: fromCents(left) });
        if (!amount) return;
        const cents = toCents(amount);
        if (Number.isNaN(cents) || cents < 1 || cents > left) return toast(t('adm.pay.refundInvalid'), 'err');
        const reason = await promptDialog(t('adm.pay.refundReason'), { confirmLabel: t('adm.pay.refund') });
        if (!reason) return;
        const key = `rf_${crypto.randomUUID().replace(/-/g, '')}`; // one key per confirmed action: a double click cannot refund twice
        const r = await api(`/admin/payments/${rf.dataset.refund}/refund`, { method: 'POST', body: { amountCents: cents, reason }, headers: { 'Idempotency-Key': key } });
        toast(t('adm.pay.refundResult', { status: label('adm.refund', r.refund.status) }), r.refund.status === 'failed' ? 'err' : 'ok'); draw();
      }
      const rc = e.target.closest('[data-reconcile]');
      if (rc) { const r = await api(`/admin/payments/${rc.dataset.reconcile}/reconcile`, { method: 'POST', body: {} }); toast(t('adm.pay.providerSays', { status: label('pstat', r.status) })); draw(); }
    },
  }),

  async refunds(panel) {
    const st = state.refunds ||= { status: '' };
    const { refunds } = await api(`/admin/refunds${qs({ status: st.status })}`);
    render(panel, html`<form class="filters" id="rf">${select('status', t('adm.col.status'), [ALL(), ['pending', label('adm.refund', 'pending')], ['succeeded', label('adm.refund', 'succeeded')], ['failed', label('adm.refund', 'failed')]], st.status)}<button class="btn sm" type="submit">${t('adm.filter')}</button></form>
      ${refunds.length ? html`<div class="table-wrap"><table><thead><tr><th>#</th><th>${t('fin.col.order')}</th><th>${t('adm.rest.restaurant')}</th><th class="num">${t('fin.col.amount')}</th><th>${t('adm.col.status')}</th><th>${t('adm.col.reason')}</th><th>${t('adm.col.providerRef')}</th><th>${t('adm.col.created')}</th></tr></thead><tbody>
        ${refunds.map((f) => html`<tr><td>${f.id}</td><td>#${f.orderNumber}</td><td>${f.restaurant}</td><td class="num">${m(f.amountCents)}</td><td><span class="badge nocap ${statusTone(f.status === 'succeeded' ? 'succeeded' : f.status)}">${label('adm.refund', f.status)}</span>${f.failureReason ? html`<div class="muted small">${f.failureReason}</div>` : ''}</td><td>${f.reason}</td><td class="small">${f.providerRefundId ? tech(f.providerRefundId) : '—'}</td><td>${fmtDate(f.createdAt)}</td></tr>`)}</tbody></table></div>` : emptyState(t('adm.refunds.none'), t('adm.refunds.noneText'))}`);
    $('#rf').addEventListener('submit', (e) => { e.preventDefault(); st.status = new FormData(e.target).get('status'); route(); });
  },

  async payouts(panel) {
    const [{ balances }, { payouts, capabilities: caps }, fin] = await Promise.all([api('/admin/balances'), api('/admin/payouts'), api('/admin/finance/restaurants')]);
    const tapModel = fin.settlementModel === 'TAP_SETTLEMENT';
    const accountStatus = (s) => label('adm.acct', s);
    render(panel, html`<div class="toolbar"><h2>${t('adm.payouts.balances')}</h2>
      <div class="actions-row">${tapModel ? html`<button class="btn secondary" data-sync-settlements>${t('adm.payouts.syncTap')}</button>` : ''}<button class="btn secondary" data-generate>${t('adm.payouts.generate')}</button><a class="btn secondary" href="/api/admin/reports/payouts?format=csv" download>${t('adm.payouts.exportCsv')}</a></div></div>
      <p class="muted small">${t('adm.payouts.weeklyNote')}</p>
      ${balances.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('adm.rest.restaurant')}</th><th class="num">${t('fin.available')}</th><th class="num">${t('adm.payouts.pendingDelivery')}</th><th class="num">${t('adm.payouts.inPayout')}</th><th class="num">${t('adm.payouts.paid')}</th><th class="num">${t('adm.payouts.cashDue')}</th><th></th></tr></thead><tbody>
        ${balances.map((b) => html`<tr><td>${b.restaurant}</td><td class="num">${m(b.availableCents)}</td><td class="num">${m(b.pendingCents)}</td><td class="num">${m(b.inPayoutCents)}</td><td class="num">${m(b.paidCents)}</td><td class="num">${m(b.codCommissionDueCents)}</td>
          <td class="right">${b.codCommissionDueCents > 0 ? html`<button class="btn secondary sm" data-cod="${b.restaurantId}" data-name="${b.restaurant}">${t('adm.payouts.markCollected')}</button>` : ''}</td></tr>`)}</tbody></table></div>` : emptyState(t('adm.payouts.noRestaurants'))}
      <h2 style="margin-top:1.5rem">${tapModel ? t('adm.payouts.financeTap') : t('adm.payouts.finance')}</h2>
      ${fin.restaurants.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('adm.rest.restaurant')}</th><th class="num">${t('adm.payouts.grossSales')}</th><th class="num">${t('fin.col.commission')}</th><th class="num">${t('fin.refunds')}</th><th class="num">${t('fin.net')}</th><th>${t('adm.payouts.destinationId')}</th><th>${t('adm.payouts.settlement')}</th><th>${t('adm.payouts.currency')}</th><th>${t('adm.payouts.lastTapPayment')}</th><th>${t('adm.payouts.lastTapSettlement')}</th></tr></thead><tbody>
        ${fin.restaurants.map((r) => html`<tr><td>${r.restaurant}</td><td class="num">${m(r.grossSalesCents)}</td><td class="num">${m(r.commissionCents)}</td><td class="num">${m(r.refundsCents)}</td><td class="num"><strong>${m(r.netEarningsCents)}</strong></td>
          <td class="small">${r.destinationId ? html`<code>${r.destinationId}</code>` : '—'}<div class="muted">${accountStatus(r.accountStatus)}</div></td><td><span class="badge nocap ${r.settlementStatus === 'PAID_BY_TAP' ? 'ok' : r.settlementStatus === 'FAILED' ? 'err' : 'warn'}">${label('fin.settle', r.settlementStatus)}</span></td>
          <td>${r.settlementCurrency || '—'}</td><td class="small">${r.lastTapPaymentId ? html`<code>${r.lastTapPaymentId}</code>` : '—'}</td><td class="small">${r.lastTapSettlementId ? html`<code>${r.lastTapSettlementId}</code><div class="muted">${r.lastTapSettlementAmount || ''}</div>` : '—'}</td></tr>`)}</tbody></table></div>` : emptyState(t('adm.payouts.noRestaurants'))}
      <p class="muted small">${tapModel ? t('adm.payouts.tapNote') : ''}</p>
      <h2 style="margin-top:1.5rem">${tapModel ? t('fin.weeklyStatements') : t('fin.weeklyPayouts')}</h2>
      <div class="alert info small">${t('adm.payouts.paidNote')} ${caps.createPayout === 'NOT_SUPPORTED' ? t('adm.payouts.capNotSupported') : caps.createPayout === 'NOT_VERIFIED' ? t('adm.payouts.capNotVerified') : t('adm.payouts.capAvailable')}</div>
      ${payouts.length ? html`<div class="table-wrap"><table><thead><tr><th>#</th><th>${t('adm.rest.restaurant')}</th><th>${t('fin.col.period')}</th><th class="num">${t('fin.col.gross')}</th><th class="num">${t('fin.col.commission')}</th><th class="num">${t('fin.refunds')}</th><th class="num">${t('adm.payouts.net')}</th><th>${t('adm.col.status')}</th><th>${t('adm.payouts.refAccount')}</th><th></th></tr></thead><tbody>
        ${payouts.map((p) => html`<tr><td>${p.id}</td><td>${p.restaurant}</td><td>${dateRange(p.periodStart, p.periodEnd)}<div class="muted small">${p.currency}${p.settlementCurrency && p.settlementCurrency !== p.currency ? ` → ${t('adm.payouts.settles', { currency: p.settlementCurrency })}` : ''}</div></td>
          <td class="num">${m(p.grossCents)}</td><td class="num">${m(p.commissionCents)}</td><td class="num">${m(p.refundsCents)}</td><td class="num"><strong>${m(p.netCents)}</strong></td>
          <td><span class="badge nocap ${p.status === 'paid' ? 'ok' : ['failed', 'reversed'].includes(p.status) ? 'err' : p.status === 'cancelled' ? '' : 'warn'}">${label('payout.status', p.status)}</span>${p.status === 'paid' ? html`<div class="muted small">${p.confirmationSource === 'provider' ? t('fin.confirmedByProvider') : t('fin.confirmedManual')}</div>` : ''}${p.failureReason ? html`<div class="muted small">${p.failureReason}</div>` : ''}</td>
          <td class="small">${p.reference ? tech(String(p.reference).replace(/^manual:/, 'manual: ')) : '—'}<div class="muted">${p.providerAccountId ? t('adm.payouts.acct', { id: p.providerAccountId }) : t('adm.payouts.noAcct')}</div></td>
          <td class="right">${{
    pending: html`<button class="btn secondary sm" data-payout="${p.id}" data-to="manual_payout">${t('adm.payouts.manual')}</button> <button class="btn secondary sm" data-payout="${p.id}" data-to="cancelled">${t('common.cancel')}</button>`,
    eligible: html`${/^(IMPLEMENTED|VERIFIED)/.test(caps.createPayout || '') ? html`<button class="btn sm" data-request="${p.id}">${t('adm.payouts.requestProvider')}</button> ` : ''}<button class="btn secondary sm" data-payout="${p.id}" data-to="manual_payout">${t('adm.payouts.manual')}</button> <button class="btn secondary sm" data-payout="${p.id}" data-to="cancelled">${t('common.cancel')}</button>`,
    manual_payout: html`<button class="btn sm" data-payout="${p.id}" data-to="paid">${t('adm.payouts.recordTransfer')}</button> <button class="btn danger sm" data-payout="${p.id}" data-to="failed">${t('adm.payouts.markFailedBtn')}</button>`,
    failed: html`<button class="btn sm" data-payout="${p.id}" data-to="pending">${t('adm.payouts.retry')}</button> <button class="btn secondary sm" data-payout="${p.id}" data-to="cancelled">${t('common.cancel')}</button>` }[p.status] || ''}</td></tr>`)}</tbody></table></div>` : emptyState(t('fin.noPayouts'))}`);
    panel.onclick = async (e) => {
      try {
        if (e.target.closest('[data-generate]')) {
          const r = await api('/admin/payouts/generate', { method: 'POST', body: {} });
          toast(t('adm.payouts.generated', { n: r.created.length, from: r.period.periodStart, to: r.period.periodEnd }), 'ok'); route();
        }
        const cod = e.target.closest('[data-cod]');
        if (cod && await confirmDialog(t('adm.payouts.codConfirm', { name: cod.dataset.name }), { confirmLabel: t('adm.record') })) {
          await api(`/admin/restaurants/${cod.dataset.cod}/cod-settlement`, { method: 'POST', body: {} }); toast(t('adm.recorded'), 'ok'); route();
        }
        if (e.target.closest('[data-sync-settlements]')) {
          const r = (await api('/admin/settlements/sync', { method: 'POST', body: {} })).sync; toast(t('adm.payouts.synced', { fetched: r.fetched, matched: r.matched }), 'ok'); route();
        }
        const rq = e.target.closest('[data-request]');
        if (rq && await confirmDialog(t('adm.payouts.requestConfirm'), { confirmLabel: t('adm.payouts.requestPayout') })) {
          await api(`/admin/payouts/${rq.dataset.request}/request`, { method: 'POST', body: {} }); toast(t('adm.payouts.requested'), 'ok'); route();
        }
        const p = e.target.closest('[data-payout]');
        if (p) {
          const body = { status: p.dataset.to };
          if (p.dataset.to === 'manual_payout' && !await confirmDialog(t('adm.payouts.manualConfirm'), { confirmLabel: t('adm.payouts.manual') })) return;
          if (p.dataset.to === 'paid') { body.reference = await promptDialog(t('adm.payouts.transferRef'), { confirmLabel: t('adm.payouts.recordPaid') }); if (!body.reference) return; }
          if (p.dataset.to === 'failed') { body.failureReason = await promptDialog(t('adm.payouts.whyFailed'), { confirmLabel: t('adm.payouts.markFailed') }); if (!body.failureReason) return; }
          await api(`/admin/payouts/${p.dataset.payout}`, { method: 'PATCH', body }); toast(t('adm.payouts.payoutSet', { status: label('payout.status', p.dataset.to) }), 'ok'); route();
        }
      } catch (err) { toast(err, 'err'); }
    };
  },

  async subscriptions(panel) {
    const st = state.subscriptions ||= { page: 1, f: {} };
    const [list, { invoices }] = await Promise.all([api(`/admin/subscriptions${qs({ ...st.f, page: st.page })}`), api('/admin/invoices?status=open')]);
    render(panel, html`<div class="alert info small">${t('adm.subs.note')}</div>
      <form class="filters" id="filters"><div class="field"><label for="f-q">${t('adm.search')}</label><input id="f-q" name="q" value="${st.f.q || ''}" placeholder="${t('adm.subs.searchPh')}"></div>
        ${select('status', t('adm.col.status'), [ALL(), ...['trialing', 'active', 'past_due', 'cancelled', 'expired', 'suspended'].map((s) => [s, subStatus(s)])], st.f.status)}<button class="btn sm" type="submit">${t('adm.filter')}</button></form>
      ${list.subscriptions.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('adm.rest.restaurant')}</th><th>${t('adm.rest.plan')}</th><th>${t('adm.col.status')}</th><th class="num">${t('adm.subs.price')}</th><th>${t('adm.subs.renews')}</th><th>${t('adm.subs.trialEnds')}</th><th></th></tr></thead><tbody>
        ${list.subscriptions.map((s) => html`<tr><td>${s.restaurant}<div class="muted small">${tech(s.slug)}</div></td><td>${s.plan}</td><td><span class="badge nocap ${statusTone(s.status)}">${subStatus(s.status)}</span>${s.cancelledAt ? html`<div class="muted small">${t('adm.subs.endsNoRenew')}</div>` : ''}</td>
          <td class="num">${s.priceCents ? t('sub.price', { amount: m(s.priceCents), interval: label('sub.interval', s.billingInterval) }) : t('sub.free')}</td><td>${s.endDate ? fmtDay(s.endDate) : '—'}</td><td>${s.trialEnd ? fmtDay(s.trialEnd) : '—'}</td>
          <td class="right"><button class="btn secondary sm" data-detail="${s.restaurantId}">${t('adm.subs.manage')}</button>${s.openInvoices ? html` <span class="badge nocap warn">${t('adm.subs.openInvoices', { n: s.openInvoices })}</span>` : ''}</td></tr>`)}</tbody></table></div>${pager(list.total, st.page)}` : emptyState(t('adm.subs.none'))}
      <h3 style="margin-top:1.5rem">${t('adm.subs.openInvoicesTitle')}</h3>
      ${invoices.length ? html`<div class="table-wrap"><table><thead><tr><th>#</th><th>${t('adm.rest.restaurant')}</th><th>${t('adm.rest.plan')}</th><th class="num">${t('fin.col.amount')}</th><th>${t('fin.col.period')}</th><th></th></tr></thead><tbody>
        ${invoices.map((i) => html`<tr><td>${i.id}</td><td>${i.restaurant}</td><td>${i.plan}</td><td class="num">${m(i.amountCents)}</td><td>${dateRange(fmtDay(i.periodStart), fmtDay(i.periodEnd))}</td>
          <td class="right"><button class="btn sm" data-mark-paid="${i.id}">${t('adm.subs.markPaid')}</button> <button class="btn secondary sm" data-void="${i.id}">${t('adm.subs.void')}</button></td></tr>`)}</tbody></table></div>` : emptyState(t('adm.subs.noOpen'))}`);
    $('#filters').addEventListener('submit', (e) => { e.preventDefault(); st.f = Object.fromEntries(new FormData(e.target)); st.page = 1; route(); });
    panel.onclick = async (e) => {
      try {
        const pg = e.target.closest('[data-page]');
        if (pg) { st.page = Number(pg.dataset.page); return route(); }
        const d = e.target.closest('[data-detail]');
        if (d) return restaurantDetail(Number(d.dataset.detail), route);
        const mp = e.target.closest('[data-mark-paid]');
        if (mp) {
          const reference = await promptDialog(t('adm.subs.payRef'), { confirmLabel: t('adm.subs.markPaidShort') });
          if (reference) { await api(`/admin/invoices/${mp.dataset.markPaid}/mark-paid`, { method: 'POST', body: { reference } }); toast(t('adm.subs.markedPaid'), 'ok'); route(); }
        }
        const v = e.target.closest('[data-void]');
        if (v && await confirmDialog(t('adm.subs.voidConfirm'), { confirmLabel: t('adm.subs.void'), danger: true })) { await api(`/admin/invoices/${v.dataset.void}/void`, { method: 'POST', body: {} }); route(); }
      } catch (err) { toast(err, 'err'); }
    };
  },

  async plans(panel) {
    const { plans } = await api('/admin/plans');
    render(panel, html`<div class="toolbar"><p class="muted small" style="margin:0">${t('adm.plans.note')}</p><button class="btn" data-new>${t('adm.plans.new')}</button></div>
      <div class="table-wrap"><table><thead><tr><th>${t('adm.rest.plan')}</th><th class="num">${t('adm.subs.price')}</th><th>${t('adm.plans.trial')}</th><th class="num">${t('adm.plans.products')}</th><th class="num">${t('adm.plans.staff')}</th><th class="num">${t('adm.plans.ordersMonth')}</th><th>${t('adm.plans.features')}</th><th class="num">${t('adm.nav.restaurants')}</th><th>${t('adm.col.status')}</th><th></th></tr></thead><tbody>
      ${plans.map((p) => html`<tr><td><strong>${p.name}</strong><div class="muted small">${tech(p.code)}</div></td><td class="num">${p.priceCents ? t('sub.price', { amount: m(p.priceCents), interval: label('sub.interval', p.billingInterval) }) : t('sub.free')}</td><td>${p.trialDays ? t('adm.plans.days', { n: p.trialDays }) : '—'}</td>
        <td class="num">${p.maxMenuItems ?? '∞'}</td><td class="num">${p.maxStaff ?? '∞'}</td><td class="num">${p.maxOrdersPerMonth ?? '∞'}</td>
        <td class="small">${[p.analytics ? t('adm.plans.analytics') : '', p.advancedReports ? t('adm.plans.advanced') : ''].filter(Boolean).join(t('adm.listSep')) || '—'}</td><td class="num">${p.restaurants}</td>
        <td>${badge(p.isActive ? 'active' : 'cancelled', p.isActive ? t('team.active') : t('adm.plans.inactive'))}</td><td class="right"><button class="btn secondary sm" data-edit="${p.code}">${t('common.edit')}</button></td></tr>`)}</tbody></table></div>`);
    panel.onclick = (e) => {
      if (e.target.closest('[data-new]')) planDialog(null);
      const ed = e.target.closest('[data-edit]');
      if (ed) planDialog(plans.find((p) => p.code === ed.dataset.edit));
    };
  },

  async reports(panel) {
    const types = ['revenue', 'orders', 'restaurants', 'customers', 'payments', 'commissions', 'payouts', 'refunds', 'cod', 'finance'].map((k) => [k, t(`adm.report.${k}`)]);
    const st = state.reports ||= { type: 'revenue', from: '', to: '' };
    const data = await api(`/admin/reports/${st.type}${qs({ from: st.from, to: st.to })}`);
    render(panel, html`<form class="filters" id="rf">${select('type', t('adm.reports.report'), types, st.type)}
      <div class="field"><label for="f-from">${t('adm.from')}</label><input id="f-from" name="from" type="date" dir="ltr" value="${st.from}"></div>
      <div class="field"><label for="f-to">${t('adm.to')}</label><input id="f-to" name="to" type="date" dir="ltr" value="${st.to}"></div>
      <button class="btn sm" type="submit">${t('adm.reports.run')}</button>
      <a class="btn secondary sm" href="/api/admin/reports/${st.type}${qs({ from: st.from, to: st.to, format: 'csv' })}" download>${t('rep.exportCsv')}</a></form>
      ${data.rows.length ? html`<div class="table-wrap"><table><thead><tr>${data.columns.map((c) => html`<th class="${c.money ? 'num' : ''}">${has(`adm.rcol.${c.key}`) ? t(`adm.rcol.${c.key}`) : c.label}</th>`)}</tr></thead><tbody>
        ${data.rows.slice(0, 500).map((r) => html`<tr>${data.columns.map((c) => html`<td class="${c.money ? 'num' : ''}">${c.money ? m(r[c.key]) : (r[c.key] ?? '—')}</td>`)}</tr>`)}</tbody></table></div>
        ${data.rows.length > 500 ? html`<p class="muted small">${t('adm.reports.first500')}</p>` : ''}` : emptyState(t('adm.reports.noData'))}`);
    $('#rf').addEventListener('submit', (e) => { e.preventDefault(); Object.assign(st, Object.fromEntries(new FormData(e.target))); route(); });
  },

  async support(panel) {
    const st = state.support ||= { status: 'open' };
    const { reports } = await api(`/admin/support-reports${qs({ status: st.status })}`);
    const statuses = ['open', 'in_progress', 'resolved', 'closed'].map((s) => [s, label('report.status', s)]);
    render(panel, html`<form class="filters" id="sf">${select('status', t('adm.col.status'), [ALL(), ...statuses], st.status)}<button class="btn sm" type="submit">${t('adm.filter')}</button></form>
      ${reports.length ? html`<div class="grid">${reports.map((r) => html`<article class="card"><div class="toolbar" style="margin-bottom:.25rem"><div><strong>${r.subject}</strong> <span class="badge nocap ${r.priority === 'high' || r.priority === 'urgent' ? 'err' : ''}">${label('adm.priority', r.priority)}</span></div><span class="badge nocap ${r.status === 'resolved' || r.status === 'closed' ? 'ok' : 'warn'}">${label('report.status', r.status)}</span></div>
        <div class="muted small">${label('report.cat', r.category)} · ${r.user} (${tech(r.userEmail)})${r.restaurant ? ` · ${r.restaurant}` : ''}${r.orderId ? ` · ${t('adm.support.orderRef', { id: r.orderId })}` : ''} · ${fmtDate(r.createdAt)}</div>
        <p>${r.description}</p>${r.adminResponse ? html`<div class="alert info small"><strong>${t('adm.support.reply')}</strong> ${r.adminResponse}</div>` : ''}
        <form data-report="${r.id}" class="filters" novalidate>${select('status', t('adm.col.status'), statuses, r.status)}
          ${select('priority', t('adm.support.priority'), ['low', 'normal', 'high', 'urgent'].map((p) => [p, label('adm.priority', p)]), r.priority)}
          <div class="field" style="flex:3"><label>${t('adm.support.replyTo')}<input name="adminResponse" maxlength="2000" value="${r.adminResponse || ''}"></label></div><button class="btn sm" type="submit">${t('common.save')}</button></form></article>`)}</div>` : emptyState(t('adm.support.none'), t('adm.support.noneText'))}`);
    $('#sf').addEventListener('submit', (e) => { e.preventDefault(); st.status = new FormData(e.target).get('status'); route(); });
    for (const f of panel.querySelectorAll('form[data-report]')) {
      onSubmit(f, async (d) => { await api(`/admin/support-reports/${f.dataset.report}`, { method: 'PATCH', body: { status: d.status, priority: d.priority, adminResponse: d.adminResponse || undefined } }); toast(t('adm.support.updated'), 'ok'); route(); });
    }
  },

  async settings(panel) {
    const [{ settings, payoutMode, currency: cur, payoutSchedule, refundRules, settlementRules }, { payments: pay }] = await Promise.all([api('/admin/settings'), api('/admin/payment-settings')]);
    currency = cur;
    const tone = (v) => (['CONFIGURED', 'HEALTHY', 'AVAILABLE', 'IMPLEMENTED_UNVERIFIED'].includes(v) ? 'warn' : v === 'VERIFIED' ? 'ok' : ['ERROR', 'MISCONFIGURED'].includes(v) ? 'err' : '');
    const row = (k, v) => html`<tr><td>${k}</td><td><span class="badge nocap ${tone(String(v))}">${capability(v)}</span></td></tr>`;
    render(panel, html`<div class="grid cols-2">
      <form class="card" id="commission" novalidate><div class="form-alert"></div><h3>${t('adm.set.marketplace')}</h3>
        <p class="muted small">${t('adm.set.marketplaceNote')}</p>
        <div class="field"><label for="c-bp">${t('adm.set.defaultCommission')}</label><input id="c-bp" name="commission" data-field="commission" inputmode="decimal" dir="ltr" value="${settings.commission_bp / 100}"><div class="hint">${t('adm.set.defaultCommissionHint')}</div></div>
        <div class="field"><label for="c-fx">${t('adm.set.fixedCommission', { currency: cur })}</label><input id="c-fx" name="commissionFixed" data-field="commissionFixed" inputmode="decimal" dir="ltr" value="${fromCents(settings.commission_fixed_cents)}"><div class="hint">${t('adm.set.fixedCommissionHint')}</div></div>
        <div class="field"><label for="c-min">${t('adm.set.minPayout', { currency: cur })}</label><input id="c-min" name="minPayout" data-field="minPayout" inputmode="decimal" dir="ltr" value="${fromCents(settings.min_payout_cents)}"><div class="hint">${t('adm.set.minPayoutHint')}</div></div>
        <div class="field"><label for="c-sfp">${t('adm.set.serviceFeePct')}</label><input id="c-sfp" name="serviceFeePct" data-field="serviceFeePct" inputmode="decimal" dir="ltr" value="${settings.service_fee_bp / 100}"></div>
        <div class="field"><label for="c-sff">${t('adm.set.serviceFeeFixed', { currency: cur })}</label><input id="c-sff" name="serviceFeeFixed" data-field="serviceFeeFixed" inputmode="decimal" dir="ltr" value="${fromCents(settings.service_fee_fixed_cents)}"></div>
        <button class="btn" type="submit">${t('common.save')}</button>
        <h4 style="margin-top:1rem">${t('adm.set.fixedRules')}</h4>
        <p class="muted small"><strong>${t('adm.set.payoutSchedule')}</strong> ${srv('adm.srv.payoutSchedule', payoutSchedule)}<br><strong>${t('adm.set.refundRules')}</strong> ${srv('adm.srv.refundRules', refundRules)}<br><strong>${t('adm.set.settlement')}</strong> ${isDefaultText('adm.srv.settlementProvider', settlementRules) ? t('adm.srv.settlementProvider') : srv('adm.srv.settlementPlatform', settlementRules)}</p></form>
      <div class="card"><h3>${t('adm.set.provider')}</h3>
        <table><tbody>
          <tr><td>${t('pa.provider')}</td><td><strong>${pay.provider === 'none' ? t('adm.set.notConfigured') : pay.provider}</strong></td></tr>
          <tr><td>${t('adm.set.environment')}</td><td><strong>${label('adm.env', pay.environment)}</strong></td></tr>
          ${row(t('adm.set.configuration'), pay.configuration)}${pay.missing.length ? html`<tr><td>${t('adm.set.missing')}</td><td><code>${pay.missing.join(', ')}</code></td></tr>` : ''}
          ${row(t('adm.set.credentials'), pay.providerConnected)}${row(t('adm.set.webhook'), pay.webhook.status)}
          ${row(t('adm.set.split'), pay.marketplace)}${row(t('adm.set.autoPayouts'), pay.restaurantPayouts.automated)}
          ${row(t('adm.set.subCheckout'), pay.subscriptionBilling.hostedCheckout)}${row(t('adm.set.savedCard'), pay.subscriptionBilling.recurringTokenisation)}
          ${row('Apple Pay', pay.paymentMethods.applePay)}${row('Google Pay', pay.paymentMethods.googlePay)}${row('Mada', pay.paymentMethods.mada)}${row(t('adm.set.usd'), pay.usdSettlement)}
          ${row(t('adm.set.sandbox'), pay.sandbox)}${row(t('adm.set.production'), pay.production)}
          <tr><td>${t('adm.payouts.currency')}</td><td>${pay.currency}</td></tr><tr><td>${t('adm.set.payoutMode')}</td><td>${label('adm.mode', payoutMode)}</td></tr></tbody></table>
        <p class="muted small">${t('adm.set.webhookUrl')} <code dir="ltr">${pay.webhook.url}</code>. ${t('adm.set.secretsNote')} ${t('adm.set.unverifiedNote')} ${t('adm.set.plansUnder')} <a data-nav href="/admin/plans">${t('adm.nav.plans')}</a>.</p></div></div>`);
    onSubmit($('#commission'), async (d) => {
      const pct = (v) => Math.round(parseFloat(String(v).replace(',', '.')) * 100);
      const body = { commissionBp: pct(d.commission), commissionFixedCents: toCents(d.commissionFixed), minPayoutCents: toCents(d.minPayout), serviceFeeBp: pct(d.serviceFeePct), serviceFeeFixedCents: toCents(d.serviceFeeFixed) };
      const keys = { commissionBp: 'commission', commissionFixedCents: 'commissionFixed', minPayoutCents: 'minPayout', serviceFeeBp: 'serviceFeePct', serviceFeeFixedCents: 'serviceFeeFixed' };
      for (const [k, field] of Object.entries(keys)) if (Number.isNaN(body[k])) throw Object.assign(new Error('invalid_money'), { code: 'validation_error', details: { field, reason: 'invalid_money' } });
      await api('/admin/settings', { method: 'PUT', body }); toast(t('prof.saved'), 'ok');
    });
  },

  async reconciliation(panel) {
    const [apps] = await Promise.all([api('/admin/payment-applications')]);
    render(panel, html`<div class="toolbar"><h2>${t('adm.nav.reconciliation')}</h2><div class="actions-row"><select id="rc-days" aria-label="${t('adm.rc.window')}"><option value="1">${t('adm.rc.lastDay')}</option><option value="7" selected>${t('rep.lastDays', { n: 7 })}</option><option value="30">${t('rep.lastDays', { n: 30 })}</option></select><button class="btn" data-run>${t('adm.rc.run')}</button></div></div>
      <p class="muted small">${t('adm.rc.note')}</p>
      <div id="rc-result">${emptyState(t('adm.rc.notRun'), t('adm.rc.pressRun'))}</div>
      <h3 style="margin-top:1.5rem">${t('adm.rc.applications')}</h3>
      ${apps.applications.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('adm.rest.restaurant')}</th><th>${t('pa.legalName')}</th><th>${t('adm.rc.crNo')}</th><th>${t('adm.rc.contact')}</th><th>${t('adm.col.status')}</th><th>${t('adm.rc.submitted')}</th></tr></thead><tbody>
        ${apps.applications.map((a) => html`<tr><td>${a.restaurant}</td><td>${a.legalName}</td><td><bdi>${a.registrationNumber}</bdi></td><td>${a.contactName}<div class="muted small"><bdi dir="ltr">${a.contactPhone}</bdi> · <bdi>${a.contactEmail}</bdi></div></td><td><span class="badge nocap ${a.status === 'VERIFIED' ? 'ok' : 'warn'}">${label('adm.acct', a.status)}</span></td><td>${fmtDate(a.submittedAt)}</td></tr>`)}</tbody></table></div>
        <p class="muted small">${t('adm.rc.appsNote')}</p>` : emptyState(t('adm.rc.noApps'), t('adm.rc.noAppsText'))}`);
    panel.onclick = async (e) => {
      if (!e.target.closest('[data-run]')) return;
      try {
        const r = (await api('/admin/reconciliation/run', { method: 'POST', body: { days: Number($('#rc-days').value) } })).reconciliation;
        render($('#rc-result'), html`<div class="alert ${r.status === 'CLEAN' ? 'info' : 'err'}"><strong>${label('adm.cap', r.status)}</strong> · ${r.providerChecked ? t('adm.rc.refetched', { n: r.checked }) : tech(r.skippedReason)} · ${t('adm.rc.findings', { n: r.findings.length })}</div>
          ${r.findings.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('adm.rc.severity')}</th><th>${t('fin.col.type')}</th><th>${t('fin.col.reference')}</th><th>${t('adm.rc.detail')}</th></tr></thead><tbody>${r.findings.map((f) => html`<tr><td><span class="badge nocap ${f.severity === 'critical' ? 'err' : 'warn'}">${label('adm.severity', f.severity)}</span></td><td><code>${f.type}</code></td><td>${tech(f.ref)}</td><td class="small">${tech(f.detail)}</td></tr>`)}</tbody></table></div>` : ''}`);
      } catch (err) { toast(err, 'err'); }
    };
  },

  async audit(panel) {
    const { entries } = await api('/admin/audit?limit=300');
    render(panel, entries.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('adm.audit.when')}</th><th>${t('adm.audit.who')}</th><th>${t('adm.audit.action')}</th><th>${t('adm.audit.target')}</th><th>${t('adm.rc.detail')}</th></tr></thead><tbody>
      ${entries.map((a) => html`<tr><td>${fmtDate(a.createdAt)}</td><td>${a.actor || a.role}</td><td><code>${a.action}</code></td><td>${a.targetType ? tech(`${a.targetType} ${a.targetId ?? ''}`) : '—'}</td><td class="small">${a.details ? tech(JSON.stringify(a.details)) : ''}</td></tr>`)}</tbody></table></div>` : emptyState(t('adm.audit.none'), t('adm.audit.noneText')));
  },

  async system(panel) {
    const s = await api('/admin/system');
    const kb = (b) => (b === null ? t('adm.sys.na') : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
    const flag = (ok, yes, no) => html`<span class="badge nocap ${ok ? 'ok' : 'warn'}">${ok ? yes : no}</span>`;
    const cap2 = (v) => capability(v);
    const on = t('adm.sys.on');
    const off = t('adm.sys.off');
    render(panel, html`<div class="grid cols-3">
      <div class="card"><h3>${t('adm.sys.application')}</h3><p>${label('adm.env', s.environment)} · Node ${s.node}<br>${t('adm.sys.up', { h: Math.floor(s.uptimeSeconds / 3600), m: Math.floor((s.uptimeSeconds % 3600) / 60) })}<br>URL: ${tech(s.appUrl)}<br>${t('adm.sys.tenantDomain')} ${s.tenantBaseDomain ? tech(s.tenantBaseDomain) : t('adm.sys.pathBased')}</p></div>
      <div class="card"><h3>${t('adm.sys.database')}</h3><p>${s.database.engine} · ${kb(s.database.sizeBytes)}<br>${t('adm.sys.migrations', { n: s.database.migrations.length })}</p><p class="muted small">${srv(db1(s), s.database.recommendation)}</p></div>
      <div class="card"><h3>${t('adm.sys.payments')}</h3><p>${t('pa.provider')}: ${s.payments.provider === 'none' ? t('adm.set.notConfigured') : s.payments.provider} ${flag(s.payments.enabled, t('adm.sys.configured'), t('adm.set.notConfigured'))} · ${label('adm.env', s.payments.environment)}<br>${t('adm.set.configuration')}: ${flag(s.payments.configuration === 'CONFIGURED', cap2('CONFIGURED'), cap2(s.payments.configuration))}<br>${t('adm.set.webhook')}: ${flag(s.payments.webhook.status === 'HEALTHY', cap2('HEALTHY'), cap2(s.payments.webhook.status))}<br>${t('adm.sys.marketplace')}: ${flag(s.payments.marketplace === 'VERIFIED', cap2('VERIFIED'), cap2(s.payments.marketplace))}<br>${t('adm.sys.autoPayouts')}: ${flag(s.payments.restaurantPayouts.automated === 'VERIFIED', cap2('VERIFIED'), cap2(s.payments.restaurantPayouts.automated))}<br>${t('adm.sys.subBilling')}: ${flag(s.payments.subscriptionBilling.hostedCheckout === 'VERIFIED', cap2('VERIFIED'), cap2(s.payments.subscriptionBilling.hostedCheckout))}<br>${t('adm.set.sandbox')}: ${cap2(s.payments.sandbox)} · ${t('adm.set.production')}: ${cap2(s.payments.production)}<br>${t('adm.set.payoutMode')}: ${label('adm.mode', s.payments.payoutMode)} · ${t('adm.payouts.currency')}: ${s.payments.currency}</p></div>
      <div class="card"><h3>${t('adm.sys.security')}</h3><p>${t('adm.sys.2faRequired')}: ${flag(s.security.admin2faRequired, t('common.yes'), t('adm.sys.no'))}<br>${t('adm.sys.adminsNo2fa')}: <strong>${s.security.adminsWithout2fa}</strong><br>${t('adm.sys.secureCookies')}: ${flag(s.security.secureCookies, on, t('adm.sys.offDev'))}<br>${t('adm.sys.email')}: ${flag(s.email.configured, t('adm.sys.configured'), t('adm.set.notConfigured'))}</p></div>
      <div class="card"><h3>${t('adm.sys.queues')}</h3><p>${t('adm.sys.unpaidCard')}: ${s.queues.unpaidCardOrders}<br>${t('adm.sys.pendingRefunds')}: ${s.queues.pendingRefunds} · ${t('adm.sys.failed')}: ${s.queues.failedRefunds}<br>${t('adm.sys.failedWebhooks')}: ${s.queues.failedWebhooks24h}<br>${t('adm.subs.openInvoicesTitle')}: ${s.queues.openInvoices}<br>${t('adm.sys.failedPayouts')}: ${s.queues.failedPayouts}</p></div>
      <div class="card"><h3>${t('adm.sys.data')}</h3><p>${t('adm.nav.users')} ${s.counts.users} · ${t('adm.nav.restaurants')} ${s.counts.restaurants} · ${t('adm.nav.orders')} ${s.counts.orders}<br>${t('adm.sys.auditEntries')} ${s.counts.auditEntries}<br>${t('adm.sys.weeklyJob')}: ${flag(s.jobs.weeklyPayoutScheduler, on, off)}</p></div></div>`);
  },

  async security(panel) {
    const render2fa = async () => {
      me = await api('/admin/me').catch(() => me);
      const enabled = me.user.totpEnabled;
      render(panel, html`<div class="card" style="max-width:640px"><h2>${t('adm.2fa.title')}</h2>
        <p>${t('adm.col.status')}: ${enabled ? html`<span class="badge nocap ok">${t('pa.enabled')}</span>` : html`<span class="badge nocap warn">${t('pa.notEnabledBadge')}</span>`}</p>
        ${enabled ? html`<p class="muted">${t('adm.2fa.enabledText')}</p>
          <div class="actions-row"><button class="btn secondary" data-codes>${t('adm.2fa.regenerate')}</button><button class="btn danger" data-disable>${t('adm.2fa.disable')}</button></div>`
    : html`<p class="muted">${t('adm.2fa.intro')} <strong>${t('adm.2fa.required')}</strong></p>
          <button class="btn" data-setup>${t('adm.2fa.setup')}</button>`}
        <div id="twofa-area" style="margin-top:1rem"></div></div>`);
    };
    await render2fa();
    const area = () => $('#twofa-area');
    const showCodes = (codes) => render(area(), html`<div class="alert warn"><strong>${t('adm.2fa.saveCodes')}</strong> ${t('adm.2fa.saveCodesText')}</div>
      <pre dir="ltr" style="background:var(--bg);padding:1rem;border-radius:8px;user-select:all">${codes.join('\n')}</pre><button class="btn" data-done>${t('adm.2fa.saved')}</button>`);
    panel.onclick = async (e) => {
      try {
        if (e.target.closest('[data-setup]')) {
          const s = await api('/auth/2fa/setup', { method: 'POST', body: {} });
          render(area(), html`<ol><li>${t('adm.2fa.step1')}<br><code dir="ltr" style="user-select:all;font-size:1.1rem">${s.secret}</code></li>
            <li>${t('adm.2fa.step2')} <a href="${s.otpauthUri}">${t('adm.2fa.otpLink')}</a></li><li>${t('adm.2fa.step3')}</li></ol>
            <form id="enable" novalidate><div class="form-alert"></div><div class="field"><label for="tc">${t('adm.2fa.code')}</label><input id="tc" name="code" inputmode="numeric" dir="ltr" autocomplete="one-time-code" required></div><button class="btn" type="submit">${t('adm.2fa.enable')}</button></form>`);
          onSubmit($('#enable'), async (d) => {
            const r = await api('/auth/2fa/enable', { method: 'POST', body: { code: d.code } });
            me.mfaEnrollmentRequired = false; me.user.totpEnabled = true;
            toast(t('adm.2fa.enabledToast'), 'ok');
            showCodes(r.backupCodes);
          });
        }
        if (e.target.closest('[data-done]')) route();
        if (e.target.closest('[data-codes]') || e.target.closest('[data-disable]')) {
          const disabling = !!e.target.closest('[data-disable]');
          render(area(), html`<form id="reauth" novalidate><div class="form-alert"></div><p>${t('adm.2fa.confirmIt')}</p>
            <div class="field"><label for="rp">${t('field.password')}</label><input id="rp" name="password" type="password" autocomplete="current-password" required></div>
            <div class="field"><label for="rc">${t('adm.2fa.authOrBackup')}</label><input id="rc" name="code" dir="ltr" required></div>
            <button class="btn ${disabling ? 'danger' : ''}" type="submit">${disabling ? t('adm.2fa.disable') : t('adm.2fa.generate')}</button></form>`);
          onSubmit($('#reauth'), async (d) => {
            if (disabling) { await api('/auth/2fa/disable', { method: 'POST', body: d }); session.clear(); location.href = '/admin/login'; return; }
            showCodes((await api('/auth/2fa/backup-codes', { method: 'POST', body: d })).backupCodes);
          });
        }
      } catch (err) { toast(err, 'err'); }
    };
  },
};

// the recommendation text of the database card is one of two server constants
const db1 = (s) => (s.database.engine === 'postgresql' ? 'adm.srv.dbPostgres' : 'adm.srv.dbSqlite');

// ---------- dialogs ----------
async function orderDetail(id) {
  const r = await api(`/admin/orders/${id}`);
  const o = r.order;
  dialog(t('adm.od.title', { n: o.orderNumber, restaurant: o.restaurantName }), html`<p>${statusLabel(o.status)} · ${o.orderType === 'delivery' ? t('order.delivery') : t('order.pickup')} · ${o.paymentMethod === 'cod' ? t('fin.method.cod') : t('fin.method.card')} (${payLabel(o.paymentStatus)})</p>
    <p><strong>${o.customerName}</strong> · <bdi dir="ltr">${o.customerPhone}</bdi>${o.deliveryAddress ? ` · ${o.deliveryAddress}` : ''}</p>
    <table><tbody>${o.items.map((i) => html`<tr><td>${i.quantity} × ${i.name}${i.kind === 'extra' ? html` <span class="badge nocap">${t('gx.lineBadge')}</span>` : ''}${i.options.length ? html`<div class="muted small">${i.options.map((x) => x.name).join(t('adm.listSep'))}</div>` : ''}</td><td class="num">${m(i.lineTotalCents)}</td></tr>`)}
      <tr><td class="muted">${t('cart.subtotal')}</td><td class="num">${m(o.subtotalCents)}</td></tr><tr><td class="muted">${t('adm.od.taxDeliveryFee')}</td><td class="num">${m(o.taxCents)} / ${m(o.deliveryFeeCents)} / ${m(o.platformFeeCents)}</td></tr>
      <tr><td><strong>${t('cart.total')}</strong></td><td class="num"><strong>${m(o.totalCents)}</strong></td></tr>
      <tr><td class="muted">${t('adm.od.commission', { n: o.commissionBp / 100 })}</td><td class="num">${m(o.commissionCents)}</td></tr><tr><td class="muted">${t('adm.od.restaurantShare')}</td><td class="num">${m(o.restaurantAmountCents)}</td></tr></tbody></table>
    ${r.payment ? html`<p class="small muted">${t('adm.od.payment', { id: r.payment.id })}: ${r.payment.provider} ${r.payment.provider_transaction_id ? tech(r.payment.provider_transaction_id) : ''} · ${label('pstat', r.payment.status)}${r.payment.failure_reason ? ` · ${r.payment.failure_reason}` : ''}</p>` : ''}
    ${r.refunds.length ? html`<p class="small">${t('adm.nav.refunds')}: ${r.refunds.map((f) => `${m(f.amount_cents)} (${label('adm.refund', f.status)})`).join(t('adm.listSep'))}</p>` : ''}
    <ul class="timeline">${r.history.map((h) => html`<li><span class="dot"></span><span>${statusLabel(h.status)} <span class="muted small">${fmtDate(h.created_at)}</span></span></li>`)}</ul>`, { wide: true });
}

async function restaurantDetail(id, refresh) {
  const d = await api(`/admin/restaurants/${id}`);
  const { restaurant: r, paymentAccount: a, earnings, subscription: sub, invoices, recentOrders, payouts, reportLast30Days: rep } = d;
  const plans = (await api('/admin/plans')).plans;
  const inf = '∞';
  const dlg = dialog(r.name, html`<p class="muted small">${tech(r.slug)} · ${t('adm.rd.owner')} ${r.ownerEmail ? tech(r.ownerEmail) : '—'} · ${r.city || ''} · ${approval(r.approvalStatus)}${r.isActive ? '' : ` · ${t('adm.rest.suspended')}`} · <a href="/restaurant/${r.slug}" target="_blank" rel="noopener">${t('adm.rd.publicPage')}</a></p>
    <div class="grid cols-3"><div class="card stat"><div class="label">${t('adm.rd.ordersAll')}</div><div class="value">${r.orders}</div></div><div class="card stat"><div class="label">${t('adm.rd.revenue')}</div><div class="value">${m(earnings.gmvCents)}</div><div class="muted small">${t('adm.rd.last30', { amount: m(rep.revenueCents), n: rep.orders })}</div></div>
      <div class="card stat"><div class="label">${t('adm.dash.commission')}</div><div class="value">${m(earnings.commissionCents)}</div></div></div>
    <table style="margin-top:.5rem"><tbody><tr><td>${t('adm.rd.earningsSplit')}</td><td class="num">${m(earnings.availableCents)} / ${m(earnings.pendingCents)} / ${m(earnings.paidCents)}</td></tr>
      <tr><td>${t('adm.payouts.cashDue')}</td><td class="num">${m(earnings.codCommissionDueCents)}</td></tr></tbody></table>
    <h3>${t('sub.title')}</h3>
    <p>${sub.plan.name} · <span class="badge nocap ${statusTone(sub.status)}">${subStatus(sub.status)}</span> ${sub.endDate && sub.status !== 'trialing' ? `· ${sub.cancelledAt ? t('adm.rd.ends', { date: fmtDay(sub.endDate) }) : t('adm.rd.renews', { date: fmtDay(sub.endDate) })}` : ''}${sub.status === 'trialing' ? ` · ${t('adm.rd.trialEnds', { date: fmtDay(sub.trialEnd) })}` : ''}<br>
      ${t('adm.rd.usage', { products: `${sub.usage.menuItems}/${sub.plan.limits.menuItems ?? inf}`, staff: `${sub.usage.staff}/${sub.plan.limits.staff ?? inf}`, orders: `${sub.usage.ordersPerMonth}/${sub.plan.limits.ordersPerMonth ?? inf}` })}</p>
    <form id="sf" novalidate><div class="form-alert"></div><div class="row">
      <div class="field"><label for="sf-plan">${t('adm.rest.plan')}</label><select id="sf-plan" name="planCode">${plans.map((p) => html`<option value="${p.code}" ${p.code === sub.plan.code ? raw('selected') : ''}>${p.name}${p.isActive ? '' : ` (${t('adm.plans.inactive')})`}</option>`)}</select></div>
      ${select('status', t('adm.col.status'), ['trialing', 'active', 'past_due', 'cancelled', 'expired', 'suspended'].map((s) => [s, subStatus(s)]), sub.status)}
      <div class="field"><label for="sf-end">${t('adm.rd.periodEnd')}</label><input id="sf-end" name="endDate" type="date" dir="ltr" value="${sub.endDate ? sub.endDate.slice(0, 10) : ''}"></div></div>
      <button class="btn" type="submit">${t('adm.rd.assign')}</button> <span class="muted small">${t('adm.rd.assignNote')}</span></form>
    ${invoices.length ? html`<h3>${t('adm.rd.invoices')}</h3><div class="table-wrap"><table><tbody>${invoices.map((i) => html`<tr><td>#${i.id}</td><td>${dateRange(fmtDay(i.periodStart), fmtDay(i.periodEnd))}</td><td class="num">${m(i.amountCents)}</td><td><span class="badge nocap ${statusTone(i.status)}">${label('sub.inv', i.status)}</span></td><td class="small">${i.provider || ''} ${i.reference ? tech(i.reference) : ''}</td></tr>`)}</tbody></table></div>` : ''}
    ${recentOrders.length ? html`<h3>${t('adm.rd.recentOrders')}</h3><div class="table-wrap"><table><tbody>${recentOrders.map((o) => html`<tr><td>#${o.orderNumber}</td><td>${statusLabel(o.status)}</td><td>${o.paymentMethod === 'cod' ? t('adm.pay.cash') : t('fin.method.card')}</td><td class="num">${m(o.totalCents)}</td><td>${fmtDay(o.createdAt)}</td></tr>`)}</tbody></table></div>` : ''}
    ${payouts.length ? html`<h3>${t('adm.nav.payouts')}</h3><div class="table-wrap"><table><tbody>${payouts.map((p) => html`<tr><td>${dateRange(p.periodStart, p.periodEnd)}</td><td class="num">${m(p.amountCents)}</td><td>${label('payout.status', p.status)}</td><td class="small">${p.reference ? tech(p.reference) : ''}</td></tr>`)}</tbody></table></div>` : ''}
    <form id="rd" novalidate style="margin-top:1rem"><div class="form-alert"></div><h3>${t('adm.rd.profileCommission')}</h3>
      <div class="row"><div class="field"><label for="rd-name">${t('field.name')}</label><input id="rd-name" name="name" data-field="name" value="${r.name}"></div><div class="field"><label for="rd-city">${t('field.city')}</label><input id="rd-city" name="city" value="${r.city || ''}"></div></div>
      <div class="row"><div class="field"><label for="rd-phone">${t('prof.phone')}</label><input id="rd-phone" name="phone" dir="ltr" value="${r.phone || ''}"></div><div class="field"><label for="rd-wa">WhatsApp</label><input id="rd-wa" name="whatsapp" dir="ltr" value="${r.whatsapp || ''}"></div>
        <div class="field"><label for="rd-comm">${t('adm.rd.commOverride')}</label><input id="rd-comm" name="commission" data-field="commission" inputmode="decimal" dir="ltr" value="${r.commissionBpOverride === null ? '' : r.commissionBpOverride / 100}" placeholder="${t('adm.rd.platformDefault')}"></div>
        <div class="field"><label for="rd-cfx">${t('adm.rd.fixedOverride')}</label><input id="rd-cfx" name="commissionFixed" data-field="commissionFixed" inputmode="decimal" dir="ltr" value="${r.commissionFixedOverride === null || r.commissionFixedOverride === undefined ? '' : fromCents(r.commissionFixedOverride)}" placeholder="${t('adm.rd.platformDefault')}"></div></div>
      <button class="btn" type="submit">${t('adm.rd.saveProfile')}</button></form>
    <form id="pa" novalidate style="margin-top:1rem"><div class="form-alert"></div><h3>${t('adm.rd.paymentAccount')}</h3>
      ${a?.application ? html`<div class="alert info small"><strong>${t('adm.rd.application')}</strong> ${a.application.legalName} · ${t('adm.rd.cr')} <bdi>${a.application.registrationNumber}</bdi> · ${a.application.contactName} (<bdi dir="ltr">${a.application.contactPhone}</bdi>, <bdi>${a.application.contactEmail}</bdi>) — ${t('adm.rd.submittedOn', { date: fmtDate(a.applicationSubmittedAt) })}</div>` : ''}
      <p class="muted small">${t('adm.col.status')}: <strong>${label('adm.acct', a?.status || 'NOT_ONBOARDED')}</strong>. ${t('adm.rd.paNote')}</p>
      <div class="field"><label for="pa-id">${t('adm.rd.connectedId')}</label><input id="pa-id" name="connectedAccountId" dir="ltr" value="${a?.connectedAccountId || ''}"></div>
      <div class="row">${select('onboardingStatus', t('adm.rd.onboarding'), ['not_started', 'in_progress', 'completed', 'rejected'].map((k) => [k, label('adm.onb', k)]), a?.onboardingStatus)}
        ${select('verificationStatus', t('adm.rd.verification'), ['unverified', 'pending', 'verified', 'rejected'].map((k) => [k, label('pa.kycValue', k)]), a?.verificationStatus)}
        ${select('payoutAccountStatus', t('adm.rd.payoutAccount'), ['inactive', 'active', 'restricted'].map((k) => [k, label('adm.pas', k)]), a?.payoutAccountStatus)}</div>
      <div class="row"><div class="field"><label for="pa-mb">${t('adm.rd.maskedBank')}</label><input id="pa-mb" name="maskedBank" dir="ltr" value="${a?.maskedBank || ''}" placeholder="****1234"></div>
        <div class="field"><label for="pa-sc">${t('pa.currency')}</label><input id="pa-sc" name="settlementCurrency" dir="ltr" value="${a?.settlementCurrency || ''}" placeholder="SAR" maxlength="3"></div>
        <div class="field"><label for="pa-rj">${t('adm.rd.rejectionReason')}</label><input id="pa-rj" name="rejectionReason" value="${a?.rejectionReason || ''}"></div></div>
      <div class="check"><input type="checkbox" id="pa-dis" name="disabled" ${a?.status === 'DISABLED' ? raw('checked') : ''}><label for="pa-dis">${t('adm.rd.disableAccount')}</label></div>
      <div class="check"><input type="checkbox" id="pa-en" name="payoutEnabled" ${a?.payoutEnabled ? raw('checked') : ''}><label for="pa-en">${t('adm.rd.enableCard')}</label></div>
      <button class="btn" type="submit" style="margin-top:.75rem">${t('adm.rd.savePaymentAccount')}</button></form>
    <div style="margin-top:1rem"><button class="btn danger sm" data-delete>${t('adm.rd.delete')}</button> <span class="muted small">${t('adm.rd.deleteNote')}</span></div>`, { wide: true, onClose: refresh });
  onSubmit($('#sf', dlg), async (f) => {
    await api(`/admin/restaurants/${id}/subscription`, { method: 'PUT', body: { planCode: f.planCode, status: f.status, endDate: f.endDate || undefined } });
    toast(t('adm.rd.subUpdated'), 'ok');
  }, { alertBox: $('#sf .form-alert', dlg) });
  onSubmit($('#rd', dlg), async (f) => {
    const comm = String(f.commission).trim() === '' ? null : Math.round(parseFloat(f.commission.replace(',', '.')) * 100);
    if (Number.isNaN(comm)) throw Object.assign(new Error('invalid_money'), { code: 'validation_error', details: { field: 'commission', reason: 'invalid_money' } });
    const fixed = String(f.commissionFixed).trim() === '' ? null : toCents(f.commissionFixed);
    if (Number.isNaN(fixed)) throw Object.assign(new Error('invalid_money'), { code: 'validation_error', details: { field: 'commissionFixed', reason: 'invalid_money' } });
    await api(`/admin/restaurants/${id}`, { method: 'PATCH', body: { name: f.name, city: f.city, phone: f.phone || null, whatsapp: f.whatsapp || null, commissionBpOverride: comm, commissionFixedOverride: fixed } });
    toast(t('adm.rd.updated'), 'ok');
  }, { alertBox: $('#rd .form-alert', dlg) });
  onSubmit($('#pa', dlg), async (f) => {
    await api(`/admin/restaurants/${id}/payment-account`, { method: 'PUT', body: { ...f, connectedAccountId: f.connectedAccountId || null } });
    toast(t('adm.rd.paSaved'), 'ok');
  }, { alertBox: $('#pa .form-alert', dlg) });
  dlg.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-delete]')) return;
    if (!await confirmDialog(t('adm.rd.deleteConfirm', { name: r.name }), { confirmLabel: t('common.delete'), danger: true })) return;
    try { await api(`/admin/restaurants/${id}`, { method: 'DELETE' }); toast(t('adm.rd.deleted'), 'ok'); dlg.close(); } catch (err) { toast(err, 'err'); }
  });
}

function planDialog(p) {
  const dlg = dialog(p ? t('adm.plan.edit', { name: p.name }) : t('adm.plans.new'), html`<form id="pf" novalidate><div class="form-alert"></div>
    <div class="row"><div class="field"><label for="p-code">${t('adm.plan.code')}</label><input id="p-code" name="code" data-field="code" dir="ltr" value="${p?.code || ''}" ${p ? raw('disabled') : ''} placeholder="${t('adm.plan.codePh')}" required></div>
      <div class="field"><label for="p-name">${t('field.name')}</label><input id="p-name" name="name" data-field="name" value="${p?.name || ''}" required></div></div>
    <div class="field"><label for="p-desc">${t('field.description')}</label><input id="p-desc" name="description" data-field="description" value="${p?.description || ''}"></div>
    <div class="row"><div class="field"><label for="p-price">${t('adm.plan.price', { currency })}</label><input id="p-price" name="price" data-field="price" inputmode="decimal" dir="ltr" value="${p ? fromCents(p.priceCents) : '0.00'}"></div>
      ${select('billingInterval', t('adm.plan.interval'), [['month', t('adm.plan.monthly')], ['year', t('adm.plan.yearly')]], p?.billingInterval || 'month')}
      <div class="field"><label for="p-trial">${t('adm.plan.trialDays')}</label><input id="p-trial" name="trialDays" type="number" min="0" max="365" value="${p?.trialDays ?? 0}"></div></div>
    <div class="row"><div class="field"><label for="p-items">${t('adm.plan.maxProducts')}</label><input id="p-items" name="maxMenuItems" inputmode="numeric" placeholder="${t('adm.plan.unlimited')}" value="${p?.maxMenuItems ?? ''}"></div>
      <div class="field"><label for="p-staff">${t('adm.plan.maxStaff')}</label><input id="p-staff" name="maxStaff" inputmode="numeric" placeholder="${t('adm.plan.unlimited')}" value="${p?.maxStaff ?? ''}"></div>
      <div class="field"><label for="p-orders">${t('adm.plan.maxOrders')}</label><input id="p-orders" name="maxOrdersPerMonth" inputmode="numeric" placeholder="${t('adm.plan.unlimited')}" value="${p?.maxOrdersPerMonth ?? ''}"></div>
      <div class="field"><label for="p-br">${t('adm.plan.maxBranches')}</label><input id="p-br" name="maxBranches" inputmode="numeric" placeholder="${t('adm.plan.unlimited')}" value="${p?.maxBranches ?? ''}"></div></div>
    <div class="check"><input type="checkbox" id="p-an" name="analytics" ${p?.analytics ? raw('checked') : ''}><label for="p-an">${t('adm.plans.analytics')}</label></div>
    <div class="check"><input type="checkbox" id="p-ad" name="advancedReports" ${p?.advancedReports ? raw('checked') : ''}><label for="p-ad">${t('adm.plan.advancedExport')}</label></div>
    <div class="check"><input type="checkbox" id="p-ac" name="isActive" ${!p || p.isActive ? raw('checked') : ''}><label for="p-ac">${t('adm.plan.activeChoose')}</label></div>
    <div class="field" style="margin-top:.75rem"><label for="p-feat">${t('adm.plan.features')}</label><textarea id="p-feat" name="features" rows="4">${(p?.features || []).join('\n')}</textarea></div>
    <button class="btn" type="submit">${t('adm.plan.save')}</button></form>`, { wide: true, onClose: () => route() });
  onSubmit($('#pf', dlg), async (d) => {
    const lim = (v) => (String(v).trim() === '' ? null : Number(v));
    const price = toCents(d.price);
    if (Number.isNaN(price)) throw Object.assign(new Error('invalid_money'), { code: 'validation_error', details: { field: 'price', reason: 'invalid_money' } });
    const body = {
      name: d.name, description: d.description, priceCents: price, currency, billingInterval: d.billingInterval, trialDays: Number(d.trialDays || 0),
      maxMenuItems: lim(d.maxMenuItems), maxStaff: lim(d.maxStaff), maxOrdersPerMonth: lim(d.maxOrdersPerMonth), maxBranches: lim(d.maxBranches),
      analytics: d.analytics, advancedReports: d.advancedReports, isActive: d.isActive, features: d.features.split('\n').map((x) => x.trim()).filter(Boolean),
    };
    if (p) await api(`/admin/plans/${p.code}`, { method: 'PUT', body }); else await api('/admin/plans', { method: 'POST', body: { ...body, code: d.code } });
    toast(t('adm.plan.saved'), 'ok');
    dlg.close();
  }, { alertBox: $('.form-alert', dlg) });
}

boot();
