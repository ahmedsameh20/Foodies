import { html, raw, esc, t, loc } from './common.js';

export function restaurantCard(r) {
  return html`<a class="card rest-card" href="/restaurant/${r.slug}">
    <img class="thumb" src="${r.logoUrl || '/Images/Restaurants/download.png'}" alt="" loading="lazy">
    <div class="body">
      <h3>${loc(r)} ${r.isDemo ? raw(`<span class="badge demo">${esc(t('rest.sample'))}</span>`) : ''}</h3>
      <p class="muted small" style="margin:0">${r.city || ''}${r.itemCount !== undefined ? ` · ${t('restaurants.items', { n: r.itemCount })}` : ''} ${r.isOpenNow === false ? raw(`· <strong>${esc(t('restaurants.closedNow'))}</strong>`) : ''}</p>
      <p class="muted small" style="margin:.25rem 0 0">${loc(r, 'description').slice(0, 90)}</p>
    </div>
  </a>`;
}
