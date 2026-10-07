import { html, raw } from './common.js';

export function restaurantCard(r) {
  return html`<a class="card rest-card" href="/restaurant/${r.slug}">
    <img class="thumb" src="${r.logoUrl || '/Images/Restaurants/download.png'}" alt="" loading="lazy">
    <div class="body">
      <h3>${r.name} ${r.isDemo ? raw('<span class="badge demo">Sample</span>') : ''}</h3>
      <p class="muted small" style="margin:0">${r.city || ''}${r.itemCount !== undefined ? ` · ${r.itemCount} items` : ''} ${r.isOpenNow === false ? raw('· <strong>Closed now</strong>') : ''}</p>
      <p class="muted small" style="margin:.25rem 0 0">${(r.description || '').slice(0, 90)}</p>
    </div>
  </a>`;
}
