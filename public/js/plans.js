// Restaurant onboarding, step 1: the plans that really exist (GET /api/public/plans), before any registration form.
import { mountChrome, publicConfig, $, render, html, errorBox, t } from './common.js';
import { chosenPlan, loadPlans } from './plan-choice.js';
import { planCard, choosePlan } from './plan-cards.js';

mountChrome();

const selectedCode = chosenPlan();
let period = null;

(async () => {
  let plans; let currency;
  try { [plans, { currency }] = await Promise.all([loadPlans(), publicConfig()]); } catch (e) { render($('#plans'), errorBox(e)); return; }
  if (!plans.length) { render($('#plans'), html`<div class="empty"><strong>${t('plans.none')}</strong></div>`); return; }

  // Billing periods exist only when the platform has plans with different intervals; a free plan belongs to every period.
  const intervals = [...new Set(plans.filter((p) => p.priceCents).map((p) => p.billingInterval))];
  const known = plans.find((p) => p.code === selectedCode);
  period = known && known.priceCents ? known.billingInterval : (intervals.includes('month') ? 'month' : intervals[0] || null);
  const drawPeriod = () => {
    const box = $('#period');
    box.hidden = intervals.length < 2;
    if (intervals.length < 2) return;
    render(box, html`${intervals.map((i) => html`<button type="button" class="btn ${i === period ? '' : 'secondary'} sm" role="radio" aria-checked="${i === period}" data-period="${i}">${t(`plans.period.${i}`)}</button>`)}`);
  };
  const draw = () => {
    const shown = plans.filter((p) => !p.priceCents || intervals.length < 2 || p.billingInterval === period);
    render($('#plans'), html`<div class="grid cols-4">${shown.map((p) => planCard(p, currency, selectedCode))}</div>`);
    drawPeriod();
  };
  draw();

  $('#period').onclick = (e) => { const b = e.target.closest('[data-period]'); if (b) { period = b.dataset.period; draw(); } };
  $('#plans').onclick = (e) => { const b = e.target.closest('[data-plan]'); if (b) choosePlan(b.dataset.plan, b); };
  if (selectedCode) $('#signin-link').href = `/login.html?plan=${encodeURIComponent(selectedCode)}`;
})();
