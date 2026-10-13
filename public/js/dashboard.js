import {
  api, requireRoles, mountChrome, $, render, html, raw, money, fmtDate, fmtDay, cap, toCents, fromCents, spinner, emptyState, errorBox, toast, onSubmit,
  confirmDialog, promptDialog, wireDialog, t, has, loc, statusLabel, payLabel, planName, planDesc, planHighlights,
} from './common.js';
import { menuView, MENU_NAV, activeMenuSection } from './menu-manager.js';
import { icon } from './icons.js';
import { branchDialog, branchLabel, hasLocation } from './branch-editor.js';
import { mountBranchesOverview, pinColor } from './map-picker.js';

mountChrome({ active: 'dashboard' });
const user = requireRoles('owner', 'staff');

let ctx; // { restaurant, subscription, paymentAccount, role }
let refreshTimer;
const isOwner = () => ctx.role === 'owner';
const m = (c) => money(c, ctx.restaurant.currency);

// Sidebar. "Menu" owns a nested submenu (MENU_NAV: all dishes, categories, stock, ...) that opens inside the same sidebar.
const TABS = [
  { id: 'overview', icon: 'overview', label: 'dash.tab.overview', roles: ['owner', 'staff'] },
  { id: 'orders', icon: 'orders', label: 'dash.tab.orders', roles: ['owner', 'staff'] },
  { id: 'menu', icon: 'menu', label: 'dash.tab.menu', roles: ['owner', 'staff'], children: MENU_NAV },
  { id: 'earnings', icon: 'finance', label: 'dash.tab.earnings', roles: ['owner'] },
  { id: 'customers', icon: 'customers', label: 'dash.tab.customers', roles: ['owner'] },
  { id: 'reports', icon: 'reports', label: 'dash.tab.reports', roles: ['owner'] },
  { id: 'team', icon: 'team', label: 'dash.tab.team', roles: ['owner'] },
  { id: 'subscription', icon: 'subscription', label: 'dash.tab.subscription', roles: ['owner'] },
  { id: 'settings', icon: 'settings', label: 'dash.tab.settings', roles: ['owner'] },
];

// The Menu submenu is open while one of its pages is shown, and otherwise remembers how the person left it.
const MENU_OPEN_KEY = 'dash.menuOpen';
let menuOpen = (() => { try { return sessionStorage.getItem(MENU_OPEN_KEY) === '1'; } catch { return false; } })();
function setMenuOpen(open) {
  menuOpen = open;
  try { sessionStorage.setItem(MENU_OPEN_KEY, open ? '1' : '0'); } catch { /* storage blocked */ }
}

// translated label for a server code (status, payment status ...), with the raw code as a last resort
const label = (prefix, code) => (has(`${prefix}.${code}`) ? t(`${prefix}.${code}`) : cap(code));
const subStatus = (s) => label('sub.status', s);

async function boot() {
  if (!user) return;
  try {
    ctx = await api('/manage/restaurant');
  } catch (e) {
    if (e.code === 'onboarding_required') return (location.href = '/onboarding.html');
    return render($('#root'), errorBox(e));
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('click', sidebarClicks);
  route();
}

// Sidebar behaviour that must not re-render the page: expanding / collapsing "Menu", and the compact (phone / tablet) navigation bar.
function sidebarClicks(e) {
  const toggle = e.target.closest('[data-menu-toggle]');
  if (toggle) {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    setMenuOpen(open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.closest('.side-group').classList.toggle('open', open);
    $('.side-sub', toggle.closest('.side-group')).hidden = !open;
    return;
  }
  const burger = e.target.closest('[data-side-burger]');
  if (burger) {
    const side = burger.closest('.side');
    const open = !side.classList.contains('open');
    side.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', String(open));
    return;
  }
  if (e.target.closest('.side a[href]')) { // choosing a destination folds the compact navigation again
    const side = $('.side');
    side?.classList.remove('open');
    $('[data-side-burger]')?.setAttribute('aria-expanded', 'false');
  }
}

function sidebar(active) {
  const tabs = TABS.filter((tab) => tab.roles.includes(ctx.role));
  const menuSection = active === 'menu' ? activeMenuSection() : null;
  if (active === 'menu') setMenuOpen(true); // being on a Menu page always shows where you are
  const link = (tab) => html`<a class="side-link" href="#${tab.id}" ${tab.id === active ? raw('aria-current="page"') : ''}>${icon(tab.icon)}<span class="side-label">${t(tab.label)}</span></a>`;
  const group = (tab) => html`<div class="side-group ${menuOpen ? 'open' : ''}">
    <button type="button" class="side-link side-toggle ${tab.id === active ? 'is-active' : ''}" data-menu-toggle aria-expanded="${menuOpen}" aria-controls="side-sub-${tab.id}" title="${t('dash.menuToggle')}">
      ${icon(tab.icon)}<span class="side-label">${t(tab.label)}</span><span class="side-chev">${icon('chevron', { size: 16 })}</span></button>
    <div class="side-sub" id="side-sub-${tab.id}" role="group" aria-label="${t(tab.label)}" ${menuOpen ? '' : raw('hidden')}>
      ${tab.children.filter((c) => c.roles.includes(ctx.role)).map((c) => html`<a class="side-link sub ${c.cta ? 'cta' : ''}" href="#menu/${c.id}" ${menuSection === c.id ? raw('aria-current="page"') : ''}>${icon(c.icon, { size: 16 })}<span class="side-label">${t(c.label)}</span></a>`)}
    </div></div>`;
  const current = tabs.find((tab) => tab.id === active);
  const currentLabel = current ? t(current.label) + (menuSection ? ` · ${t(MENU_NAV.find((c) => c.id === menuSection)?.label || 'dash.tab.menu')}` : '') : t('dash.nav');
  return html`<nav class="side" aria-label="${t('dash.nav')}">
    <button type="button" class="side-burger" data-side-burger aria-expanded="false" aria-controls="side-list" aria-label="${t('dash.navToggle')}">
      ${current ? icon(current.icon) : ''}<span class="side-label">${currentLabel}</span><span class="side-chev">${icon('chevron', { size: 16 })}</span></button>
    <div class="side-list" id="side-list">${tabs.map((tab) => (tab.children ? group(tab) : link(tab)))}</div></nav>`;
}

function shell(active) {
  const r = ctx.restaurant;
  const sub = ctx.subscription;
  render($('#root'), html`
    ${r.approvalStatus === 'pending' ? html`<div class="alert info" role="status"><strong>${t('dash.waitingApproval')}</strong> ${t('dash.waitingApprovalText')}</div>` : ''}
    ${r.approvalStatus === 'rejected' ? html`<div class="alert err" role="alert"><strong>${t('dash.notApproved')}</strong> ${r.rejectionReason || ''} ${t('dash.contactSupport')}</div>` : ''}
    ${['expired', 'cancelled', 'past_due'].includes(sub.status) && r.isActive ? html`<div class="alert ${sub.status === 'past_due' ? 'warn' : 'err'}" role="alert"><strong>${t('dash.subscriptionIs', { status: subStatus(sub.status) })}</strong> ${sub.status === 'past_due' ? t('dash.paymentDue') : t('dash.cannotOrder')} <a href="#subscription">${t('dash.openSubscription')}</a></div>` : ''}
    ${!r.isActive ? html`<div class="alert err" role="alert"><strong>${t('dash.suspended')}</strong> ${t('dash.suspendedText')}</div>` : ''}
    <div class="toolbar"><div><h1 style="margin:0">${loc(r)} ${r.isDemo ? raw(`<span class="badge demo">${t('rest.sample')}</span>`) : ''}</h1>
      <span class="muted small">${ctx.role === 'owner' ? t('role.owner') : t('role.staff')} · ${t('dash.planName', { plan: planName(sub.plan) })} · <span class="badge ${['active', 'trialing'].includes(sub.status) ? 'ok' : 'warn'}">${subStatus(sub.status)}</span></span></div>
      ${r.approvalStatus === 'approved' ? html`<a class="btn secondary" href="/restaurant/${r.slug}" target="_blank" rel="noopener">${t('dash.viewPublic')}</a>` : ''}</div>
    <div class="dash">
      ${sidebar(active)}
      <section id="panel" aria-live="polite" aria-busy="true"></section>
    </div>`);
}

async function route() {
  clearInterval(refreshTimer);
  let id = location.hash.slice(1).split('/')[0] || 'overview';
  const tab = TABS.find((t) => t.id === id && t.roles.includes(ctx.role));
  if (!tab) { id = 'overview'; history.replaceState(null, '', '#overview'); }
  shell(id);
  const panel = $('#panel');
  panel.onclick = null; panel.onchange = null;
  render(panel, spinner());
  try { await views[id](panel); } catch (e) { render(panel, errorBox(e)); } finally { panel.removeAttribute('aria-busy'); }
}

const reload = async (refreshCtx = true) => { if (refreshCtx) ctx = await api('/manage/restaurant'); route(); };
const reloadCtx = async () => { ctx = await api('/manage/restaurant'); };

// ---------------- views ----------------
const views = {
  async overview(panel) {
    const o = await api('/manage/overview');
    const sub0 = ctx.subscription;
    const u = sub0.usage;
    const lim = sub0.plan.limits;
    render(panel, html`
      <div class="grid cols-4">
        <div class="card stat"><div class="label">${t('ov.newOrders')}</div><div class="value">${o.pending}</div></div>
        <div class="card stat"><div class="label">${t('ov.inProgress')}</div><div class="value">${o.inProgress}</div></div>
        <div class="card stat"><div class="label">${t('ov.ordersToday')}</div><div class="value">${o.ordersToday}</div></div>
        ${isOwner() ? html`<div class="card stat"><div class="label">${t('ov.valueToday')}</div><div class="value">${m(o.revenueTodayCents)}</div></div>` : html`<div class="card stat"><div class="label">${t('ov.menuItems')}</div><div class="value">${o.menuItems}</div></div>`}
      </div>
      ${o.pending ? html`<div class="alert info" style="margin-top:1rem">${o.pending === 1 ? t('ov.waitingOne') : t('ov.waitingMany', { n: o.pending })} <a href="#orders">${t('ov.reviewOrders')}</a></div>` : ''}
      ${isOwner() && u.branches === 0 ? html`<div class="card" style="margin-top:1rem" id="setup-checklist"><h2>${t('flow.checklistTitle')}</h2><p class="muted small" style="margin-top:0">${t('flow.checklistIntro')}</p>
        <ul class="checklist">
          <li><span class="badge ok">${t('onboarding.done')}</span><span><strong>${t('onboarding.restaurantProfile')}</strong></span></li>
          <li><span class="badge warn">${t('onboarding.pending')}</span><span><strong>${t('flow.addFirstBranch')}</strong><div class="muted small">${t('flow.branchNeeds')}</div></span></li>
          <li><span class="badge ${u.menuItems ? 'ok' : 'warn'}">${u.menuItems ? t('onboarding.done') : t('onboarding.pending')}</span><span><strong>${t('onboarding.setupMenu')}</strong></span></li></ul>
        <a class="btn" href="#team">${icon('plus', { size: 16 })} ${t('flow.addFirstBranch')}</a></div>` : ''}
      ${ctx.restaurant.approvalStatus === 'approved' ? html`<div class="card" style="margin-top:1rem"><h2>${t('ov.publicPage')}</h2>
        <p>${t('ov.shareLink')} <a href="/restaurant/${ctx.restaurant.slug}" target="_blank" rel="noopener"><code dir="ltr">${location.origin}/restaurant/${ctx.restaurant.slug}</code></a></p>
        ${!ctx.restaurant.acceptingOrders ? html`<div class="alert warn"><strong>${t('ov.notAccepting')}</strong> ${t('ov.changeInSettings')}</div>` : ''}</div>` : ''}
      ${u.menuItems === 0 ? html`<div class="alert info" style="margin-top:1rem">${t('ov.menuEmpty')} <a href="#menu/new">${t('ov.addFirstDishes')}</a></div>` : ''}
      ${isOwner() ? html`<div class="card"><h2>${t('ov.onlinePayments')}</h2>${paymentAccountBlock(ctx.paymentAccount)}</div>
        <div class="card"><h2>${t('ov.planUsage')}</h2><p class="muted small" style="margin-top:0">${t('ov.planLine', { plan: planName(sub0.plan), status: subStatus(sub0.status) })}${sub0.nextBillingDate ? ` · ${t('ov.nextBilling', { date: fmtDay(sub0.nextBillingDate) })}` : ''} · <a href="#subscription">${t('ov.manageSub')}</a></p>${usageMeter(t('usage.menuItems'), u.menuItems, lim.menuItems)}${usageMeter(t('usage.staff'), u.staff, lim.staff)}${usageMeter(t('usage.branches'), u.branches, lim.branches)}${usageMeter(t('usage.ordersMonth'), u.ordersPerMonth, lim.ordersPerMonth)}</div>` : ''}`);
  },

  async orders(panel) {
    let filter = sessionStorage.getItem('dash.orderFilter') || 'active';
    async function draw() {
      const q = filter === 'all' ? '' : `?status=${filter}`;
      const { orders } = await api(`/manage/orders${q}`);
      const list = filter === 'active' ? orders.reverse() : orders; // oldest open order first
      const tabs = ['active', 'pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled', 'rejected', 'all'];
      render(panel, html`<div class="toolbar"><h2>${t('dash.tab.orders')}</h2><span class="muted small">${t('orders.refreshes')}</span></div>
        <div class="actions-row" role="group" aria-label="${t('orders.filter')}" style="margin-bottom:1rem">${tabs.map((tb) => html`<button class="btn sm ${tb === filter ? '' : 'secondary'}" data-filter="${tb}">${tb === 'active' || tb === 'all' ? t(`orders.f.${tb}`) : statusLabel(tb)}</button>`)}</div>
        ${list.length ? html`<div class="grid">${list.map(orderCard)}</div>` : emptyState(t('orders.noneHere'), filter === 'active' ? t('orders.newAppear') : t('orders.nothingMatches'))}`);
    }
    panel.onclick = async (e) => {
      const f = e.target.closest('[data-filter]');
      const st = e.target.closest('[data-status]');
      try {
        if (f) { filter = f.dataset.filter; sessionStorage.setItem('dash.orderFilter', filter); await draw(); }
        if (st) {
          let reason;
          if (st.dataset.status === 'rejected' || st.dataset.status === 'cancelled') {
            reason = await promptDialog(st.dataset.status === 'rejected' ? t('orders.whyDecline') : t('orders.whyCancel'), { confirmLabel: t('common.confirm'), placeholder: t('orders.reasonPlaceholder') });
            if (!reason) return;
            if (st.dataset.paid === '1' && !await confirmDialog(t('orders.refundNotice'), { confirmLabel: t('orders.refundContinue'), danger: true })) return;
          }
          st.disabled = true;
          await api(`/manage/orders/${st.dataset.id}/status`, { method: 'PATCH', body: { status: st.dataset.status, reason } });
          toast(t('orders.statusSet', { status: statusLabel(st.dataset.status) }), 'ok');
          await draw();
        }
      } catch (err) { toast(err, 'err'); draw(); }
    };
    await draw();
    refreshTimer = setInterval(() => { if (location.hash === '#orders' && !document.hidden) draw().catch(() => {}); }, 20000);
  },

  async menu(panel) {
    await menuView(panel, { ctx, refresh: () => route(), reloadCtx: async () => { await reloadCtx(); route(); } });
  },

  async earnings(panel) {
    const [e, { payouts }, { entries }, { payments }, acct, { finance: f }, settle] = await Promise.all([
      api('/manage/earnings'), api('/manage/payouts'), api('/manage/earnings/ledger?limit=100'), api('/manage/payments'), api('/manage/payment-account'), api('/manage/finance'), api('/manage/settlements'),
    ]);
    const tap = f.settlementModel === 'TAP_SETTLEMENT';
    const SETTLE_TONE = { AWAITING_ACCOUNT_VERIFICATION: 'warn', AWAITING_TAP_SETTLEMENT: 'warn', PROCESSING: 'warn', PAID_BY_TAP: 'ok', FAILED: 'err', UNKNOWN: 'warn' };
    const stTone = SETTLE_TONE[f.settlementState] || 'warn';
    const stLabel = has(`fin.settle.${f.settlementState}`) ? t(`fin.settle.${f.settlementState}`) : f.settlementState;
    const confirmedBy = (p) => (p.confirmationSource === 'provider' ? t('fin.confirmedByProvider') : p.confirmationSource === 'admin_manual' ? t('fin.confirmedManual') : '');
    const payoutBadge = (st) => (st === 'paid' ? 'ok' : ['failed', 'reversed'].includes(st) ? 'err' : 'warn');
    render(panel, html`<div class="toolbar"><h2>${tap ? t('fin.titleTap') : t('fin.titlePayouts')}</h2></div>
      <h3 style="margin-bottom:.25rem">${t('fin.earnings')}</h3>
      <div class="grid cols-4">
        <div class="card stat"><div class="label">${t('fin.gross')}</div><div class="value">${m(f.totalSalesCents)}</div><div class="muted small">${t('fin.grossSub')}</div></div>
        <div class="card stat"><div class="label">${t('fin.commission')}</div><div class="value">${m(f.platformFeesCents)}</div><div class="muted small">${t('fin.commissionSub')}</div></div>
        <div class="card stat"><div class="label">${t('fin.refunds')}</div><div class="value">${m(f.refundsCents)}</div></div>
        <div class="card stat"><div class="label">${t('fin.net')}</div><div class="value">${m(f.netEarningsCents)}</div><div class="muted small">${t('fin.netSub')}</div></div>
        <div class="card stat"><div class="label">${t('fin.pending')}</div><div class="value">${m(f.pendingBalanceCents)}</div><div class="muted small">${t('fin.pendingSub')}</div></div>
        <div class="card stat"><div class="label">${t('fin.available')}</div><div class="value">${m(f.availableForPayoutCents)}</div><div class="muted small">${t('fin.availableSub', { date: fmtDay(f.nextPayoutDate) })}</div></div>
        <div class="card stat"><div class="label">${tap ? t('fin.tapSettlement') : t('fin.payoutStatus')}</div><div class="value" style="font-size:1rem"><span class="badge nocap ${stTone}">${stLabel}</span></div><div class="muted small">${tap ? t('fin.tapSub') : t('fin.platformPayouts')}</div></div>
        <div class="card stat"><div class="label">${t('fin.paidOut')}</div><div class="value">${m(f.paidOutCents)}</div><div class="muted small">${f.paidOutByProviderCents ? t('fin.paidOutProvider', { amount: m(f.paidOutByProviderCents) }) : t('fin.confirmedOnly')}${f.paidOutManuallyRecordedCents ? ` · ${t('fin.paidOutManual', { amount: m(f.paidOutManuallyRecordedCents) })}` : ''}</div></div>
      </div>
      ${tap ? html`<div class="alert info small" style="margin-top:1rem"><strong>${t('fin.howPaid')}</strong> ${t('fin.howPaidText')}</div>` : ''}
      ${f.payoutAccount.status !== 'VERIFIED' ? html`<div class="alert warn" style="margin-top:1rem">${t('fin.blocked', { status: t(`pa.status.${f.payoutAccount.displayStatus}`) })}</div>` : ''}
      <div class="grid cols-2" style="margin-top:1rem">
        <div class="card"><h3>${t('fin.calcTitle')}</h3>
          <table><tbody>
            <tr><td>${t('fin.onlineGross')}</td><td class="num">${m(e.onlineGrossCents)}</td></tr>
            <tr><td>${t('fin.commission')}</td><td class="num">−${m(e.commissionCents)}</td></tr>
            ${e.platformFeeCents ? html`<tr><td>${t('fin.serviceFee')}</td><td class="num">−${m(e.platformFeeCents)}</td></tr>` : ''}
            ${e.paymentFeeCents ? html`<tr><td>${t('fin.paymentFees')}</td><td class="num">−${m(e.paymentFeeCents)}</td></tr>` : ''}
            <tr><td><strong>${t('fin.onlineEarnings')}</strong></td><td class="num"><strong>${m(e.onlineNetCents)}</strong></td></tr></tbody></table>
          <p class="muted small">${t('fin.calcNote')}</p></div>
        <div class="card"><h3>${t('fin.cashTitle')}</h3>
          <p>${e.cashOrders === 1 ? t('fin.cashOne', { amount: m(e.cashCollectedCents) }) : t('fin.cashMany', { n: e.cashOrders, amount: m(e.cashCollectedCents) })}</p>
          <p>${t('fin.cashDue')} <strong>${m(e.codCommissionDueCents)}</strong></p>
          <p class="muted small">${t('fin.cashNote')}</p></div>
      </div>
      <div class="card" style="margin-top:1rem"><h3>${t('fin.accountTitle')}</h3>${paymentAccountBlock(acct.paymentAccount, true)}</div>
      <h3 style="margin-top:1.5rem">${tap ? t('fin.weeklyStatements') : t('fin.weeklyPayouts')}</h3>
      ${payouts.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('fin.col.period')}</th><th class="num">${t('fin.col.amount')}</th><th>${t('fin.col.status')}</th><th>${t('fin.col.reference')}</th><th>${t('fin.col.destination')}</th><th>${t('fin.col.paid')}</th></tr></thead><tbody>
        ${payouts.map((p) => html`<tr><td><bdi>${p.periodStart}</bdi> – <bdi>${p.periodEnd}</bdi></td><td class="num">${m(p.amountCents)}</td><td><span class="badge nocap ${payoutBadge(p.status)}">${label('payout.status', p.status)}</span>${confirmedBy(p) ? html`<div class="muted small">${confirmedBy(p)}</div>` : ''}${p.failureReason ? html`<div class="muted small">${p.failureReason}</div>` : ''}</td><td><bdi>${p.reference || '—'}</bdi></td><td><bdi>${p.destination || '—'}</bdi></td><td>${p.paidAt ? fmtDay(p.paidAt) : '—'}</td></tr>`)}</tbody></table></div>`
        : emptyState(t('fin.noPayouts'), t('fin.noPayoutsText'))}
      <p class="muted small">${t('fin.payoutNote')} ${tap ? t('fin.payoutNoteTap') : ''}</p>
      ${tap ? html`<h3 style="margin-top:1.5rem">${t('fin.tapTitle')}</h3>
        ${settle.settlements.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('fin.col.date')}</th><th>${t('fin.col.tapId')}</th><th class="num">${t('fin.col.amountReported')}</th><th>${t('fin.col.status')}</th></tr></thead><tbody>
          ${settle.settlements.map((x) => html`<tr><td>${x.date ? fmtDay(x.date) : '—'}</td><td><code dir="ltr">${x.id}</code></td><td class="num"><bdi>${x.amount} ${x.currency || ''}</bdi></td><td><span class="badge nocap ${x.status === 'paid' ? 'ok' : x.status === 'failed' ? 'err' : 'warn'}">${t(`fin.tap.${['paid', 'failed', 'processing'].includes(x.status) ? x.status : 'unknown'}`)}</span><div class="muted small"><bdi>${x.statusRaw}</bdi></div></td></tr>`)}</tbody></table></div>`
          : emptyState(t('fin.noTap'), t('fin.noTapText'))}` : ''}
      <h3 style="margin-top:1.5rem">${t('fin.payments')}</h3>
      ${payments.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('fin.col.order')}</th><th>${t('fin.col.method')}</th><th>${t('fin.col.status')}</th><th class="num">${t('fin.col.amount')}</th><th class="num">${t('fin.col.refunded')}</th><th>${t('fin.col.date')}</th></tr></thead><tbody>
        ${payments.slice(0, 50).map((p) => html`<tr><td>#${p.orderNumber}</td><td>${p.method === 'card' ? (p.source ? t('fin.method.cardVia', { source: p.source }) : t('fin.method.card')) : t('fin.method.cod')}</td><td><span class="badge nocap ${p.status === 'succeeded' || p.status === 'cash_collected' ? 'ok' : p.status === 'failed' ? 'err' : 'warn'}">${label('pstat', p.status)}</span></td><td class="num">${m(p.amountCents)}</td><td class="num">${p.refundedCents ? m(p.refundedCents) : '—'}</td><td>${fmtDay(p.createdAt)}</td></tr>`)}</tbody></table></div>` : emptyState(t('fin.noPayments'))}
      <h3 style="margin-top:1.5rem">${t('fin.ledger')}</h3>
      ${entries.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('fin.col.order')}</th><th>${t('fin.col.type')}</th><th class="num">${t('fin.col.gross')}</th><th class="num">${t('fin.col.commission')}</th><th class="num">${t('fin.col.fees')}</th><th class="num">${t('fin.col.yours')}</th><th>${t('fin.col.payout')}</th></tr></thead><tbody>
        ${entries.map((l) => html`<tr><td>#${l.orderNumber}</td><td>${label('fin.type', l.type)}</td><td class="num">${m(l.grossCents)}</td><td class="num">${m(l.commissionCents)}</td><td class="num">${m(l.platformFeeCents + l.paymentFeeCents)}</td><td class="num">${m(l.restaurantAmountCents)}</td><td>${l.payoutId ? t('fin.ledgerPayout', { id: l.payoutId, status: label('payout.status', l.payoutStatus) }) : l.eligibleAt ? t('fin.nextPayout') : t('fin.afterDelivery')}</td></tr>`)}</tbody></table></div>` : emptyState(t('fin.noLedger'))}`);
    panel.onclick = (ev) => { if (ev.target.closest('[data-apply-payout]')) payoutApplicationDialog(acct.paymentAccount.application); };
  },

  async customers(panel) {
    const { customers } = await api('/manage/customers');
    render(panel, html`<div class="toolbar"><h2>${t('cust.title')}</h2><span class="muted small">${t('cust.sub')}</span></div>
      ${customers.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('cust.name')}</th><th>${t('cust.email')}</th><th>${t('cust.phone')}</th><th class="num">${t('cust.orders')}</th><th class="num">${t('cust.spent')}</th><th>${t('cust.last')}</th></tr></thead><tbody>
        ${customers.map((c) => html`<tr><td>${c.name}</td><td><bdi>${c.email}</bdi></td><td><bdi dir="ltr">${c.phone || '—'}</bdi></td><td class="num">${c.orderCount}</td><td class="num">${m(c.totalSpentCents)}</td><td>${fmtDay(c.lastOrderAt)}</td></tr>`)}</tbody></table></div>`
        : emptyState(t('cust.none'), t('cust.noneText'))}`);
  },

  async reports(panel) {
    const days = Number(sessionStorage.getItem('dash.days')) || 30;
    let s;
    try { s = await api(`/manage/reports/summary?days=${days}`); }
    catch (e) { if (e.code === 'feature_not_in_plan') return render(panel, lockedPanel(t('rep.analyticsTitle'), t('rep.analyticsLocked'))); throw e; }
    let adv = null;
    try { adv = await api(`/manage/reports/advanced?days=${days}`); } catch (e) { if (e.code !== 'feature_not_in_plan') throw e; }
    const max = Math.max(1, ...s.daily.map((d) => d.revenueCents));
    render(panel, html`<div class="toolbar"><h2>${t('rep.title')}</h2>
      <div class="actions-row"><label class="sr-only" for="days">${t('rep.period')}</label><select id="days" style="width:auto">${[7, 30, 90].map((d) => html`<option value="${d}" ${d === days ? raw('selected') : ''}>${t('rep.lastDays', { n: d })}</option>`)}</select>
      ${adv ? html`<button class="btn secondary" data-csv>${t('rep.exportCsv')}</button>` : ''}</div></div>
      <div class="grid cols-4">
        <div class="card stat"><div class="label">${t('rep.orderValue')}</div><div class="value">${m(s.revenueCents)}</div></div>
        <div class="card stat"><div class="label">${t('rep.orders')}</div><div class="value">${s.orders}</div></div>
        <div class="card stat"><div class="label">${t('rep.avgOrder')}</div><div class="value">${m(s.avgOrderCents)}</div></div>
        <div class="card stat"><div class="label">${t('rep.cancelled')}</div><div class="value">${s.cancelled}</div></div>
        ${s.couponOrders ? html`<div class="card stat"><div class="label">${t('coupon.reportLabel', { n: s.couponOrders })}</div><div class="value">${m(s.couponDiscountCents)}</div></div>` : ''}</div>
      <div class="card" style="margin-top:1rem"><h3>${t('rep.daily')}</h3>
        ${s.daily.length ? html`<div class="bars" dir="ltr" role="img" aria-label="${t('rep.dailyChart')}">${s.daily.map((d) => html`<div class="bar" style="height:${Math.round((d.revenueCents / max) * 100)}%" title="${t('rep.barTitle', { day: d.day, amount: m(d.revenueCents), n: d.orders })}"></div>`)}</div>
          <div class="muted small" style="display:flex;justify-content:space-between"><bdi>${s.daily[0].day}</bdi><bdi>${s.daily[s.daily.length - 1].day}</bdi></div>` : emptyState(t('rep.noOrders'))}</div>
      ${adv ? html`<div class="grid cols-2" style="margin-top:1rem">
        <div class="card"><h3>${t('rep.topDishes')}</h3>${adv.topProducts.length ? html`<table><tbody>${adv.topProducts.map((p) => html`<tr><td>${loc(p)}</td><td class="num">${t('rep.sold', { n: p.quantity })}</td><td class="num">${m(p.revenueCents)}</td></tr>`)}</tbody></table>` : emptyState(t('rep.noSales'))}</div>
        <div class="card"><h3>${t('rep.customersTypes')}</h3>
          <p>${t('rep.returning', { n: adv.repeatCustomers.returning, total: adv.repeatCustomers.total })}</p>
          ${adv.byOrderType.map((ty) => html`<p style="margin:0">${ty.type === 'delivery' ? t('order.delivery') : ty.type === 'pickup' ? t('order.pickup') : cap(ty.type)}: <strong>${t('rep.ordersCount', { n: ty.orders })}</strong> · ${m(ty.revenueCents)}</p>`)}
          <h3 style="margin-top:1rem">${t('rep.byHour')}</h3>
          ${adv.ordersByHourUtc.length ? html`<div class="bars" dir="ltr" role="img" aria-label="${t('rep.hourChart')}">${adv.ordersByHourUtc.map((h) => html`<div class="bar" style="height:${Math.round((h.orders / Math.max(...adv.ordersByHourUtc.map((x) => x.orders))) * 100)}%" title="${t('rep.hourTitle', { hour: h.hour, n: h.orders })}"></div>`)}</div>` : emptyState(t('rep.noData'))}</div>
      </div>` : html`<div class="locked" style="margin-top:1rem"><strong>${t('rep.advancedLocked')}</strong><p class="muted">${t('rep.advancedLockedText')}</p></div>`}`);
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
    render(panel, html`<div class="toolbar"><h2>${t('team.staff')}</h2></div>
      <div class="card">${usageMeter(t('usage.staff'), staff.length, lim.staff)}
        ${staff.length ? html`<div class="table-wrap" style="margin:1rem 0"><table><thead><tr><th>${t('team.name')}</th><th>${t('team.email')}</th><th>${t('team.status')}</th><th></th></tr></thead><tbody>
          ${staff.map((s) => html`<tr><td>${s.name}</td><td><bdi>${s.email}</bdi></td><td><span class="badge nocap ${s.isActive ? 'active' : 'cancelled'}">${s.isActive ? t('team.active') : t('team.disabled')}</span></td>
          <td class="right"><button class="btn secondary sm" data-toggle="${s.id}" data-active="${s.isActive}">${s.isActive ? t('team.disable') : t('team.enable')}</button> <button class="btn danger sm" data-del-staff="${s.id}">${t('common.remove')}</button></td></tr>`)}</tbody></table></div>` : html`<p class="muted">${t('team.noStaff')}</p>`}
        <h3>${t('team.addStaff')}</h3>
        <form id="staff-form" novalidate><div class="form-alert"></div><div class="row">
          <div class="field"><label for="s-name">${t('team.name')}</label><input id="s-name" name="name" required></div>
          <div class="field"><label for="s-email">${t('team.email')}</label><input id="s-email" name="email" type="email" required></div>
          <div class="field"><label for="s-pw">${t('team.tempPassword')}</label><input id="s-pw" name="password" type="password" autocomplete="new-password" required></div></div>
          <button class="btn" type="submit">${t('team.addStaffBtn')}</button></form></div>
      <div class="toolbar" style="margin-top:2rem"><h2>${t('team.branches')}</h2><button class="btn" data-add-branch>${icon('plus', { size: 16 })} ${t('team.addBranch')}</button></div>
      <div class="card">${usageMeter(t('usage.branches'), branches.filter((b) => b.isActive).length, lim.branches)}
        ${branches.length ? html`<div class="table-wrap" style="margin:1rem 0"><table><thead><tr><th class="num">#</th><th>${t('team.branchName')}</th><th>${t('field.address')}</th><th>${t('branch.location')}</th><th>${t('team.status')}</th><th></th></tr></thead><tbody>
          ${branches.map((b, i) => html`<tr><td class="num"><span class="pin-dot" style="background:${pinColor(i)}">${i + 1}</span></td><td><strong>${branchLabel(b)}</strong>${b.phone ? html`<div class="muted small" dir="ltr">${b.phone}</div>` : ''}</td><td>${b.address || '—'}</td>
            <td>${hasLocation(b) ? html`<span class="small" dir="ltr">${b.latitude.toFixed(5)}, ${b.longitude.toFixed(5)}</span>` : html`<span class="badge warn">${t('branch.noLocation')}</span>`}</td>
            <td><span class="badge nocap ${b.isActive ? 'active' : 'cancelled'}">${b.isActive ? t('team.active') : t('team.disabled')}</span></td>
            <td class="right"><button class="btn secondary sm" data-edit-branch="${b.id}">${t('common.edit')}</button> <button class="btn danger sm" data-del-branch="${b.id}">${t('common.remove')}</button></td></tr>`)}</tbody></table></div>
          ${branches.some(hasLocation) ? html`<h3>${t('branch.overview')}</h3><div id="branch-overview"></div>` : ''}` : html`<div class="empty"><strong>${t('flow.noBranchesTitle')}</strong>${t('flow.noBranchesText')}<br><br><button class="btn" data-add-branch>${icon('plus', { size: 16 })} ${t('flow.addFirstBranch')}</button></div>`}</div>`);
    if (branches.some(hasLocation)) mountBranchesOverview($('#branch-overview'), branches.map((b) => ({ ...b, name: branchLabel(b) })));
    onSubmit($('#staff-form'), async (d) => { await api('/manage/staff', { method: 'POST', body: d }); toast(t('team.staffAdded'), 'ok'); reload(); });
    panel.onclick = async (e) => {
      const tg = e.target.closest('[data-toggle],[data-del-staff],[data-del-branch],[data-add-branch],[data-edit-branch]');
      if (!tg) return;
      try {
        if (tg.dataset.addBranch !== undefined) { await branchDialog(null, () => reload()); return; }
        if (tg.dataset.editBranch) { await branchDialog(branches.find((b) => String(b.id) === tg.dataset.editBranch), () => reload()); return; }
        if (tg.dataset.toggle) await api(`/manage/staff/${tg.dataset.toggle}`, { method: 'PATCH', body: { isActive: tg.dataset.active !== 'true' } });
        else if (tg.dataset.delStaff) { if (!await confirmDialog(t('team.removeStaff'), { confirmLabel: t('common.remove'), danger: true })) return; await api(`/manage/staff/${tg.dataset.delStaff}`, { method: 'DELETE' }); }
        else if (tg.dataset.delBranch) { if (!await confirmDialog(t('team.removeBranch'), { confirmLabel: t('common.remove'), danger: true })) return; await api(`/manage/branches/${tg.dataset.delBranch}`, { method: 'DELETE' }); }
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
    const interval = (i) => label('sub.interval', i);
    const priceLabel = (p) => (p.priceCents ? t('sub.price', { amount: m(p.priceCents), interval: interval(p.billingInterval) }) : t('sub.free'));
    const rank = (p) => p.priceCents;
    const statusTone = ['active', 'trialing'].includes(sub.status) ? 'ok' : ['past_due'].includes(sub.status) ? 'warn' : 'err';
    render(panel, html`<div class="toolbar"><h2>${t('sub.title')}</h2></div>
      ${['expired', 'cancelled'].includes(sub.status) ? html`<div class="alert err" role="alert"><strong>${t('sub.endedHead', { status: subStatus(sub.status) })}</strong> ${inv ? t('sub.endedPay') : t('sub.endedChoose')}</div>` : ''}
      ${sub.status === 'past_due' ? html`<div class="alert warn" role="alert"><strong>${t('sub.pastDueHead')}</strong> ${t('sub.pastDueText', { date: fmtDay(sub.endDate) })}</div>` : ''}
      ${sub.status === 'trialing' ? html`<div class="alert info">${t('sub.trialInfo', { plan: planName(sub.plan), date: fmtDay(sub.trialEnd) })}</div>` : ''}
      <div class="grid cols-2">
        <div class="card"><h3 style="margin:0">${t('sub.currentPlan', { plan: planName(sub.plan) })}</h3>
          <p style="margin:.25rem 0"><span class="badge nocap ${statusTone}">${subStatus(sub.status)}</span> ${sub.cancelledAt ? html`<span class="badge nocap warn">${t('sub.endsOn', { date: fmtDay(sub.endDate) })}</span>` : ''}</p>
          <p class="muted">${priceLabel({ priceCents: sub.priceCents, billingInterval: sub.billingInterval })}${sub.nextBillingDate ? ` · ${t('sub.nextBillingDate', { date: fmtDay(sub.nextBillingDate) })}` : sub.priceCents ? '' : ` · ${t('sub.noBilling')}`}</p>
          ${sub.autoRenewal?.available ? html`<p class="small">${t('sub.autoRenewal')} ${sub.autoRenewal.savedCard ? html`<span class="badge nocap ok">${t('sub.on')}</span> <bdi>${sub.autoRenewal.savedCard.brand || ''} ${sub.autoRenewal.savedCard.last4 ? '•••• ' + sub.autoRenewal.savedCard.last4 : ''}</bdi> <button class="btn secondary sm" data-remove-card>${t('sub.turnOff')}</button>` : html`<span class="badge nocap warn">${t('sub.off')}</span> ${t('sub.manualInvoices')}`}</p>` : html`<p class="muted small">${t('sub.manualRenewals')}</p>`}
          ${sub.priceCents && !sub.cancelledAt && ['active', 'trialing'].includes(sub.status) ? html`<button class="btn danger sm" data-cancel>${t('sub.cancelAtEnd')}</button>` : ''}</div>
        <div class="card"><h3 style="margin:0 0 .5rem">${t('sub.usageTitle')}</h3>
          ${usageMeter(t('usage.menuItems'), sub.usage.menuItems, lim.menuItems)}${usageMeter(t('usage.staff'), sub.usage.staff, lim.staff)}${usageMeter(t('usage.branches'), sub.usage.branches, lim.branches)}${usageMeter(t('usage.ordersMonth'), sub.usage.ordersPerMonth, lim.ordersPerMonth)}</div></div>
      ${inv ? html`<div class="card" style="margin-top:1rem;border-color:var(--brand)"><h3 style="margin-top:0">${t('sub.invoiceDue', { id: inv.id, amount: m(inv.amountCents) })}</h3>
        <p class="muted">${fmtDay(inv.periodStart)} – ${fmtDay(inv.periodEnd)}</p>
        ${sub.autoRenewal?.available && !sub.autoRenewal.savedCard ? html`<div class="check"><input type="checkbox" id="save-card"><label for="save-card">${t('sub.saveCard')}</label></div>
          <div class="field" style="max-width:260px"><label for="save-phone">${t('sub.savePhone')}</label><input id="save-phone" inputmode="tel" dir="ltr" placeholder="+9665…"></div>` : ''}
        ${cardPaymentsAvailable ? html`<button class="btn" data-pay="${inv.id}">${t('sub.payNow')}</button>` : html`<div class="alert warn" style="margin:0">${t('sub.noOnlinePay', { id: inv.id })}</div>`}</div>` : ''}
      <h3 style="margin-top:1.5rem">${t('sub.plans')}</h3>
      <div class="grid cols-4">${plans.map((p) => {
    const current = p.code === sub.plan.code && !['expired', 'cancelled'].includes(sub.status);
    const btn = current ? t('sub.btn.current') : p.trialDays && !sub.trialEnd && p.priceCents ? t('sub.btn.trial', { n: p.trialDays }) : rank(p) > sub.priceCents ? t('sub.btn.upgrade', { plan: planName(p) }) : p.priceCents ? t('sub.btn.switch', { plan: planName(p) }) : t('sub.btn.downgrade', { plan: planName(p) });
    return html`<article class="card plan ${current ? 'current' : ''}"><h3>${planName(p)}</h3><div class="price">${p.priceCents ? m(p.priceCents) : t('sub.free')}<span class="muted small">${p.priceCents ? ` / ${interval(p.billingInterval)}` : ''}</span></div>
          <p class="muted small">${planDesc(p)}</p>
          <ul>${planHighlights(p).map((h) => html`<li>${h}</li>`)}</ul>
          ${current ? html`<button class="btn secondary block" disabled>${t('sub.btn.current')}</button>` : html`<button class="btn ${rank(p) > sub.priceCents ? '' : 'secondary'} block" data-plan="${p.code}">${btn}</button>`}</article>`;
  })}</div>
      <h3 style="margin-top:1.5rem">${t('sub.billingHistory')}</h3>
      ${invoices.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('sub.col.invoice')}</th><th>${t('sub.col.period')}</th><th class="num">${t('sub.col.amount')}</th><th>${t('sub.col.status')}</th><th>${t('sub.col.paid')}</th></tr></thead><tbody>
        ${invoices.map((i) => html`<tr><td>#${i.id}</td><td>${fmtDay(i.periodStart)} – ${fmtDay(i.periodEnd)}</td><td class="num">${m(i.amountCents)}</td><td><span class="badge nocap ${i.status === 'paid' ? 'ok' : i.status === 'open' ? 'warn' : ''}">${label('sub.inv', i.status)}</span></td><td>${i.paidAt ? fmtDay(i.paidAt) : '—'}</td></tr>`)}</tbody></table></div>` : emptyState(t('sub.noInvoices'), t('sub.noInvoicesText'))}
      <p class="muted small" style="margin-top:1rem">${t('sub.separate')}</p>`);
    panel.onclick = async (e) => {
      try {
        const pl = e.target.closest('[data-plan]');
        if (pl) {
          pl.disabled = true;
          const r = await api('/manage/subscription/change', { method: 'POST', body: { planCode: pl.dataset.plan } });
          if (r.paymentUrl) { sessionStorage.setItem('dash.invoicePaying', String(r.invoice.id)); location.href = r.paymentUrl; return; }
          toast(r.applied ? (r.trial ? t('sub.trialStarted') : t('sub.planChanged')) : t('sub.invoiceCreated'), 'ok');
          return reload();
        }
        if (e.target.closest('[data-remove-card]') && await confirmDialog(t('sub.confirmStopAuto'), { confirmLabel: t('sub.turnOff') })) { await api('/manage/subscription/payment-method', { method: 'DELETE' }); toast(t('sub.autoOff'), 'ok'); return reload(); }
        const pay = e.target.closest('[data-pay]');
        if (pay) { const saveCard = !!document.getElementById('save-card')?.checked;
          const r = await api(`/manage/invoices/${pay.dataset.pay}/pay`, { method: 'POST', body: saveCard ? { saveCard: true, phone: document.getElementById('save-phone')?.value } : {} }); sessionStorage.setItem('dash.invoicePaying', pay.dataset.pay); location.href = r.paymentUrl; }
        if (e.target.closest('[data-cancel]') && await confirmDialog(t('sub.confirmCancel'), { confirmLabel: t('sub.cancelBtn'), danger: true })) {
          await api('/manage/subscription/cancel', { method: 'POST' }); toast(t('sub.willEnd'), 'ok'); reload();
        }
      } catch (err) { toast(err, 'err'); route(); }
    };
  },

  async settings(panel) {
    const r = ctx.restaurant;
    const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const hours = r.openingHours || {};
    render(panel, html`<div class="toolbar"><h2>${t('dash.tab.settings')}</h2></div>
      <form class="card" id="settings" novalidate><div class="form-alert"></div>
        <div style="display:flex;gap:1rem;align-items:center;margin-bottom:1rem;flex-wrap:wrap"><img src="${r.logoUrl || '/Images/Restaurants/download.png'}" alt="${t('prof.logoAlt')}" width="72" height="72" style="border-radius:12px;object-fit:cover">
          <div class="field" style="margin:0"><label for="logo">${t('prof.logo')}</label><input id="logo" type="file" accept="image/png,image/jpeg,image/webp"></div>
          <div class="field" style="margin:0"><label for="cover">${t('prof.cover')}</label><input id="cover" type="file" accept="image/png,image/jpeg,image/webp"></div></div>
        <div class="field"><label for="name">${t('prof.nameCanonical')}</label><input id="name" name="name" data-field="name" value="${r.name}" required maxlength="100"><div class="hint">${t('prof.nameHint')}</div></div>
        <div class="field"><label for="description">${t('field.description')}</label><textarea id="description" name="description" data-field="description" maxlength="1000">${r.description}</textarea></div>
        <fieldset class="field fieldset"><legend>${t('prof.bilingualTitle')}</legend>
          <p class="muted small" style="margin-top:0">${t('prof.bilingualHint')}</p>
          <div class="lang-pair">
            <div class="field"><label for="nameAr">${t('field.nameAr')} <span class="tag">AR</span></label><input id="nameAr" name="nameAr" data-field="nameAr" dir="rtl" lang="ar" maxlength="100" value="${r.nameAr || ''}"></div>
            <div class="field"><label for="nameEn">${t('field.nameEn')} <span class="tag">EN</span></label><input id="nameEn" name="nameEn" data-field="nameEn" dir="ltr" lang="en" maxlength="100" value="${r.nameEn || ''}"></div>
            <div class="field"><label for="descriptionAr">${t('field.descriptionAr')} <span class="tag">AR</span></label><textarea id="descriptionAr" name="descriptionAr" data-field="descriptionAr" dir="rtl" lang="ar" maxlength="1000">${r.descriptionAr || ''}</textarea></div>
            <div class="field"><label for="descriptionEn">${t('field.descriptionEn')} <span class="tag">EN</span></label><textarea id="descriptionEn" name="descriptionEn" data-field="descriptionEn" dir="ltr" lang="en" maxlength="1000">${r.descriptionEn || ''}</textarea></div>
          </div></fieldset>
        <div class="row"><div class="field"><label for="phone">${t('prof.phone')}</label><input id="phone" name="phone" data-field="phone" dir="ltr" value="${r.phone || ''}"></div>
          <div class="field"><label for="whatsapp">${t('field.whatsapp')}</label><input id="whatsapp" name="whatsapp" data-field="whatsapp" dir="ltr" value="${r.whatsapp || ''}" placeholder="+9665…"></div>
          <div class="field"><label for="email">${t('prof.contactEmail')}</label><input id="email" name="email" data-field="email" type="email" dir="ltr" value="${r.email || ''}"></div></div>
        <div class="row"><div class="field"><label for="address">${t('field.address')}</label><input id="address" name="address" value="${r.address || ''}"></div>
          <div class="field"><label for="city">${t('field.city')}</label><input id="city" name="city" value="${r.city || ''}"></div></div>
        <div class="row">
          <div class="field"><label for="deliveryFee">${t('prof.deliveryFee', { currency: r.currency })}</label><input id="deliveryFee" name="deliveryFee" data-field="deliveryFee" inputmode="decimal" value="${fromCents(r.deliveryFeeCents)}"></div>
          <div class="field"><label for="minOrder">${t('prof.minOrder', { currency: r.currency })}</label><input id="minOrder" name="minOrder" data-field="minOrder" inputmode="decimal" value="${fromCents(r.minOrderCents)}"></div>
          <div class="field"><label for="tax">${t('prof.tax')}</label><input id="tax" name="tax" data-field="tax" inputmode="decimal" value="${(r.taxRateBp / 100).toString()}"></div></div>
        <fieldset class="field fieldset"><legend>${t('prof.hours')}</legend>
          <p class="muted small" style="margin-top:0">${t('prof.hoursHint')} ${t('prof.timezone')}:
            <input id="timezone" name="timezone" dir="ltr" value="${r.timezone}" style="width:12rem;display:inline-block" aria-label="${t('prof.timezone')}"></p>
          <div class="hours-grid">${DAYS.map((d) => html`<strong>${t(`prof.day.${d}`)}</strong>
            <input type="time" dir="ltr" name="open-${d}" value="${hours[d]?.[0]?.open || ''}" aria-label="${t('prof.opens', { day: t(`prof.day.${d}`) })}"><input type="time" dir="ltr" name="close-${d}" value="${hours[d]?.[0]?.close || ''}" aria-label="${t('prof.closes', { day: t(`prof.day.${d}`) })}">`)}</div></fieldset>
        <div class="field check"><input type="checkbox" id="acceptingOrders" name="acceptingOrders" ${r.acceptingOrders ? raw('checked') : ''}><label for="acceptingOrders">${t('prof.accepting')}</label></div>
        <button class="btn" type="submit">${t('prof.save')}</button></form>`);
    const upload = async (file) => (await api('/manage/uploads', { method: 'POST', raw: true, body: file, headers: { 'Content-Type': file.type } })).url;
    onSubmit($('#settings'), async (d) => {
      const openingHours = {};
      for (const k of DAYS) if (d[`open-${k}`] && d[`close-${k}`]) openingHours[k] = [{ open: d[`open-${k}`], close: d[`close-${k}`] }];
      const body = {
        name: d.name, description: d.description, nameAr: d.nameAr, nameEn: d.nameEn, descriptionAr: d.descriptionAr, descriptionEn: d.descriptionEn,
        phone: d.phone || null, whatsapp: d.whatsapp || null, email: d.email || null,
        address: d.address || null, city: d.city || null, acceptingOrders: d.acceptingOrders, timezone: d.timezone,
        openingHours: Object.keys(openingHours).length ? openingHours : null,
        deliveryFeeCents: toCents(d.deliveryFee || 0), minOrderCents: toCents(d.minOrder || 0),
        taxRateBp: Math.round(parseFloat(String(d.tax || 0).replace(',', '.')) * 100),
      };
      for (const [field, key] of [['deliveryFee', 'deliveryFeeCents'], ['minOrder', 'minOrderCents'], ['tax', 'taxRateBp']]) {
        if (Number.isNaN(body[key])) throw Object.assign(new Error('invalid_money'), { code: 'validation_error', details: { field, reason: 'invalid_money' } });
      }
      if ($('#logo').files[0]) body.logoUrl = await upload($('#logo').files[0]);
      if ($('#cover').files[0]) body.coverUrl = await upload($('#cover').files[0]);
      await api('/manage/restaurant', { method: 'PUT', body });
      toast(t('prof.saved'), 'ok');
      reload();
    });
  },
};

// ---------------- helpers ----------------
const ACCOUNT_TONE = { VERIFIED: 'ok', UNDER_REVIEW: 'warn', PENDING: 'warn', NOT_STARTED: 'warn', REJECTED: 'err', SUSPENDED: 'err', DISABLED: 'err' };
function paymentAccountBlock(a, withApply = false) {
  if (!a.providerEnabled) return html`<p class="muted">${t('pa.notEnabled')}</p>`;
  const tone = ACCOUNT_TONE[a.displayStatus] || 'warn';
  const statusText = has(`pa.status.${a.displayStatus}`) ? t(`pa.status.${a.displayStatus}`) : a.displayStatus;
  const canApply = withApply && ['NOT_STARTED', 'REJECTED', 'PENDING'].includes(a.displayStatus);
  return html`<table><tbody>
    <tr><td>${t('pa.accountStatus')}</td><td><span class="badge nocap ${tone}">${statusText}</span></td></tr>
    <tr><td>${t('pa.provider')}</td><td><bdi>${cap(a.provider)} (${a.environment})</bdi></td></tr>
    <tr><td>${t('pa.kyc')}</td><td>${label('pa.kycValue', a.kycStatus)}</td></tr>
    <tr><td>${t('pa.currency')}</td><td><bdi>${a.settlementCurrency || '—'}</bdi></td></tr>
    <tr><td>${t('pa.schedule')}</td><td>${t('pa.scheduleValue')}</td></tr>
    <tr><td>${t('pa.bank')}</td><td><bdi>${a.maskedBank || '—'}</bdi></td></tr>
    <tr><td>${t('pa.lastVerified')}</td><td>${a.lastVerifiedAt ? fmtDay(a.lastVerifiedAt) : '—'}</td></tr>
    <tr><td>${t('pa.onlineForCustomers')}</td><td><span class="badge nocap ${a.onlinePaymentsEnabled ? 'ok' : 'warn'}">${a.onlinePaymentsEnabled ? t('pa.enabled') : t('pa.notEnabledBadge')}</span></td></tr></tbody></table>
    ${a.rejectionReason ? html`<div class="alert err small">${t('pa.reason', { reason: a.rejectionReason })}</div>` : ''}
    ${a.onlinePaymentsEnabled ? '' : html`<p class="muted small">${t('pa.verifyNote')}</p>`}
    ${canApply ? html`<button class="btn" data-apply-payout>${a.displayStatus === 'PENDING' ? t('pa.update') : t('pa.setup')}</button>` : ''}`;
}

function payoutApplicationDialog(acctApp) {
  const dlg = document.createElement('dialog');
  dlg.setAttribute('aria-labelledby', 'pa-title');
  dlg.innerHTML = html`<h2 id="pa-title">${t('pa.dialogTitle')}</h2>
    <p class="muted small">${t('pa.dialogText')}</p>
    <form id="pa-apply" novalidate><div class="form-alert"></div>
      <div class="field"><label for="pa-ln">${t('pa.legalName')}</label><input id="pa-ln" name="legalName" data-field="legalName" required maxlength="150" value="${acctApp?.legalName || ''}"></div>
      <div class="field"><label for="pa-cr">${t('pa.regNumber')}</label><input id="pa-cr" name="registrationNumber" data-field="registrationNumber" dir="ltr" required maxlength="40" value="${acctApp?.registrationNumber || ''}"></div>
      <div class="row"><div class="field"><label for="pa-cn">${t('pa.contactName')}</label><input id="pa-cn" name="contactName" data-field="contactName" required maxlength="100" value="${acctApp?.contactName || ''}"></div>
        <div class="field"><label for="pa-cp">${t('pa.contactPhone')}</label><input id="pa-cp" name="contactPhone" data-field="contactPhone" required inputmode="tel" dir="ltr" value="${acctApp?.contactPhone || ''}"></div></div>
      <div class="field"><label for="pa-ce">${t('pa.contactEmail')}</label><input id="pa-ce" name="contactEmail" data-field="contactEmail" type="email" dir="ltr" required maxlength="150" value="${acctApp?.contactEmail || ''}"></div>
      <div class="actions-row"><button class="btn" type="submit">${t('pa.submit')}</button><button class="btn secondary" type="button" data-close>${t('common.cancel')}</button></div></form>`.s;
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dlg.close(); });
  wireDialog(dlg);
  onSubmit($('#pa-apply', dlg), async (d) => {
    await api('/manage/payment-account/apply', { method: 'POST', body: d });
    toast(t('pa.submitted'), 'ok');
    dlg.close();
    route();
  }, { alertBox: $('#pa-apply .form-alert', dlg) });
}

function usageMeter(labelText, used, limit) {
  const pct = limit === null ? 0 : Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  return html`<div style="margin-bottom:.75rem"><div style="display:flex;justify-content:space-between" class="small"><span>${labelText}</span><span class="muted">${used} / ${limit === null ? t('usage.unlimited') : limit}</span></div>
    <div class="meter ${limit !== null && used >= limit ? 'full' : ''}" role="progressbar" aria-label="${labelText}" aria-valuenow="${used}" aria-valuemin="0" aria-valuemax="${limit ?? used}"><div style="width:${limit === null ? 8 : pct}%"></div></div></div>`;
}

function lockedPanel(title, text) {
  return html`<div class="locked"><h2>${title}</h2><p class="muted">${text}</p></div>`;
}

const NEXT = {
  pending: [['confirmed', 'orders.accept']],
  confirmed: [['preparing', 'orders.startPreparing']],
  preparing: [['ready', 'orders.markReady']],
};
// One order as the kitchen needs to see it: every dish with its extras (and how many of each), the customer's own words for that dish
// highlighted, and the price snapshot. General extras (water, fries ...) are separate lines of their own. Names appear in the dashboard
// language with a fallback to the other one.
function orderCard(o) {
  let next = NEXT[o.status] || [];
  if (o.status === 'ready') next = [o.orderType === 'pickup' ? ['delivered', 'orders.handedOver'] : ['out_for_delivery', 'orders.outForDelivery']];
  if (o.status === 'out_for_delivery') next = [['delivered', 'orders.delivered']];
  const canClose = ['pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery'].includes(o.status);
  const paid = o.paymentMethod === 'card';
  return html`<article class="card order-card">
    <header><div><strong>#${o.orderNumber}</strong> <span class="muted small">${fmtDate(o.createdAt)}</span></div><span class="badge ${o.status}">${statusLabel(o.status)}</span></header>
    <div><strong>${o.customerName}</strong> · <a href="tel:${o.customerPhone}" dir="ltr">${o.customerPhone}</a> · ${o.orderType === 'delivery' ? t('order.delivery') : t('order.pickup')}${o.branchName ? html` · <span class="badge nocap">${t('order.branch', { name: o.branchName })}</span>` : ''}</div>
    ${o.deliveryAddress ? html`<div class="muted small icon-line">${icon('pin', { size: 14 })} ${o.deliveryAddress}</div>` : ''}
    <ul class="order-lines">${o.items.map((i) => (i.kind === 'extra'
    ? html`<li class="line-extra-only"><strong>${i.quantity} × ${loc(i)}</strong> <span class="badge nocap">${t('gx.lineBadge')}</span> <bdi class="muted small">(${m(i.lineTotalCents)})</bdi></li>`
    : html`<li><strong>${i.quantity} × ${loc(i)}</strong>
      ${i.originalUnitPriceCents != null && i.baseUnitPriceCents != null && i.originalUnitPriceCents > i.baseUnitPriceCents ? html` <span class="small"><span class="price-was">${m(i.originalUnitPriceCents)}</span> ${m(i.baseUnitPriceCents)}</span>` : ''}
      ${i.options.length ? html`<ul class="line-extras">${i.options.map((x) => html`<li>+ ${loc(x)}${x.quantity > 1 ? ` × ${x.quantity}` : ''} <bdi>(${m(x.priceCents * x.quantity)})</bdi></li>`)}</ul>` : ''}
      ${i.instructions ? html`<div class="line-note"><strong>${t('cart.instructions')}:</strong> ${i.instructions}</div>` : ''}</li>`))}</ul>
    ${o.notes ? html`<div class="alert info small" style="margin:0">${t('order.notes')}: ${o.notes}</div>` : ''}
    ${o.couponCode ? html`<div class="small"><span class="badge sale nocap"><bdi dir="ltr">${o.couponCode}</bdi></span> ${t('coupon.orderLine', { amount: m(o.couponDiscountCents) })}</div>` : ''}
    <div class="actions-row"><strong style="margin-inline-end:auto">${m(o.totalCents)}
      ${paid ? html`<span class="badge ${['refunded', 'partially_refunded'].includes(o.paymentStatus) ? 'warn' : 'ok'}">${o.paymentStatus === 'paid' ? t('orders.paidOnline') : payLabel(o.paymentStatus)}</span>`
    : o.paymentStatus === 'cash_collected' ? raw(`<span class="badge ok">${t('orders.cashCollected')}</span>`)
      : o.paymentStatus === 'cancelled' ? raw(`<span class="badge">${t('orders.noPayment')}</span>`) : html`<span class="badge warn">${t('orders.collectCash', { amount: m(o.totalCents) })}</span>`}</strong>
      ${next.map(([st, lbl]) => raw(`<button class="btn sm" data-id="${o.id}" data-status="${st}">${t(lbl)}</button>`))}
      ${canClose ? raw(`<button class="btn danger sm" data-id="${o.id}" data-status="${o.status === 'pending' ? 'rejected' : 'cancelled'}" data-paid="${paid ? 1 : 0}">${o.status === 'pending' ? t('orders.decline') : t('common.cancel')}</button>`) : ''}</div>
  </article>`;
}

boot();
