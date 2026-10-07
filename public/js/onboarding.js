import {
  api, session, requireRoles, mountChrome, publicConfig, $, render, html, raw, money, fmtDay, cap, onSubmit, toast, spinner, errorBox,
} from './common.js';

mountChrome();
const user = requireRoles('owner');

// Register -> restaurant profile -> choose plan (trial / payment) -> payout account -> admin review -> live
const STEPS = ['Account', 'Restaurant', 'Plan', 'Review & go live'];
function steps(n) {
  render($('#steps'), html`${STEPS.map((s, i) => html`<li ${i === n ? raw('aria-current="step"') : ''} style="${i === n ? 'font-weight:700;color:var(--brand)' : ''}">${i + 1}. ${s}${i < n ? ' ✓' : ''}</li>`)}`);
}

async function start() {
  if (!user.restaurantId) return profileStep();
  const { subscription: sub } = await api('/manage/subscription');
  // a restaurant that has not chosen a plan yet (still on the automatic default) is sent to the plan step once
  if (sessionStorage.getItem('onboarding.plan') === 'pending' && sub) return planStep();
  return statusStep();
}

function profileStep() {
  steps(1);
  render($('#step'), html`<div class="card">
    <h1>Tell us about your restaurant</h1>
    <p class="muted">This creates your public ordering page. Next you will choose a plan, then our team reviews every new restaurant before it goes live.</p>
    <form id="form" novalidate>
      <div class="form-alert"></div>
      <div class="field"><label for="name">Restaurant name</label><input id="name" name="name" required maxlength="100"><div class="hint">Your page will be at <code>/restaurant/<span id="slug-preview">your-name</span></code></div></div>
      <div class="field"><label for="description">Description</label><textarea id="description" name="description" maxlength="1000"></textarea></div>
      <div class="row">
        <div class="field"><label for="phone">Phone</label><input id="phone" name="phone" type="tel" autocomplete="tel"></div>
        <div class="field"><label for="whatsapp">WhatsApp number</label><input id="whatsapp" name="whatsapp" type="tel" placeholder="+9665…"></div>
      </div>
      <div class="row">
        <div class="field"><label for="email">Contact email</label><input id="email" name="email" type="email"></div>
        <div class="field"><label for="city">City</label><input id="city" name="city" maxlength="100"></div>
      </div>
      <div class="field"><label for="address">Address</label><input id="address" name="address" maxlength="300" autocomplete="street-address"></div>
      <div class="field"><label for="logo">Logo (optional image)</label><input id="logo" type="file" accept="image/png,image/jpeg,image/webp"><div class="hint">PNG, JPEG or WebP, up to 2 MB.</div></div>
      <button class="btn" type="submit">Continue to plans</button>
    </form></div>`);
  const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-') || 'your-name';
  $('#name').addEventListener('input', (e) => { $('#slug-preview').textContent = slug(e.target.value); });
  onSubmit($('#form'), async (d) => {
    const { restaurant } = await api('/onboarding/restaurant', { method: 'POST', body: d });
    session.set({ ...session.user, restaurantId: restaurant.id });
    const file = $('#logo').files[0];
    if (file) {
      try {
        const up = await api('/manage/uploads', { method: 'POST', raw: true, body: file, headers: { 'Content-Type': file.type } });
        await api('/manage/restaurant', { method: 'PUT', body: { logoUrl: up.url } });
      } catch (e) { toast(`Restaurant created, but the logo upload failed: ${e.message}`, 'err'); }
    }
    toast('Restaurant created', 'ok');
    planStep();
  });
}

async function planStep() {
  steps(2);
  render($('#step'), spinner());
  try {
    const { subscription: sub, plans, cardPaymentsAvailable } = await api('/manage/subscription');
    const currency = (await publicConfig()).currency;
    const m = (c) => money(c, currency);
    render($('#step'), html`<h1>Choose a plan</h1>
      <p class="muted">You can change plan at any time from your dashboard. Paid plans start with a free trial where offered.</p>
      <div class="grid cols-4">${plans.map((p) => html`<article class="card plan ${p.code === sub.plan.code ? 'current' : ''}"><h3>${p.name}</h3>
        <div class="price">${p.priceCents ? m(p.priceCents) : 'Free'}<span class="muted small">${p.priceCents ? ` / ${p.billingInterval}` : ''}</span></div>
        ${p.trialDays && p.priceCents ? html`<p><span class="badge ok">${p.trialDays}-day free trial</span></p>` : ''}
        <p class="muted small">${p.description}</p>
        <ul>${(p.highlights.length ? p.highlights : [`${p.limits.menuItems ?? 'Unlimited'} menu items`, `${p.limits.staff ?? 'Unlimited'} staff`]).map((h) => html`<li>${h}</li>`)}</ul>
        <button class="btn ${p.code === sub.plan.code ? 'secondary' : ''} block" data-plan="${p.code}">${p.code === sub.plan.code && !p.priceCents ? 'Continue with Free' : p.trialDays && p.priceCents ? 'Start free trial' : p.priceCents ? 'Choose & pay' : 'Choose Free'}</button></article>`)}</div>
      ${cardPaymentsAvailable ? '' : html`<p class="alert info small" style="margin-top:1rem">Online card payment for subscriptions is not enabled yet. If you choose a paid plan that requires payment, an invoice is created and the platform team will activate it once payment is received.</p>`}`);
    $('#step').onclick = async (e) => {
      const b = e.target.closest('[data-plan]');
      if (!b) return;
      b.disabled = true;
      try {
        const cur = sub.plan.code === b.dataset.plan && (sub.status === 'active' || sub.status === 'trialing');
        const r = cur ? { applied: true } : await api('/manage/subscription/change', { method: 'POST', body: { planCode: b.dataset.plan } });
        sessionStorage.removeItem('onboarding.plan');
        if (r.paymentUrl) { sessionStorage.setItem('dash.invoicePaying', String(r.invoice.id)); location.href = r.paymentUrl; return; }
        statusStep();
      } catch (err) { toast(err, 'err'); b.disabled = false; }
    };
  } catch (e) { render($('#step'), errorBox(e)); }
}

// The visible onboarding checklist, including the admin-review state.
async function statusStep() {
  steps(3);
  render($('#step'), spinner());
  try {
    const [{ restaurant, paymentAccount: pa }, { subscription: sub }] = await Promise.all([api('/manage/restaurant'), api('/manage/subscription')]);
    const planOk = ['active', 'trialing'].includes(sub.status);
    const approved = restaurant.approvalStatus === 'approved';
    const rejected = restaurant.approvalStatus === 'rejected';
    const row = (done, title, detail, warn = false) => html`<li style="display:flex;gap:.6rem;margin:.6rem 0"><span class="badge ${done ? 'ok' : warn ? 'err' : 'warn'}" style="height:fit-content">${done ? 'Done' : warn ? 'Action needed' : 'Pending'}</span><span><strong>${title}</strong><div class="muted small">${detail}</div></span></li>`;
    render($('#step'), html`<div class="card"><h1>${restaurant.name}</h1>
      ${approved && planOk ? html`<div class="alert ok"><strong>You are live!</strong> Customers can order at <a href="/restaurant/${restaurant.slug}">/restaurant/${restaurant.slug}</a>.</div>`
    : rejected ? html`<div class="alert err"><strong>Your application was not approved.</strong> ${restaurant.rejectionReason || ''} Contact support to discuss next steps.</div>`
      : html`<div class="alert info"><strong>Almost there.</strong> Your restaurant becomes visible to customers when the platform team approves it${planOk ? '' : ' and your plan is active'}. You can set up your menu in the meantime.</div>`}
      <ul style="list-style:none;padding:0">
        ${row(true, 'Account created', session.user.email)}
        ${row(true, 'Restaurant profile', 'Your page address is reserved')}
        ${row(planOk, `Plan: ${sub.plan.name}`, planOk ? (sub.status === 'trialing' ? `Free trial until ${fmtDay(sub.trialEnd)}` : 'Active') : sub.openInvoice ? `Invoice #${sub.openInvoice.id} is waiting for payment — open Subscription to pay` : 'Choose a plan', !planOk)}
        ${row(pa.payoutEnabled || !pa.providerEnabled, 'Payout account (online card payments)', pa.providerEnabled ? (pa.payoutEnabled ? 'Verified: card payments are on' : 'The platform team will help you complete the payment provider verification. Cash on delivery works meanwhile.') : 'Card payments are not enabled on the platform yet. Cash on delivery works.')}
        ${row(approved, 'Platform review', approved ? 'Approved' : rejected ? 'Not approved' : 'Waiting for the platform team', rejected)}
        ${row(approved && planOk, 'Go live', approved && planOk ? 'Your restaurant is live' : 'Goes live when the steps above are complete')}
      </ul>
      <div class="actions-row"><a class="btn" href="/dashboard.html#menu">Set up my menu</a><a class="btn secondary" href="/dashboard.html">Open dashboard</a>${planOk ? '' : raw('<a class="btn secondary" href="/dashboard.html#subscription">Subscription</a>')}</div></div>`);
  } catch (e) { render($('#step'), errorBox(e)); }
}

if (user) start();
