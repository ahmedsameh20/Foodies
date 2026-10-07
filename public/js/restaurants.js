import { api, mountChrome, $, render, html, spinner, emptyState, errorBox } from './common.js';
import { restaurantCard } from './shared-ui.js';

mountChrome({ active: 'restaurants' });

async function load(q = '') {
  render($('#list'), spinner());
  try {
    const { restaurants } = await api(`/public/restaurants${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    render($('#list'), restaurants.length
      ? html`<div class="grid cols-4">${restaurants.map(restaurantCard)}</div>`
      : emptyState('No restaurants found', q ? 'Try a different search.' : 'Restaurants will appear here once they join the platform.'));
  } catch (e) { render($('#list'), errorBox(e)); }
}

let timer;
$('#q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => load(e.target.value.trim()), 250); });
$('#search').addEventListener('submit', (e) => e.preventDefault());
load();
