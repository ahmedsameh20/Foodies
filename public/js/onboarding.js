import {
  api, session, requireRoles, mountChrome, publicConfig, draft, $, render, html, raw, money, fmtDay, onSubmit, toast, spinner, errorBox, showFieldErrors, t, loc, planName, planDesc, planHighlights,
} from './common.js';
import { mountPhoneInput } from './phone-input.js';
import { icon } from './icons.js';
import { mountMapPicker } from './map-picker.js';
import { chosenPlan, forgetPlan } from './plan-choice.js';

mountChrome();
const user = requireRoles('owner');

// Plans (chosen before registering) -> account -> plan confirmed -> restaurant profile (+ optional map location) -> review & create -> subscription
// activation / payment (only when the plan needs it) -> platform review -> live. Branches are NOT part of registration: the owner adds them
// afterwards in Dashboard -> Team & branches (the status page offers it).
// What the owner types is kept (this tab only) while they move back and forth. The restaurant is created in ONE request, safe to retry.
// The chosen plan lives on the SERVER (users.pending_plan_code, via /api/onboarding/plan); only its code is ever sent, the price is read from the plans table.
const STEPS = ['onboarding.stepAccount', 'flow.stepPlan', 'onboarding.stepRestaurant', 'flow.stepConfirm', 'onboarding.stepReview'];
function steps(n) {
  render($('#steps'), html`${STEPS.map((s, i) => html`<li ${i === n ? raw('aria-current="step"') : ''} style="${i === n ? 'font-weight:700;color:var(--brand)' : ''}">${i + 1}. ${t(s)}${i < n ? html` ${icon('check', { size: 14 })}` : ''}</li>`)}`);
}

// The server's view of the plan choice: { plan: chosen plan or null, plans: all active plans }
const P = { plan: null, plans: [], hasRestaurant: false };

async function loadPlanState() {
  let state = await api('/onboarding/plan');
  P.hasRestaurant = !!state.hasRestaurant;
  if (P.hasRestaurant) return; // the restaurant exists already (created in another tab / device): nothing to choose
  // a plan picked on the plans page while signed out (or on the sign-in page) is handed to the server once; after that the server decides
  const local = chosenPlan();
  if (local && (!state.plan || state.plan.code !== local) && state.plans.some((p) => p.code === local)) {
    state = { ...state, ...(await api('/onboarding/plan', { method: 'PUT', body: { planCode: local } })) };
  }
  if (local) forgetPlan();
  P.plan = state.plan; P.plans = state.plans;
}

async function start() {
  if (user.restaurantId) return statusStep();
  steps(1);
  render($('#step'), spinner());
  try { await loadPlanState(); } catch (e) {
    if (e.code === 'already_onboarded') return statusStep();
    return render($('#step'), errorBox(e));
  }
  if (P.hasRestaurant) return statusStep();
  return P.plan ? profileStep() : planStep();
}

// The text fields of the restaurant form that are kept as a draft (the logo file cannot be).
const DRAFT_FIELDS = ['ownerName', 'ownerPhone', 'name', 'description', 'phone', 'whatsapp', 'email', 'city', 'address'];

// Wizard state that is not a plain form field: the restaurant's map location and the key that makes the final request safe to retry.
const W = { loc: null, key: null, logo: null };
(function restoreWizard() {
  const s = draft.load('onboarding.wiz');
  if (s) { W.loc = s.loc || null; W.key = s.key || null; }
  if (!W.key) W.key = `reg_${crypto.randomUUID().replace(/-/g, '')}`;
}());
const saveWizard = () => draft.save('onboarding.wiz', { loc: W.loc, key: W.key });

let currencyCode = 'USD';
const planPrice = (p) => (p.priceCents ? `${money(p.priceCents, currencyCode)} / ${t(`sub.interval.${p.billingInterval}`)}` : t('onboarding.free'));

// ---- step: the plan. Shown first when no plan has been chosen yet, and again when the owner wants to change it.
async function planStep() {
  steps(1);
  render($('#step'), spinner());
  try { currencyCode = (await publicConfig()).currency; if (!P.plans.length) await loadPlanState(); } catch (e) { return render($('#step'), errorBox(e)); }
  render($('#step'), html`<h1>${t('flow.choosePlanTitle')}</h1>
    <p class="muted">${t('flow.choosePlanIntro')}</p>
    <div class="grid cols-4">${P.plans.map((p) => html`<article class="card plan ${P.plan && p.code === P.plan.code ? 'current' : ''}"><h3>${planName(p)}</h3>
      <div class="price">${planPrice(p)}</div>
      ${p.trialDays && p.priceCents ? html`<p><span class="badge ok">${t('onboarding.trialDays', { n: p.trialDays })}</span></p>` : ''}
      <p class="muted small">${planDesc(p)}</p>
      <ul>${planHighlights(p).map((h) => html`<li>${h}</li>`)}<li>${t('plans.limitBranches', { n: p.limits.branches ?? t('sub.unlimited') })}</li></ul>
      <button class="btn ${P.plan && p.code === P.plan.code ? '' : 'secondary'} block" data-plan="${p.code}">${P.plan && p.code === P.plan.code ? t('plans.selected') : t('plans.select')}</button></article>`)}</div>`);
  $('#step').onclick = async (e) => {
    const b = e.target.closest('[data-plan]');
    if (!b) return;
    b.disabled = true;
    try {
      const r = await api('/onboarding/plan', { method: 'PUT', body: { planCode: b.dataset.plan } });
      P.plan = r.plan;
      if (r.plan) W.key = `reg_${crypto.randomUUID().replace(/-/g, '')}`; // a different plan is a different request: new retry key
      saveWizard();
      profileStep();
    } catch (err) { toast(err, 'err'); b.disabled = false; }
  };
}

const planBanner = () => html`<div class="alert info" role="status" style="display:flex;gap:.75rem;align-items:center;justify-content:space-between;flex-wrap:wrap">
  <span><strong>${t('register.selectedPlan')}</strong> ${planName(P.plan)} — ${planPrice(P.plan)}</span><button type="button" class="btn secondary sm" data-change-plan>${t('register.changePlan')}</button></div>`;

async function profileStep() {
  steps(2);
  render($('#step'), spinner());
  // The owner's own details always come from the account on the server (never from another user's cache or draft).
  let me;
  try { currencyCode = (await publicConfig()).currency; ({ user: me } = await api('/auth/me')); } catch (e) { return render($('#step'), errorBox(e)); }
  session.set({ ...session.user, name: me.name, phone: me.phone });
  const saved = draft.load('onboarding') || {};
  const v = (k, fromAccount = '') => saved[k] ?? fromAccount;

  render($('#step'), html`<div class="card">
    <h1>${t('onboarding.heading')}</h1>
    ${planBanner()}
    <p class="muted">${t('flow.intro')}</p>
    <form id="form" novalidate>
      <div class="form-alert"></div>
      <h2 style="font-size:1.1rem">${t('onboarding.ownerSection')}</h2>
      <p class="muted small">${t('onboarding.ownerHint')}</p>
      <div class="row">
        <div class="field"><label for="ownerName">${t('field.fullName')}</label><input id="ownerName" name="ownerName" data-field="ownerName" required maxlength="100" autocomplete="name" value="${v('ownerName', me.name)}"></div>
        <div class="field"><label for="ownerEmail">${t('field.email')}</label><input id="ownerEmail" type="email" value="${me.email}" readonly aria-describedby="ownerEmailHint"><div class="hint" id="ownerEmailHint">${t('onboarding.emailLocked')}</div></div>
      </div>
      <div id="owner-phone"></div>
      ${me.phone ? '' : html`<div class="alert warn small">${t('onboarding.phoneMissing')}</div>`}

      <h2 style="font-size:1.1rem;margin-top:1.5rem">${t('onboarding.restaurantSection')}</h2>
      <div class="field"><label for="name">${t('onboarding.restaurantName')}</label><input id="name" name="name" data-field="name" required maxlength="100" value="${v('name')}"><div class="hint">${t('onboarding.pageAddress')} <code dir="ltr">/restaurant/<span id="slug-preview">your-name</span></code></div></div>
      <div class="field"><label for="description">${t('field.description')}</label><textarea id="description" name="description" maxlength="1000">${v('description')}</textarea></div>
      <p class="muted small">${t('onboarding.businessHint')}</p>
      <div class="row">
        <div class="field"><label for="phone">${t('onboarding.businessPhone')}</label><input id="phone" name="phone" data-field="phone" type="tel" autocomplete="tel" dir="ltr" value="${v('phone', me.phone || '')}"></div>
        <div class="field"><label for="whatsapp">${t('onboarding.whatsapp')}</label><input id="whatsapp" name="whatsapp" data-field="whatsapp" type="tel" dir="ltr" placeholder="+9665…" value="${v('whatsapp')}"></div>
      </div>
      <div class="row">
        <div class="field"><label for="email">${t('onboarding.businessEmail')}</label><input id="email" name="email" data-field="email" type="email" dir="ltr" value="${v('email', me.email)}"></div>
        <div class="field"><label for="city">${t('field.city')}</label><input id="city" name="city" maxlength="100" value="${v('city')}"></div>
      </div>
      <div class="field"><label for="address">${t('field.address')}</label><input id="address" name="address" maxlength="300" autocomplete="street-address" value="${v('address')}"><div class="hint">${t('onboarding.addressMapHint')}</div></div>
      <h3 style="font-size:1rem;margin:1rem 0 .25rem">${t('onboarding.restaurantLocation')}</h3>
      <div id="rest-map" data-field="latitude"></div>
      <div class="field"><label for="logo">${t('onboarding.logo')}</label><input id="logo" type="file" accept="image/png,image/jpeg,image/webp"><div class="hint">${W.logo ? t('onboarding.logoKept', { name: W.logo.name }) : t('onboarding.logoHint')}</div></div>
      <div class="alert info small">${t('flow.branchesLater')}</div>
      <button class="btn" type="submit">${t('flow.continueConfirm')}</button>
    </form></div>`);

  const form = $('#form');
  const ownerPhone = mountPhoneInput($('#owner-phone'), { id: 'ownerPhone', name: 'ownerPhone', label: t('onboarding.ownerMobile'), value: v('ownerPhone', me.phone || ''), hint: t('onboarding.ownerMobileHint') });
  const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-') || 'your-name';
  const showSlug = () => { $('#slug-preview').textContent = slug($('#name').value); };
  showSlug();
  $('#name').addEventListener('input', showSlug);
  $('#step').onclick = (e) => { if (e.target.closest('[data-change-plan]')) { persist(); planStep(); } };

  // keep what has been typed if validation fails or the visitor leaves and comes back (this tab only, wiped on sign-out)
  const persist = () => {
    const values = {};
    for (const k of DRAFT_FIELDS) if (k !== 'ownerPhone' && form.elements[k]) values[k] = form.elements[k].value;
    values.ownerPhone = ownerPhone.get();
    draft.save('onboarding', values);
  };
  form.addEventListener('input', persist);
  form.addEventListener('change', persist);
  $('#logo').addEventListener('change', (e) => { W.logo = e.target.files[0] || null; });

  // the restaurant's own marker (optional; each branch gets its own location later, in the dashboard)
  let addressTyped = !!form.elements.address.value.trim();
  form.elements.address.addEventListener('input', () => { addressTyped = form.elements.address.value.trim() !== ''; });
  mountMapPicker($('#rest-map'), {
    lat: W.loc?.latitude ?? null, lng: W.loc?.longitude ?? null, label: t('onboarding.restaurantLocation'),
    onChange: (ev) => {
      if (ev.source !== 'reverse') { W.loc = { latitude: ev.latitude, longitude: ev.longitude }; saveWizard(); }
      if (ev.address && (ev.source === 'search' || !addressTyped)) { form.elements.address.value = ev.address.slice(0, 300); addressTyped = ev.source === 'search'; persist(); }
    },
  });

  onSubmit(form, async (d) => {
    if (!String(d.name || '').trim()) throw Object.assign(new Error('name'), { code: 'validation_error', details: { field: 'name', reason: 'required' } });
    persist(); saveWizard();
    confirmStep();
  });
}

// ---- step: review everything (including the plan and its price), then create the restaurant and its subscription in one request
async function confirmStep(error = null) {
  steps(3);
  const p = draft.load('onboarding') || {};
  const cfg = await publicConfig();
  const plan = P.plan;
  const cardOk = !!cfg.paymentMethods?.card;
  const nextText = !plan.priceCents ? t('flow.planFree')
    : plan.trialDays ? t('flow.planTrial', { n: plan.trialDays })
      : cardOk ? t('flow.planPay', { price: planPrice(plan) }) : t('flow.planInvoice', { price: planPrice(plan) });
  render($('#step'), html`<div class="card">
    <h1>${t('onboarding.confirmTitle')}</h1>
    ${error ? errorBox(error) : ''}
    <h2 style="font-size:1.1rem">${t('onboarding.restaurantSection')}</h2>
    <dl class="summary-dl"><dt>${t('onboarding.restaurantName')}</dt><dd>${p.name || '—'}</dd><dt>${t('field.address')}</dt><dd>${[p.address, p.city].filter(Boolean).join(', ') || '—'}</dd>
      <dt>${t('onboarding.restaurantLocation')}</dt><dd dir="ltr">${W.loc ? `${W.loc.latitude}, ${W.loc.longitude}` : '—'}</dd></dl>
    <h2 style="font-size:1.1rem">${t('flow.yourPlan')}</h2>
    <dl class="summary-dl"><dt>${t('onboarding.planLabel')}</dt><dd>${planName(plan)}</dd><dt>${t('flow.price')}</dt><dd>${planPrice(plan)}</dd></dl>
    <div class="alert info small">${nextText}</div>
    <div class="alert info small">${t('flow.branchesLater')}</div>
    <div class="actions-row"><button class="btn" type="button" data-create>${t('onboarding.createRestaurant')}</button><button class="btn secondary" type="button" data-c-back>${t('onboarding.back')}</button>
      <button class="btn secondary" type="button" data-change-plan>${t('register.changePlan')}</button></div></div>`);
  $('#step').onclick = async (e) => {
    if (e.target.closest('[data-c-back]')) return profileStep();
    if (e.target.closest('[data-change-plan]')) return planStep();
    const go = e.target.closest('[data-create]');
    if (!go) return;
    go.disabled = true;
    try { await createAll(p); } catch (err) { goToError(err); }
  };
}

async function createAll(p) {
  const body = { ...p, planCode: P.plan.code }; // the code only: the server prices the subscription from its own plans table
  if (W.loc) { body.latitude = W.loc.latitude; body.longitude = W.loc.longitude; }
  // the same key on every retry: if the first request succeeded but its answer was lost, the retry returns that restaurant (no second restaurant or subscription)
  const { restaurant } = await api('/onboarding/restaurant', { method: 'POST', body, headers: { 'Idempotency-Key': W.key } });
  draft.clear('onboarding'); draft.clear('onboarding.wiz');
  forgetPlan();
  session.set({ ...session.user, restaurantId: restaurant.id, name: p.ownerName, phone: p.ownerPhone });
  if (W.logo) {
    try {
      const up = await api('/manage/uploads', { method: 'POST', raw: true, body: W.logo, headers: { 'Content-Type': W.logo.type } });
      await api('/manage/restaurant', { method: 'PUT', body: { logoUrl: up.url } });
    } catch (e) { toast(t('onboarding.logoFailed', { message: e.friendly || e.message }), 'err'); }
  }
  toast(t('onboarding.created'), 'ok');
  await activateSubscription();
}

// A paid plan without a trial starts unpaid ("expired") with one open invoice; nothing is active until the provider confirms the payment.
// This only sends the owner to the payment page of THAT invoice (no new invoice, so a refresh never duplicates anything).
async function activateSubscription() {
  try {
    const { subscription: sub, cardPaymentsAvailable } = await api('/manage/subscription');
    if (sub.openInvoice && cardPaymentsAvailable) {
      const r = await api(`/manage/invoices/${sub.openInvoice.id}/pay`, { method: 'POST', body: {} });
      sessionStorage.setItem('dash.invoicePaying', String(sub.openInvoice.id));
      location.href = r.paymentUrl;
      return;
    }
  } catch (e) { toast(e, 'err'); }
  statusStep();
}

// A rejected request sends the owner back to the step that holds the problem; nothing typed is lost.
function goToError(err) {
  const field = err?.details?.field || '';
  if (err.code === 'already_onboarded') { draft.clear('onboarding'); draft.clear('onboarding.wiz'); return location.reload(); }
  if (field === 'planCode') { P.plan = null; return planStep(); }
  if (field) {
    profileStep().then(() => { const f = $('#form'); if (f && !showFieldErrors(f, err)) render($('.form-alert', f), errorBox(err)); });
    return;
  }
  confirmStep(err);
}

// The visible onboarding checklist, including the admin-review state.
async function statusStep() {
  steps(4);
  render($('#step'), spinner());
  try {
    const [{ restaurant, paymentAccount: pa }, { subscription: sub }, { branches }] = await Promise.all([api('/manage/restaurant'), api('/manage/subscription'), api('/manage/branches')]);
    const planOk = ['active', 'trialing'].includes(sub.status);
    const approved = restaurant.approvalStatus === 'approved';
    const rejected = restaurant.approvalStatus === 'rejected';
    const nBranches = branches.filter((b) => b.isActive).length;
    const row = (done, title, detail, warn = false) => html`<li style="display:flex;gap:.6rem;margin:.6rem 0"><span class="badge ${done ? 'ok' : warn ? 'err' : 'warn'}" style="height:fit-content">${done ? t('onboarding.done') : warn ? t('onboarding.actionNeeded') : t('onboarding.pending')}</span><span><strong>${title}</strong><div class="muted small">${detail}</div></span></li>`;
    render($('#step'), html`<div class="card"><h1>${loc(restaurant)}</h1>
      ${approved && planOk ? html`<div class="alert ok"><strong>${t('onboarding.live')}</strong> ${t('onboarding.liveAt')} <a href="/restaurant/${restaurant.slug}" dir="ltr">/restaurant/${restaurant.slug}</a>.</div>`
    : rejected ? html`<div class="alert err"><strong>${t('onboarding.rejected')}</strong> ${restaurant.rejectionReason || ''} ${t('onboarding.contactSupport')}</div>`
      : html`<div class="alert info"><strong>${t('onboarding.almost')}</strong> ${planOk ? t('onboarding.visibleWhenApproved') : t('onboarding.visibleWhenApprovedPlan')}</div>`}
      <ul style="list-style:none;padding:0">
        ${row(true, t('onboarding.accountCreated'), session.user.email)}
        ${row(true, t('onboarding.restaurantProfile'), t('onboarding.addressReserved'))}
        ${row(planOk, `${t('onboarding.planLabel')}: ${planName(sub.plan)}`, planOk ? (sub.status === 'trialing' ? t('onboarding.trialUntil', { date: fmtDay(sub.trialEnd) }) : t('onboarding.active')) : sub.openInvoice ? t('onboarding.invoiceWaiting', { n: sub.openInvoice.id }) : t('onboarding.choosePlanShort'), !planOk)}
        ${row(nBranches > 0, t('flow.branchesRow'), nBranches ? t('flow.branchesN', { n: nBranches }) : t('flow.branchesOptional'))}
        ${row(pa.payoutEnabled || !pa.providerEnabled, t('onboarding.payoutAccount'), pa.providerEnabled ? (pa.payoutEnabled ? t('onboarding.payoutVerified') : t('onboarding.payoutPending')) : t('onboarding.payoutOff'))}
        ${row(approved, t('onboarding.platformReview'), approved ? t('onboarding.approved') : rejected ? t('onboarding.notApproved') : t('onboarding.waitingTeam'), rejected)}
        ${row(approved && planOk, t('onboarding.goLive'), approved && planOk ? t('onboarding.isLive') : t('onboarding.goesLive'))}
      </ul>
      <div class="actions-row"><a class="btn" href="/dashboard.html#team">${icon('plus', { size: 16 })} ${nBranches ? t('flow.manageBranches') : t('flow.addFirstBranch')}</a><a class="btn secondary" href="/dashboard.html#menu">${t('onboarding.setupMenu')}</a><a class="btn secondary" href="/dashboard.html">${t('onboarding.openDashboard')}</a>${planOk ? '' : raw(`<a class="btn secondary" href="/dashboard.html#subscription">${t('onboarding.subscription')}</a>`)}</div></div>`);
  } catch (e) { render($('#step'), errorBox(e)); }
}

if (user) start();
