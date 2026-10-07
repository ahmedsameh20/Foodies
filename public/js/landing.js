import { api, mountChrome, publicConfig, $, render, html, errorBox } from './common.js';
import { restaurantCard } from './shared-ui.js';

mountChrome({ active: 'home' });

publicConfig().then((c) => { if (c.commissionBp != null) $('#commission').textContent = `${(c.commissionBp / 100).toString()}%`; });

try {
  const { restaurants } = await api('/public/restaurants');
  render($('#featured'), restaurants.length
    ? html`${restaurants.slice(0, 4).map(restaurantCard)}`
    : html`<p class="muted">Restaurants will appear here as soon as they are approved.</p>`);
} catch (e) { render($('#featured'), errorBox(e)); }
