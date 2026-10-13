// Plan cards and the "choose this plan" action, shared by the plans page and the home page.
import { session, html, money, toast, t, planName, planDesc, planHighlights, api } from './common.js';
import { rememberPlan } from './plan-choice.js';

export function planCard(p, currency, selectedCode = null) {
  const free = !p.priceCents;
  const n = (v) => (v === null || v === undefined ? t('sub.unlimited') : v);
  return html`<article class="card plan ${p.code === selectedCode ? 'current' : ''}" aria-labelledby="plan-${p.code}">
    <h3 id="plan-${p.code}" style="font-size:1.25rem;margin:0">${planName(p)}</h3>
    <div class="price">${free ? t('onboarding.free') : money(p.priceCents, currency)}<span class="muted small">${free ? '' : ` / ${t(`sub.interval.${p.billingInterval}`)}`}</span></div>
    ${p.trialDays && !free ? html`<p><span class="badge ok">${t('onboarding.trialDays', { n: p.trialDays })}</span></p>` : ''}
    <p class="muted small">${planDesc(p)}</p>
    <ul>${planHighlights(p).map((h) => html`<li>${h}</li>`)}
      <li>${t('plans.limitBranches', { n: n(p.limits.branches) })}</li></ul>
    <button class="btn ${p.code === selectedCode ? '' : 'secondary'} block" data-plan="${p.code}">${p.code === selectedCode ? t('plans.selected') : t('plans.select')}</button>
  </article>`;
}

// Where a click on "choose this plan" leads: the server keeps the choice for a signed-in owner without a restaurant, a visitor goes to registration.
export async function choosePlan(code, button) {
  const u = session.user;
  button.disabled = true;
  try {
    if (u && u.role === 'owner' && !u.restaurantId) {
      await api('/onboarding/plan', { method: 'PUT', body: { planCode: code } });
      location.href = '/onboarding.html';
      return;
    }
    if (u && u.role === 'owner') { location.href = '/dashboard.html#subscription'; return; }
    rememberPlan(code);
    location.href = `/register.html?kind=owner&plan=${encodeURIComponent(code)}`;
  } catch (e) { toast(e, 'err'); button.disabled = false; }
}
