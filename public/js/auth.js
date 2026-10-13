import { api, session, homeFor, onSubmit, mountChrome, draft, esc, t, $, $$ } from './common.js';
import { mountPhoneInput } from './phone-input.js';
import { chosenPlan, rememberPlan, forgetPlan, describePlan, validCode } from './plan-choice.js';

// Only follow same-site relative redirects (prevents open-redirect via ?next=).
export function safeNext(fallback) {
  const next = new URLSearchParams(location.search).get('next');
  return next && /^\/(?!\/)[^\s\\]*$/.test(next) ? next : fallback;
}

// Password step. Resolves { user } or { mfaRequired, mfaToken } when the account has two-factor authentication.
export const signIn = (email, password) => api('/auth/login', { method: 'POST', body: { email, password } });
export const completeMfa = (mfaToken, code) => api('/auth/mfa', { method: 'POST', body: { mfaToken, code } });

export function initLogin() {
  mountChrome({ active: 'login' });
  if (new URLSearchParams(location.search).has('next')) {
    $('#next-note').innerHTML = `<div class="alert info">${esc(t('login.pleaseSignIn'))}</div>`;
  }
  // a plan picked on the plans page is kept through sign-in (an owner without a restaurant continues onboarding with it)
  const planParam = new URLSearchParams(location.search).get('plan');
  if (validCode(planParam)) {
    rememberPlan(planParam);
    describePlan(planParam).then((d) => {
      if (!d) return;
      $('#next-note').insertAdjacentHTML('beforeend', `<div class="alert info">${esc(t('login.planKept', { plan: d.name, price: d.price }))}</div>`);
      const link = $('a[href="/register.html"]');
      if (link) link.href = `/register.html?kind=owner&plan=${encodeURIComponent(planParam)}`;
    });
  }
  const go = (user) => {
    session.set(user); // the session itself lives in an httpOnly cookie
    location.href = user.role === 'super_admin' ? '/admin/dashboard' : safeNext(homeFor(user));
  };
  onSubmit($('#form'), async (d) => {
    const r = await signIn(d.email, d.password);
    if (!r.mfaRequired) return go(r.user);
    // two-factor step (admins)
    const form = document.createElement('form');
    form.id = 'mfa';
    form.noValidate = true;
    form.innerHTML = `<div class="form-alert"></div><p>${esc(t('login.mfaIntro'))}</p><div class="field"><label for="code">${esc(t('login.mfaCode'))}</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required></div><button class="btn block" type="submit">${esc(t('login.verify'))}</button>`;
    $('#form').replaceWith(form);
    $('#code').focus();
    onSubmit(form, async (m) => go((await completeMfa(r.mfaToken, m.code)).user));
  });
}

// Registration (customer or restaurant owner). The mobile number is required for both and is stored on the account. What the visitor has
// typed (never the password) is kept for the tab session, so a validation error or a trip to another page does not lose it.
export function initRegister() {
  mountChrome();
  const params = new URLSearchParams(location.search);
  const user = session.user;
  const saved = draft.load('register') || {};

  const kind = ['owner', 'customer'].includes(params.get('kind')) ? params.get('kind') : (saved.kind || 'customer');
  $$('input[name=kind]').forEach((r) => { r.checked = r.value === kind; });

  // A restaurant owner starts on the plans page: registering as an owner needs a chosen plan, which is shown here and sent with the sign-up.
  // The server validates the code against its own plans; only the code travels, never a price.
  let planCode = null;
  const planNote = $('#plan-note');
  const ownerSelected = () => $$('input[name=kind]').find((r) => r.checked).value === 'owner';
  async function syncPlan() {
    planNote.innerHTML = '';
    planCode = null;
    if (!ownerSelected() || user?.role === 'owner') return;
    const code = chosenPlan();
    const d = code ? await describePlan(code) : null;
    if (!d) { forgetPlan(); location.replace('/plans.html'); return; }
    planCode = d.plan.code;
    rememberPlan(planCode);
    planNote.innerHTML = `<div class="alert info" role="status"><strong>${esc(t('register.selectedPlan'))}</strong> ${esc(d.name)} — ${esc(d.price)} <a href="/plans.html">${esc(t('register.changePlan'))}</a></div>`;
  }

  // A signed-in visitor is never asked to re-type what the account already knows.
  const note = $('#signed-in-note');
  if (user?.role === 'owner' && !user.restaurantId) {
    note.innerHTML = `<div class="alert info">${esc(t('register.ownerContinue', { name: user.name }))} <a href="/onboarding.html"><strong>${esc(t('register.continueSetup'))}</strong></a></div>`;
  } else if (user) {
    note.innerHTML = `<div class="alert info">${esc(t('register.signedInAs', { name: user.name, email: user.email }))} ${esc(t('register.separateOwnerAccount'))}</div>`;
  }
  const form = $('#form');
  const prefill = { name: saved.name ?? user?.name ?? '', email: saved.email ?? '', phone: saved.phone ?? user?.phone ?? '' };
  form.elements.name.value = prefill.name;
  form.elements.email.value = prefill.email; // the account's own email is NOT copied: a second account needs a different login email
  const phone = mountPhoneInput($('#phone-field'), { id: 'phone', value: prefill.phone });

  const persist = () => draft.save('register', {
    kind: $$('input[name=kind]').find((r) => r.checked).value, name: form.elements.name.value, email: form.elements.email.value, phone: phone.get(),
  });
  form.addEventListener('input', persist);
  form.addEventListener('change', persist);
  $$('input[name=kind]').forEach((r) => r.addEventListener('change', persist));
  $$('input[name=kind]').forEach((r) => r.addEventListener('change', syncPlan));
  const ready = syncPlan();

  onSubmit(form, async (d) => {
    await ready;
    const chosen = $$('input[name=kind]').find((r) => r.checked).value;
    const data = await api(chosen === 'owner' ? '/auth/register-owner' : '/auth/register', {
      method: 'POST', body: { name: d.name, email: d.email, phone: d.phone, password: d.password, ...(chosen === 'owner' && planCode ? { planCode } : {}) },
    });
    draft.clear('register');
    session.set(data.user);
    location.href = safeNext(homeFor(data.user));
  });
}
