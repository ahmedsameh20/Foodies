// A category's picture, everywhere categories are shown (customer menu, dashboard lists). One look, one fallback:
//   * a saved picture is shown in a fixed-ratio frame (object-fit: cover) with a tinted background while it loads;
//   * no picture, or a picture that fails to load, shows the same neutral placeholder icon (never a broken-image glyph).
// The frame sits beside the category's visible name, so the image is decorative (empty alt) for screen readers; the preview in the category
// form, where it stands alone, gets a real description.
import { html } from './common.js';
import { icon } from './icons.js';

export function catThumb(category, size = '') {
  const cls = `cat-thumb ${size}`.trim();
  return category?.imageUrl
    ? html`<span class="${cls}"><img src="${category.imageUrl}" alt="" loading="lazy" decoding="async" data-cat-img></span>`
    : html`<span class="${cls} ph" aria-hidden="true">${icon('categories', { size: size === 'lg' ? 36 : 20 })}</span>`;
}

// Swap a picture that cannot be loaded for the placeholder. `error` does not bubble, so it is listened for in the capture phase on a root.
export function watchCategoryImages(root) {
  root.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.hasAttribute('data-cat-img')) return;
    const frame = img.parentElement;
    frame.classList.add('ph', 'failed');
    frame.setAttribute('aria-hidden', 'true');
    frame.innerHTML = icon('categories', { size: frame.classList.contains('lg') ? 36 : 20 }).toString();
  }, true);
}
