import { api, mountChrome, publicConfig, $, render, html, errorBox, t } from './common.js';
import { restaurantCard } from './shared-ui.js';
import { loadPlans } from './plan-choice.js';
import { planCard, choosePlan } from './plan-cards.js';

mountChrome({ active: 'home' });

publicConfig().then((c) => { if (c.commissionBp != null) $('#commission').textContent = `${(c.commissionBp / 100).toString()}%`; });

// the restaurant plans, straight from the server's plans table
Promise.all([loadPlans(), publicConfig()]).then(([plans, c]) => {
  render($('#plans-box'), plans.length ? html`${plans.map((p) => planCard(p, c.currency))}` : html`<p class="muted">${t('plans.none')}</p>`);
}).catch((e) => render($('#plans-box'), errorBox(e)));
$('#plans-box').addEventListener('click', (e) => { const b = e.target.closest('[data-plan]'); if (b) choosePlan(b.dataset.plan, b); });

try {
  const { restaurants } = await api('/public/restaurants');
  render($('#featured'), restaurants.length
    ? html`${restaurants.slice(0, 4).map(restaurantCard)}`
    : html`<p class="muted">${t('landing.none')}</p>`);
} catch (e) { render($('#featured'), errorBox(e)); }
