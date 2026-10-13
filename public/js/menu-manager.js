// Restaurant dashboard -> Menu. One place for everything about the menu, with a section navigation (submenu):
//   #menu/dishes            All dishes, grouped by category, with search + filters. Also the entry point for adding a dish (button),
//                           importing from Excel and exporting to Excel.
//   #menu/categories        Categories (Arabic + English names)
//   #menu/new, #menu/edit/<id>[/extras]   The dish form (basic info, Arabic/English text, price & discount, stock, extras, image).
//                           #menu/new is not a sidebar item any more (the button on All dishes opens it) but stays a valid route.
//   #menu/stock             Availability and stock quantities, per branch when the restaurant has branches (staff may use this)
//   #menu/discounts         Discount rules (dish / category / whole menu) and the dishes' own discounted prices
//   #menu/extras/general    Add-ons & extras: items a customer adds to an order without choosing a dish (water, fries, sauces ...).
//                           #menu/extras (and the old #menu/extras/dish) redirect here; dish-specific extras are edited inside the dish form.
//   #menu/settings          Plan usage, ordering switch, translation coverage
// The section navigation itself lives in the dashboard sidebar (dashboard.js), nested under "Menu"; MENU_NAV below is its single source.
// Prices are entered as decimals and converted to integer cents; every rule is validated again by the server.
import {
  api, $, $$, render, html, raw, money, toCents, fromCents, spinner, emptyState, errorBox, toast, onSubmit, confirmDialog, wireDialog, t, loc,
} from './common.js';
import { discountPercent } from './pricing.js';
import { icon } from './icons.js';
import { exportDishes, importDialog } from './menu-import.js';
import { branchStockView } from './menu-stock.js';
import { discountRulesView } from './menu-discounts.js';
import { catThumb, watchCategoryImages } from './category-image.js';

const AR = /[؀-ۿ]/;
// Text written before the dish had separate Arabic / English fields is placed in the field matching its script. This is the owner's own
// text moved to the right box, never a translation: the other language stays empty until the owner writes it.
function bilingual(obj, base) {
  const cap = base[0].toUpperCase() + base.slice(1);
  const ar = obj?.[`${base}Ar`] || '';
  const en = obj?.[`${base}En`] || '';
  if (ar || en) return { ar, en };
  const legacy = obj?.[base] || '';
  return AR.test(legacy) ? { ar: legacy, en: '' } : { ar: '', en: legacy };
}

// Sections of the Menu area, in sidebar order. `icon` is a name from icons.js (monochrome SVG). Adding a dish is done from All dishes.
export const MENU_NAV = [
  { id: 'dishes', icon: 'dishes', label: 'menu.nav.dishes', roles: ['owner', 'staff'] },
  { id: 'categories', icon: 'categories', label: 'menu.nav.categories', roles: ['owner'] },
  { id: 'stock', icon: 'stock', label: 'menu.nav.stock', roles: ['owner', 'staff'] },
  { id: 'discounts', icon: 'discounts', label: 'menu.nav.discounts', roles: ['owner'] },
  { id: 'extras', icon: 'extras', label: 'menu.nav.extras', roles: ['owner'] },
  { id: 'settings', icon: 'menuSettings', label: 'menu.nav.settings', roles: ['owner'] },
];
// which MENU_NAV entry is highlighted for a hash such as "#menu/edit/7/extras" (editing a dish belongs to "All dishes")
export function activeMenuSection(hash = location.hash) {
  const sec = hash.replace(/^#/, '').split('/')[1] || 'dishes';
  return sec === 'edit' || sec === 'new' ? 'dishes' : sec; // adding / editing a dish belongs to "All dishes"
}

const FILTER_KEY = 'dash.menuFilter';
function loadFilter() { try { return { q: '', cat: '', status: '', ...JSON.parse(sessionStorage.getItem(FILTER_KEY)) }; } catch { return { q: '', cat: '', status: '' }; } }
function saveFilter(f) { try { sessionStorage.setItem(FILTER_KEY, JSON.stringify(f)); } catch { /* ignore */ } }

const norm = (s) => String(s || '').toLocaleLowerCase().normalize('NFKD').replace(/[ً-ٰٟ]/g, '');
const searchable = (p) => norm([p.name, p.nameAr, p.nameEn, p.description, p.descriptionAr, p.descriptionEn].join(' '));
const stockState = (p) => (!p.trackStock ? 'unlimited' : p.stockQuantity <= 0 ? 'out' : p.stockQuantity <= 5 ? 'low' : 'ok');

// ---------------------------------------------------------------------------------------------------------------------- entry point
export async function menuView(panel, env) {
  const { ctx } = env;
  const owner = ctx.role === 'owner';
  const parts = location.hash.slice(1).split('/').slice(1); // after "menu"
  const section = parts[0] || 'dishes';
  const isForm = section === 'new' || section === 'edit';
  const allowed = MENU_NAV.filter((n) => !n.cta && n.roles.includes(ctx.role)).map((n) => n.id);
  if (!isForm && !allowed.includes(section)) { location.replace('#menu/dishes'); return; }
  if (isForm && !owner) { location.replace('#menu/dishes'); return; }
  if (section === 'extras' && parts[1] !== 'general') { location.replace('#menu/extras/general'); return; } // Dish extras are no longer a separate section

  const [{ categories }, { products }, branchList] = await Promise.all([api('/manage/categories'), api('/manage/products'), api('/manage/branches')]);
  const branchCount = branchList.branches.filter((b) => b.isActive).length; // stock is per branch once the restaurant has branches
  const data = { ...env, owner, categories, products, parts, branchCount, m: (c) => money(c, ctx.restaurant.currency) };
  const missing = products.filter((p) => p.missingTranslations.length).length;

  // The section navigation is the nested submenu of the dashboard sidebar: the content simply fills the panel.
  render(panel, html`<div id="menu-content" aria-live="polite"></div>`);
  const box = $('#menu-content', panel);
  panel.onclick = null; panel.onchange = null; panel.oninput = null;

  if (isForm) return dishForm(box, data, section === 'edit' ? Number(parts[1]) : null, parts[2] === 'extras');
  const views = { dishes: dishesView, categories: categoriesView, stock: stockView, discounts: discountsView, extras: extrasView, settings: settingsView };
  return views[section](box, { ...data, missing }, panel);
}

// ---------------------------------------------------------------------------------------------------------------------- small pieces
const priceLine = (p, m) => (p.hasDiscount
  ? html`<span class="price-line"><span class="price-now">${m(p.priceCents)}</span><span class="price-was">${m(p.originalPriceCents)}</span><span class="badge sale">${t('dish.percentOff', { n: p.discountPercent })}</span></span>`
  : html`<span class="price-line"><span class="price-now">${m(p.priceCents)}</span></span>`);

function stockBadge(p) {
  const s = stockState(p);
  if (s === 'unlimited') return html`<span class="badge nocap">${t('stock.unlimited')}</span>`;
  if (s === 'out') return html`<span class="badge stock-out">${t('stock.out')}</span>`;
  if (s === 'low') return html`<span class="badge stock-low">${t('stock.lowCount', { n: p.stockQuantity })}</span>`;
  return html`<span class="badge stock-ok">${p.stockIsBranchTotal ? t('stock.inStockTotal', { n: p.stockQuantity }) : t('stock.inStock', { n: p.stockQuantity })}</span>`;
}
const missingBadge = (p) => (p.missingTranslations.length
  ? html`<span class="badge missing" title="${t('menu.missingHelp')}">${t('menu.missing', { langs: p.missingTranslations.map((l) => t(`lang.${l}`)).join(' / ') })}</span>` : '');
const catName = (categories, id) => { const c = categories.find((x) => x.id === id); return c ? loc(c) : t('menu.uncategorised'); };

function dishRow(p, d) {
  const other = bilingual(p, 'name');
  const second = loc(p) === other.ar ? other.en : other.ar; // the name in the other language, when there is one
  return html`<article class="card dish-row">
    ${p.imageUrl ? html`<img src="${p.imageUrl}" alt="" loading="lazy">` : html`<div class="ph" aria-hidden="true"></div>`}
    <div class="names"><strong>${loc(p)}</strong>${second ? html`<span class="muted small">${second}</span>` : ''}
      <div class="meta">${priceLine(p, d.m)} ${stockBadge(p)} ${!p.isAvailable ? html`<span class="badge stock-out">${t('dish.soldOut')}</span>` : ''}
        ${p.effective ? html`<span class="badge sale" title="${t('disc.ruleBadgeHelp')}">${t('disc.ruleBadge', { name: loc({ nameAr: p.effective.ruleNameAr, nameEn: p.effective.ruleNameEn }), price: d.m(p.effective.priceCents) })}</span>` : ''}
        ${p.extrasCount ? html`<span class="badge nocap">${t('menu.extrasCount', { n: p.extrasCount })}</span>` : ''} ${missingBadge(p)}</div></div>
    <div class="actions">
      <label class="check"><input type="checkbox" data-avail="${p.id}" ${p.isAvailable ? raw('checked') : ''}><span>${t('menu.available')}</span></label>
      ${d.owner ? html`<a class="btn secondary sm" href="#menu/edit/${p.id}">${t('common.edit')}</a> <button class="btn danger sm" data-act="del-prod" data-id="${p.id}" data-name="${loc(p)}">${t('common.delete')}</button>` : ''}
    </div></article>`;
}

// shared handlers: availability switch + delete, used by several sections
function wireCommon(panel, d) {
  panel.addEventListener('change', async (e) => {
    const a = e.target.closest('[data-avail]');
    if (!a) return;
    try { await api(`/manage/products/${a.dataset.avail}/availability`, { method: 'PATCH', body: { isAvailable: a.checked } }); toast(t('menu.availabilityUpdated'), 'ok'); d.refresh(); }
    catch (err) { toast(err, 'err'); a.checked = !a.checked; }
  });
  panel.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act="del-prod"]');
    if (!b) return;
    try {
      if (await confirmDialog(t('menu.deleteConfirm', { name: b.dataset.name }), { confirmLabel: t('common.delete'), danger: true })) {
        await api(`/manage/products/${b.dataset.id}`, { method: 'DELETE' });
        toast(t('menu.deleted'), 'ok'); d.refresh();
      }
    } catch (err) { toast(err, 'err'); }
  });
}

// ---------------------------------------------------------------------------------------------------------------------- All dishes
function dishesView(box, d, panel) {
  const f = loadFilter();
  const lim = d.ctx.subscription.plan.limits.menuItems;
  const FILTERS = ['', 'available', 'unavailable', 'out', 'low', 'discounted', 'extras', 'missing'];
  const pass = (p) => (!f.q || norm(f.q).split(/\s+/).every((w) => searchable(p).includes(w)))
    && (!f.cat || String(p.categoryId ?? 0) === f.cat)
    && (!f.status || ({
      available: p.orderable, unavailable: !p.isAvailable, out: p.trackStock && p.stockQuantity <= 0, low: p.trackStock && p.stockQuantity > 0 && p.stockQuantity <= 5,
      discounted: p.hasDiscount, extras: p.extrasCount > 0, missing: p.missingTranslations.length > 0,
    })[f.status]);

  function draw() {
    const list = d.products.filter(pass);
    const groups = [...d.categories.map((c) => ({ id: c.id, name: loc(c), imageUrl: c.imageUrl })), { id: 0, name: t('menu.uncategorised') }]
      .map((c) => ({ ...c, items: list.filter((p) => (p.categoryId ?? 0) === c.id) })).filter((c) => c.items.length);
    render($('#dish-list', box), list.length
      ? html`${groups.map((g) => html`<section class="cat-block" aria-label="${g.name}"><h3 class="cat-title">${g.id ? catThumb(g, 'sm') : ''}${g.name} <span class="badge">${g.items.length}</span></h3>${g.items.map((p) => dishRow(p, d))}</section>`)}`
      : d.products.length
        ? html`<div class="empty"><strong>${t('menu.noMatch')}</strong>${t('menu.noMatchText')}<br><br><button class="btn secondary" data-clear>${t('menu.clearFilters')}</button></div>`
        : html`<div class="empty"><strong>${t('menu.emptyTitle')}</strong>${d.owner ? t('menu.emptyOwner') : t('menu.emptyStaff')}${d.owner ? html`<br><br><a class="btn" href="#menu/new">${icon('plus', { size: 16 })} ${t('menu.addFirst')}</a>` : ''}</div>`);
  }

  render(box, html`<div class="toolbar"><h2>${t('menu.nav.dishes')}</h2>${d.owner ? html`<div class="toolbar-actions">
      <a class="btn" id="add-dish" href="#menu/new">${icon('plus', { size: 16 })} ${t('menu.nav.new')}</a>
      <button type="button" class="btn secondary" data-import>${icon('up', { size: 16 })} ${t('import.btn')}</button>
      <button type="button" class="btn secondary" data-export>${icon('down', { size: 16 })} ${t('import.exportBtn')}</button></div>` : ''}</div>
    ${d.owner ? html`<div class="card" style="margin-bottom:1rem">${usage(t('menu.itemsUsed'), d.products.length, lim)}</div>` : ''}
    ${d.missing ? html`<div class="alert info" role="status">${t('menu.missingBanner', { n: d.missing })} <a href="#menu/dishes" data-filter-missing>${t('menu.showThem')}</a></div>` : ''}
    <div class="menu-toolbar" role="search">
      <div class="field"><label for="mq">${t('menu.search')}</label><input id="mq" type="search" value="${f.q}" placeholder="${t('menu.searchPlaceholder')}" autocomplete="off"></div>
      <div class="field"><label for="mcat">${t('menu.category')}</label><select id="mcat"><option value="">${t('menu.allCategories')}</option>${d.categories.map((c) => html`<option value="${c.id}" ${String(c.id) === f.cat ? raw('selected') : ''}>${loc(c)}</option>`)}<option value="0" ${f.cat === '0' ? raw('selected') : ''}>${t('menu.uncategorised')}</option></select></div>
      <div class="field"><label for="mstatus">${t('menu.show')}</label><select id="mstatus">${FILTERS.map((s) => html`<option value="${s}" ${s === f.status ? raw('selected') : ''}>${t(`menu.filter.${s || 'all'}`)}</option>`)}</select></div>
    </div>
    <div id="dish-list"></div>`);
  draw();
  wireCommon(panel, d);
  panel.addEventListener('input', (e) => { if (e.target.id === 'mq') { f.q = e.target.value; saveFilter(f); draw(); } });
  panel.addEventListener('change', (e) => {
    if (e.target.id === 'mcat') { f.cat = e.target.value; saveFilter(f); draw(); }
    if (e.target.id === 'mstatus') { f.status = e.target.value; saveFilter(f); draw(); }
  });
  panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-import]')) importDialog(d);
    if (e.target.closest('[data-export]')) exportDishes(d);
    if (e.target.closest('[data-clear]')) { f.q = ''; f.cat = ''; f.status = ''; saveFilter(f); d.refresh(); }
    if (e.target.closest('[data-filter-missing]')) { e.preventDefault(); f.status = 'missing'; f.q = ''; f.cat = ''; saveFilter(f); d.refresh(); }
  });
}

function usage(label, used, limit) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return html`<div style="margin:.25rem 0"><div class="toolbar" style="margin:0 0 .25rem"><span>${label}</span><span class="muted small">${used} / ${limit ?? t('menu.unlimited')}</span></div>${limit ? html`<div class="meter ${used >= limit ? 'full' : ''}" role="progressbar" aria-valuenow="${used}" aria-valuemin="0" aria-valuemax="${limit}" aria-label="${label}"><div style="width:${pct}%"></div></div>` : ''}</div>`;
}

// ---------------------------------------------------------------------------------------------------------------------- Categories
function categoriesView(box, d, panel) {
  watchCategoryImages(box);
  render(box, html`<div class="toolbar"><h2>${t('menu.nav.categories')}</h2><button class="btn" data-act="add-cat">${icon('plus', { size: 16 })} ${t('menu.addCategory')}</button></div>
    ${d.categories.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('cat.image')}</th><th>${t('field.nameAr')}</th><th>${t('field.nameEn')}</th><th class="num">${t('menu.dishesCount')}</th><th></th></tr></thead><tbody>
      ${d.categories.map((c) => { const n = bilingual(c, 'name'); return html`<tr><td>${catThumb(c)}</td><td>${n.ar || html`<span class="muted">—</span>`}</td><td>${n.en || html`<span class="muted">—</span>`}</td><td class="num">${c.itemCount}</td>
        <td class="right"><button class="btn secondary sm" data-act="edit-cat" data-id="${c.id}">${t('common.edit')}</button> <button class="btn danger sm" data-act="del-cat" data-id="${c.id}">${t('common.delete')}</button></td></tr>`; })}</tbody></table></div>`
    : emptyState(t('menu.noCategories'), t('menu.noCategoriesText'))}`);
  panel.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    try {
      if (b.dataset.act === 'add-cat') await categoryDialog(null, d);
      else if (b.dataset.act === 'edit-cat') await categoryDialog(d.categories.find((c) => String(c.id) === b.dataset.id), d);
      else if (b.dataset.act === 'del-cat' && await confirmDialog(t('menu.deleteCategoryConfirm'), { confirmLabel: t('common.delete'), danger: true })) {
        await api(`/manage/categories/${b.dataset.id}`, { method: 'DELETE' });
        toast(t('menu.deleted'), 'ok'); d.refresh();
      }
    } catch (err) { toast(err, 'err'); }
  });
}

const CAT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const CAT_IMAGE_MAX = 2 * 1024 * 1024;

// Add / edit a category: Arabic + English names and an optional picture. The picture is chosen and previewed here and uploaded right after the
// category is saved (its own request, content-checked by the server). If that upload fails the category is kept, the dialog stays open on the
// saved category with the chosen file still selected, and saving again retries only what is missing - nothing typed is lost, no duplicate is created.
function categoryDialog(cat, d) {
  return new Promise((resolve) => {
    let current = cat; // becomes the saved category once the first request succeeded
    const n = bilingual(cat, 'name');
    const dlg = document.createElement('dialog');
    dlg.setAttribute('aria-labelledby', 'cd-title');
    dlg.innerHTML = html`<h2 id="cd-title">${cat ? t('menu.editCategory') : t('menu.addCategory')}</h2>
      <form novalidate><div class="form-alert"></div>
        <div class="field"><label for="cd-ar">${t('field.nameAr')}</label><input id="cd-ar" name="nameAr" data-field="nameAr" dir="rtl" lang="ar" required maxlength="60" value="${n.ar}"></div>
        <div class="field"><label for="cd-en">${t('field.nameEn')}</label><input id="cd-en" name="nameEn" data-field="nameEn" dir="ltr" lang="en" required maxlength="60" value="${n.en}"></div>
        <div class="field" data-field="image"><label for="cd-image">${t('cat.image')} <span class="muted small">(${t('gx.optional')})</span></label>
          <div class="cat-preview"><span class="cat-thumb lg ph" id="cd-preview" role="img" aria-label="${t('cat.imageNone')}"></span>
            <div><input id="cd-image" type="file" accept="image/png,image/jpeg,image/webp" aria-describedby="cd-image-hint">
              <div class="hint" id="cd-image-hint">${t('cat.imageHint')}</div>
              <button type="button" class="btn secondary sm" id="cd-remove" hidden>${t('cat.removeImage')}</button></div></div></div>
        <div class="actions-row"><button class="btn" type="submit">${t('common.save')}</button><button class="btn secondary" type="button" data-close>${t('common.cancel')}</button></div></form>`.s;
    document.body.append(dlg);
    dlg.showModal();
    wireDialog(dlg, resolve);
    dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dlg.close(); });

    const form = $('form', dlg);
    const preview = $('#cd-preview', dlg);
    const removeBtn = $('#cd-remove', dlg);
    const input = $('#cd-image', dlg);
    let file = null; // a newly chosen picture, not uploaded yet
    let removeRequested = false;
    let fileUrl = null; // the chosen picture as a data: URL (the page's CSP allows data:, not blob:)
    const name = () => form.elements.nameEn.value || form.elements.nameAr.value;
    const showPreview = () => {
      const src = file ? fileUrl : (!removeRequested && current?.imageUrl) || null;
      preview.classList.toggle('ph', !src);
      if (src) {
        preview.setAttribute('aria-label', t('cat.imageAlt', { name: name() }));
        preview.innerHTML = '';
        const img = document.createElement('img');
        img.alt = ''; img.src = src; img.decoding = 'async';
        img.addEventListener('error', () => { preview.classList.add('ph'); preview.innerHTML = icon('categories', { size: 36 }).toString(); });
        preview.append(img);
      } else {
        preview.setAttribute('aria-label', t('cat.imageNone'));
        preview.innerHTML = icon('categories', { size: 36 }).toString();
      }
      removeBtn.hidden = !src;
    };
    showPreview();
    input.addEventListener('change', () => {
      const f = input.files[0] || null;
      const box = $('.form-alert', dlg);
      box.innerHTML = '';
      if (f && (!CAT_IMAGE_TYPES.includes(f.type) || f.size > CAT_IMAGE_MAX)) { // the server checks again; this just saves a round trip
        input.value = '';
        box.innerHTML = errorBox(Object.assign(new Error(t('err.unsupported_media')), { code: 'unsupported_media', status: 415 })).s;
        return;
      }
      file = f; removeRequested = false; fileUrl = null;
      if (!f) { showPreview(); return; }
      const reader = new FileReader();
      reader.onload = () => { if (file === f) { fileUrl = String(reader.result); showPreview(); } };
      reader.onerror = () => { if (file === f) { fileUrl = null; showPreview(); } };
      reader.readAsDataURL(f);
    });
    removeBtn.addEventListener('click', () => { file = null; fileUrl = null; input.value = ''; removeRequested = true; showPreview(); });

    onSubmit(form, async (v) => {
      const body = { nameAr: v.nameAr, nameEn: v.nameEn };
      if (current) await api(`/manage/categories/${current.id}`, { method: 'PUT', body });
      else current = (await api('/manage/categories', { method: 'POST', body })).category; // from now on "Save" edits THIS category
      try {
        if (file) current = (await api(`/manage/categories/${current.id}/image`, { method: 'PUT', raw: true, body: file, headers: { 'Content-Type': file.type } })).category;
        else if (removeRequested && current.imageUrl) current = (await api(`/manage/categories/${current.id}/image`, { method: 'DELETE' })).category;
      } catch (err) {
        d.refresh(); // the category itself is saved; keep the dialog (and the chosen picture) so the upload can be retried
        throw err;
      }
      toast(t('menu.saved'), 'ok');
      dlg.close(); d.refresh();
    }, { alertBox: $('.form-alert', dlg) });
  });
}

// ---------------------------------------------------------------------------------------------------------------------- Stock & availability
async function stockView(box, d, panel) {
  if (d.branchCount > 0) { // stock lives per branch: one branch at a time (menu-stock.js)
    try { const sums = await api('/manage/stock/branches'); if (sums.branches.some((b) => b.isActive)) return branchStockView(box, d, sums); } catch (e) { return render(box, errorBox(e)); }
  }
  render(box, html`<div class="toolbar"><h2>${t('menu.nav.stock')}</h2></div>
    <p class="muted">${t('stock.intro')}</p>
    ${d.owner ? html`<div class="alert info small" role="note">${t('stock.noBranchesHint')} <a href="#team">${t('dash.tab.team')}</a></div>` : ''}
    ${d.products.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('menu.dish')}</th><th>${t('menu.available')}</th><th>${t('stock.track')}</th><th>${t('stock.quantity')}</th><th>${t('stock.restock')}</th><th>${t('stock.status')}</th></tr></thead><tbody>
      ${d.products.map((p) => html`<tr data-row="${p.id}"><td><strong>${loc(p)}</strong></td>
        <td><label class="check"><input type="checkbox" data-avail="${p.id}" ${p.isAvailable ? raw('checked') : ''}><span class="sr-only">${loc(p)} — ${t('menu.available')}</span></label></td>
        <td><label class="check"><input type="checkbox" data-track="${p.id}" ${p.trackStock ? raw('checked') : ''}><span class="sr-only">${loc(p)} — ${t('stock.track')}</span></label></td>
        <td>${p.trackStock ? html`<div class="inline-edit"><input type="number" min="0" max="1000000" inputmode="numeric" data-qty-input="${p.id}" value="${p.stockQuantity}" aria-label="${t('stock.quantity')} — ${loc(p)}"><button class="btn secondary sm" data-set="${p.id}">${t('common.save')}</button></div>` : html`<span class="muted small">${t('stock.unlimited')}</span>`}</td>
        <td>${p.trackStock ? html`<div class="inline-edit"><input type="number" min="1" max="100000" inputmode="numeric" data-add-input="${p.id}" placeholder="+10" aria-label="${t('stock.restock')} — ${loc(p)}"><button class="btn sm" data-add="${p.id}">${t('stock.add')}</button></div>` : ''}</td>
        <td>${stockBadge(p)}</td></tr>`)}</tbody></table></div>`
    : emptyState(t('menu.emptyTitle'), t('menu.emptyOwner')) }
    <h3 style="margin-top:1.75rem">${t('gx.stockHeading')}</h3>
    <p class="muted">${t('gx.stockIntro')}</p>
    <div id="gx-stock"></div>`);
  generalStockTable($('#gx-stock', box), d, panel);
  wireCommon(panel, d);
  panel.addEventListener('change', async (e) => {
    const tr = e.target.closest('[data-track]');
    if (!tr) return;
    try { await api(`/manage/products/${tr.dataset.track}/stock`, { method: 'PATCH', body: { trackStock: tr.checked } }); toast(t('stock.updated'), 'ok'); d.refresh(); }
    catch (err) { toast(err, 'err'); tr.checked = !tr.checked; }
  });
  panel.addEventListener('click', async (e) => {
    const set = e.target.closest('[data-set]');
    const add = e.target.closest('[data-add]');
    try {
      if (set) {
        const v = $(`[data-qty-input="${set.dataset.set}"]`, box).value;
        await api(`/manage/products/${set.dataset.set}/stock`, { method: 'PATCH', body: { quantity: Number(v) } });
        toast(t('stock.updated'), 'ok'); d.refresh();
      } else if (add) {
        const v = $(`[data-add-input="${add.dataset.add}"]`, box).value;
        if (!/^\d+$/.test(v) || Number(v) < 1) { toast(t('stock.enterRestock'), 'err'); return; }
        await api(`/manage/products/${add.dataset.add}/stock`, { method: 'PATCH', body: { restockBy: Number(v) } });
        toast(t('stock.restocked'), 'ok'); d.refresh();
      }
    } catch (err) { toast(err, 'err'); }
  });
}

// ---------------------------------------------------------------------------------------------------------------------- Discounts & offers
function discountsView(box, d, panel) {
  const sorted = [...d.products].sort((a, b) => Number(b.hasDiscount) - Number(a.hasDiscount));
  render(box, html`<div class="toolbar"><h2>${t('menu.nav.discounts')}</h2></div>
    <section id="rules-box" aria-label="${t('disc.rulesTitle')}"></section>
    <details class="form-section" style="margin-top:1.5rem" ${d.products.some((p) => p.hasDiscount) ? raw('open') : ''}><summary>${t('disc.dishPrices')}<span class="sub">${t('disc.dishPricesSub')}</span></summary><div class="section-body">
    <p class="muted">${t('discount.intro')}</p>
    ${sorted.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('menu.dish')}</th><th class="num">${t('price.original')}</th><th>${t('price.discounted')}</th><th>${t('discount.off')}</th><th></th></tr></thead><tbody>
      ${sorted.map((p) => html`<tr><td><strong>${loc(p)}</strong></td><td class="num">${d.m(p.originalPriceCents)}</td>
        <td><div class="field" style="margin:0"><input inputmode="decimal" data-disc-input="${p.id}" data-field="d${p.id}" value="${p.hasDiscount ? fromCents(p.discountedPriceCents) : ''}" placeholder="${t('discount.none')}" aria-label="${t('price.discounted')} — ${loc(p)}" style="max-width:9rem"></div></td>
        <td>${p.hasDiscount ? html`<span class="badge sale">${t('dish.percentOff', { n: p.discountPercent })}</span>` : ''}</td>
        <td class="right"><button class="btn sm" data-save-disc="${p.id}">${t('common.save')}</button> ${p.hasDiscount ? html`<button class="btn secondary sm" data-remove-disc="${p.id}">${t('discount.remove')}</button>` : ''}</td></tr>`)}</tbody></table></div>`
    : emptyState(t('menu.emptyTitle'), t('menu.emptyOwner'))}</div></details>`);
  discountRulesView($('#rules-box', box), d);
  panel.addEventListener('click', async (e) => {
    const save = e.target.closest('[data-save-disc]');
    const rm = e.target.closest('[data-remove-disc]');
    try {
      if (save) {
        const input = $(`[data-disc-input="${save.dataset.saveDisc}"]`, box);
        const raw0 = input.value.trim();
        const cents = raw0 === '' ? null : toCents(raw0);
        if (Number.isNaN(cents)) { toast(t('v.invalid_money'), 'err'); input.focus(); return; }
        await api(`/manage/products/${save.dataset.saveDisc}`, { method: 'PUT', body: { discountedPriceCents: cents } });
        toast(cents === null ? t('discount.removed') : t('menu.saved'), 'ok'); d.refresh();
      } else if (rm) {
        await api(`/manage/products/${rm.dataset.removeDisc}`, { method: 'PUT', body: { discountedPriceCents: null } });
        toast(t('discount.removed'), 'ok'); d.refresh();
      }
    } catch (err) { toast(err, 'err'); }
  });
}

// ---------------------------------------------------------------------------------------------------------------------- Add-ons & extras
// General extras: independent products a customer can order without choosing a dish. (Dish-specific extras are edited inside the dish form.)
const EXTRA_CATS = ['drinks', 'sides', 'sauces', 'other'];
function extrasView(box, d, panel) {
  return generalExtrasView(box, d, panel);
}

const CAT_KEY = 'dash.extraCat';
async function generalExtrasView(box, d, panel) {
  render(box, spinner());
  let extras;
  try { ({ extras } = await api('/manage/extras')); } catch (e) { return render(box, errorBox(e)); }
  let cat = '';
  try { cat = sessionStorage.getItem(CAT_KEY) || ''; } catch { /* storage blocked */ }
  const refresh = () => d.refresh();

  const draw = () => {
    const list = extras.filter((x) => !cat || x.category === cat);
    render(box, html`<div class="toolbar"><h2>${t('menu.nav.extras')}</h2><button class="btn" data-act="add-extra">${icon('plus', { size: 16 })} ${t('gx.add')}</button></div>
      <p class="muted">${t('gx.intro')}</p>
      <div class="chips" role="group" aria-label="${t('gx.filterLabel')}">${['', ...EXTRA_CATS].map((c) => html`<button type="button" class="chip" data-cat="${c}" aria-pressed="${c === cat}">${t(`gx.${c ? `cat.${c}` : 'filter.all'}`)}${c ? '' : html` <span class="count">${extras.length}</span>`}</button>`)}</div>
      ${!extras.length ? html`<div class="empty"><strong>${t('gx.empty')}</strong>${t('gx.emptyText')}<br><br><button class="btn" data-act="add-extra">${icon('plus', { size: 16 })} ${t('gx.add')}</button></div>`
        : !list.length ? emptyState(t('gx.noneInCategory'))
          : html`<div class="table-wrap"><table><thead><tr><th>${t('gx.name')}</th><th>${t('gx.category')}</th><th class="num">${t('gx.price')}</th><th>${t('stock.status')}</th><th>${t('menu.available')}</th><th></th></tr></thead><tbody>
        ${list.map((x) => extraRow(x, d))}</tbody></table></div>`}`);
  };
  draw();

  panel.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-cat]');
    const b = e.target.closest('[data-act]');
    try {
      if (c) { cat = c.dataset.cat; try { sessionStorage.setItem(CAT_KEY, cat); } catch { /* ignore */ } draw(); return; }
      if (!b) return;
      if (b.dataset.act === 'add-extra') await extraDialog(null, d, refresh);
      else if (b.dataset.act === 'edit-extra') await extraDialog(extras.find((x) => String(x.id) === b.dataset.id), d, refresh);
      else if (b.dataset.act === 'del-extra' && await confirmDialog(t('gx.deleteConfirm', { name: b.dataset.name }), { confirmLabel: t('common.delete'), danger: true })) {
        await api(`/manage/extras/${b.dataset.id}`, { method: 'DELETE' });
        toast(t('gx.deleted'), 'ok'); refresh();
      }
    } catch (err) { toast(err, 'err'); }
  });
  panel.addEventListener('change', async (e) => {
    const a = e.target.closest('[data-xavail]');
    if (!a) return;
    try { await api(`/manage/extras/${a.dataset.xavail}/availability`, { method: 'PATCH', body: { isAvailable: a.checked } }); toast(t('menu.availabilityUpdated'), 'ok'); refresh(); }
    catch (err) { toast(err, 'err'); a.checked = !a.checked; }
  });
}

function extraRow(x, d) {
  const other = loc(x) === x.nameAr ? x.nameEn : x.nameAr; // the name in the other language, when there is one
  return html`<tr><td><div class="extra-cell">${x.imageUrl ? html`<img src="${x.imageUrl}" alt="" loading="lazy">` : html`<div class="ph" aria-hidden="true"></div>`}
      <div><strong>${loc(x)}</strong>${other ? html`<div class="muted small">${other}</div>` : ''}${x.missingTranslations.length ? html`<div>${missingBadge(x)}</div>` : ''}</div></div></td>
    <td><span class="badge nocap">${t(`gx.cat.${x.category}`)}</span></td>
    <td class="num">${d.m(x.priceCents)}</td>
    <td>${stockBadge(x)}</td>
    <td><label class="check"><input type="checkbox" data-xavail="${x.id}" ${x.isAvailable ? raw('checked') : ''}><span class="sr-only">${loc(x)} — ${t('menu.available')}</span></label></td>
    <td class="right"><button class="btn secondary sm" data-act="edit-extra" data-id="${x.id}">${t('common.edit')}</button> <button class="btn danger sm" data-act="del-extra" data-id="${x.id}" data-name="${loc(x)}">${t('common.delete')}</button></td></tr>`;
}

function extraDialog(x, d, done) {
  return new Promise((resolve) => {
    const cur = d.ctx.restaurant.currency;
    const dlg = document.createElement('dialog');
    dlg.className = 'wide';
    dlg.setAttribute('aria-labelledby', 'gx-title');
    dlg.innerHTML = html`<h2 id="gx-title">${x ? t('gx.edit') : t('gx.add')}</h2>
      <form novalidate><div class="form-alert"></div>
        <div class="lang-pair">
          <div class="field"><label for="gx-name-ar">${t('field.nameAr')} <span class="tag">AR</span></label><input id="gx-name-ar" name="nameAr" data-field="nameAr" dir="rtl" lang="ar" required maxlength="80" value="${x?.nameAr || ''}"></div>
          <div class="field"><label for="gx-name-en">${t('field.nameEn')} <span class="tag">EN</span></label><input id="gx-name-en" name="nameEn" data-field="nameEn" dir="ltr" lang="en" required maxlength="80" value="${x?.nameEn || ''}"></div>
          <div class="field"><label for="gx-desc-ar">${t('field.descriptionAr')} <span class="tag">AR</span> <span class="muted small">(${t('gx.optional')})</span></label><textarea id="gx-desc-ar" name="descriptionAr" data-field="descriptionAr" dir="rtl" lang="ar" maxlength="300" rows="2">${x?.descriptionAr || ''}</textarea></div>
          <div class="field"><label for="gx-desc-en">${t('field.descriptionEn')} <span class="tag">EN</span> <span class="muted small">(${t('gx.optional')})</span></label><textarea id="gx-desc-en" name="descriptionEn" data-field="descriptionEn" dir="ltr" lang="en" maxlength="300" rows="2">${x?.descriptionEn || ''}</textarea></div>
        </div>
        <div class="row">
          <div class="field"><label for="gx-cat">${t('gx.category')}</label><select id="gx-cat" name="category" data-field="category">${EXTRA_CATS.map((c) => html`<option value="${c}" ${(x?.category || 'other') === c ? raw('selected') : ''}>${t(`gx.cat.${c}`)}</option>`)}</select></div>
          <div class="field"><label for="gx-price">${t('gx.price')} (${cur})</label><input id="gx-price" name="price" data-field="priceCents" inputmode="decimal" required autocomplete="off" value="${x ? fromCents(x.priceCents) : ''}"></div>
          <div class="field"><label for="gx-max">${t('gx.maxPerOrder')}</label><input id="gx-max" name="maxQuantity" data-field="maxQuantity" type="number" min="1" max="50" inputmode="numeric" value="${x?.maxQuantity ?? 20}"><div class="hint">${t('gx.maxPerOrderHint')}</div></div>
        </div>
        <label class="check"><input type="checkbox" id="gx-track" name="trackStock" ${x?.trackStock ? raw('checked') : ''}><span>${t('gx.trackLabel')}</span></label>
        <p class="muted small">${t('gx.trackHelp')}</p>
        <div class="field" id="gx-qty-field"><label for="gx-qty">${t('gx.quantityLeft')}</label><input id="gx-qty" name="stockQuantity" data-field="stockQuantity" type="number" min="0" max="1000000" inputmode="numeric" value="${x?.trackStock ? x.stockQuantity : 0}"></div>
        <label class="check"><input type="checkbox" name="isAvailable" ${!x || x.isAvailable ? raw('checked') : ''}><span>${t('gx.availableLabel')}</span></label>
        <div class="field" style="margin-top:1rem"><label for="gx-img">${t('gx.image')}</label><input id="gx-img" type="file" accept="image/png,image/jpeg,image/webp">
          ${x?.imageUrl ? html`<div style="margin-top:.5rem;display:flex;gap:.75rem;align-items:center"><img src="${x.imageUrl}" alt="" width="56" height="56" style="border-radius:10px;object-fit:cover"><span class="hint">${t('gx.imageKept')}</span></div>` : html`<div class="hint">${t('gx.imageHint')}</div>`}</div>
        <div class="actions-row"><button class="btn" type="submit">${t('common.save')}</button><button class="btn secondary" type="button" data-close>${t('common.cancel')}</button></div></form>`.s;
    document.body.append(dlg);
    dlg.showModal();
    wireDialog(dlg, resolve);
    dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dlg.close(); });
    const form = $('form', dlg);
    const sync = () => { form.elements.stockQuantity.disabled = !form.elements.trackStock.checked; };
    form.elements.trackStock.addEventListener('change', sync);
    sync();
    onSubmit(form, async (v) => {
      const fail = (field, reason) => Object.assign(new Error(reason), { code: 'validation_error', details: { field, reason } });
      const cents = toCents(v.price);
      if (Number.isNaN(cents)) throw fail('priceCents', 'invalid_money');
      const body = {
        nameAr: v.nameAr, nameEn: v.nameEn, descriptionAr: v.descriptionAr, descriptionEn: v.descriptionEn, category: v.category, priceCents: cents,
        maxQuantity: Number(v.maxQuantity), trackStock: v.trackStock, isAvailable: v.isAvailable,
      };
      if (v.trackStock) body.stockQuantity = Number(v.stockQuantity);
      const file = $('#gx-img', dlg).files[0];
      if (file) body.imageUrl = (await api('/manage/uploads', { method: 'POST', raw: true, body: file, headers: { 'Content-Type': file.type } })).url;
      await api(x ? `/manage/extras/${x.id}` : '/manage/extras', { method: x ? 'PUT' : 'POST', body });
      toast(t('gx.saved'), 'ok');
      dlg.close(); done();
    }, { alertBox: $('.form-alert', dlg) });
  });
}

// "Availability & stock" for general extras: same controls as for dishes (staff may use them).
async function generalStockTable(slot, d, panel) {
  let extras;
  try { ({ extras } = await api('/manage/extras')); } catch (e) { return render(slot, errorBox(e)); }
  if (!extras.length) return render(slot, emptyState(t('gx.empty'), t('gx.stockEmpty')));
  render(slot, html`<div class="table-wrap"><table><thead><tr><th>${t('gx.name')}</th><th>${t('gx.category')}</th><th>${t('menu.available')}</th><th>${t('stock.track')}</th><th>${t('stock.quantity')}</th><th>${t('stock.restock')}</th><th>${t('stock.status')}</th></tr></thead><tbody>
    ${extras.map((x) => html`<tr><td><strong>${loc(x)}</strong></td><td>${t(`gx.cat.${x.category}`)}</td>
      <td><label class="check"><input type="checkbox" data-xavail="${x.id}" ${x.isAvailable ? raw('checked') : ''}><span class="sr-only">${loc(x)} — ${t('menu.available')}</span></label></td>
      <td><label class="check"><input type="checkbox" data-xtrack="${x.id}" ${x.trackStock ? raw('checked') : ''}><span class="sr-only">${loc(x)} — ${t('stock.track')}</span></label></td>
      <td>${x.trackStock ? html`<div class="inline-edit"><input type="number" min="0" max="1000000" inputmode="numeric" data-xqty-input="${x.id}" value="${x.stockQuantity}" aria-label="${t('stock.quantity')} — ${loc(x)}"><button class="btn secondary sm" data-xset="${x.id}">${t('common.save')}</button></div>` : html`<span class="muted small">${t('stock.unlimited')}</span>`}</td>
      <td>${x.trackStock ? html`<div class="inline-edit"><input type="number" min="1" max="100000" inputmode="numeric" data-xadd-input="${x.id}" placeholder="+10" aria-label="${t('stock.restock')} — ${loc(x)}"><button class="btn sm" data-xadd="${x.id}">${t('stock.add')}</button></div>` : ''}</td>
      <td>${stockBadge(x)}</td></tr>`)}</tbody></table></div>`);
  panel.addEventListener('change', async (e) => {
    const av = e.target.closest('[data-xavail]');
    const tr = e.target.closest('[data-xtrack]');
    try {
      if (av) { await api(`/manage/extras/${av.dataset.xavail}/availability`, { method: 'PATCH', body: { isAvailable: av.checked } }); toast(t('menu.availabilityUpdated'), 'ok'); d.refresh(); }
      else if (tr) { await api(`/manage/extras/${tr.dataset.xtrack}/stock`, { method: 'PATCH', body: { trackStock: tr.checked } }); toast(t('stock.updated'), 'ok'); d.refresh(); }
    } catch (err) { toast(err, 'err'); (av || tr).checked = !(av || tr).checked; }
  });
  panel.addEventListener('click', async (e) => {
    const set = e.target.closest('[data-xset]');
    const add = e.target.closest('[data-xadd]');
    try {
      if (set) {
        await api(`/manage/extras/${set.dataset.xset}/stock`, { method: 'PATCH', body: { quantity: Number($(`[data-xqty-input="${set.dataset.xset}"]`, slot).value) } });
        toast(t('stock.updated'), 'ok'); d.refresh();
      } else if (add) {
        const v = $(`[data-xadd-input="${add.dataset.xadd}"]`, slot).value;
        if (!/^\d+$/.test(v) || Number(v) < 1) { toast(t('stock.enterRestock'), 'err'); return; }
        await api(`/manage/extras/${add.dataset.xadd}/stock`, { method: 'PATCH', body: { restockBy: Number(v) } });
        toast(t('stock.restocked'), 'ok'); d.refresh();
      }
    } catch (err) { toast(err, 'err'); }
  });
}

// ---------------------------------------------------------------------------------------------------------------------- Menu settings
function settingsView(box, d, panel) {
  const lim = d.ctx.subscription.plan.limits.menuItems;
  const r = d.ctx.restaurant;
  render(box, html`<div class="toolbar"><h2>${t('menu.nav.settings')}</h2></div>
    <div class="card">${usage(t('menu.itemsUsed'), d.products.length, lim)}<p class="muted small">${t('settings.planNote', { plan: d.ctx.subscription.plan.name })} <a href="#subscription">${t('settings.manageSubscription')}</a></p></div>
    <div class="card"><h3>${t('settings.ordering')}</h3>
      <label class="check"><input type="checkbox" id="accepting" ${r.acceptingOrders ? raw('checked') : ''}><span>${t('settings.accepting')}</span></label>
      <p class="muted small">${t('settings.acceptingHelp')}</p></div>
    <div class="card"><h3>${t('settings.languages')}</h3><p>${t('settings.languagesText')}</p>
      ${d.missing ? html`<div class="alert info">${t('menu.missingBanner', { n: d.missing })} <a href="#menu/dishes" data-filter-missing>${t('menu.showThem')}</a></div>` : html`<div class="alert ok">${t('settings.allTranslated')}</div>`}</div>
    <div class="card"><h3>${t('settings.currency')}</h3><p>${t('settings.currencyText', { currency: r.currency })}</p></div>`);
  panel.addEventListener('change', async (e) => {
    if (e.target.id !== 'accepting') return;
    try { await api('/manage/restaurant', { method: 'PUT', body: { acceptingOrders: e.target.checked } }); toast(t('menu.saved'), 'ok'); d.reloadCtx(); }
    catch (err) { toast(err, 'err'); e.target.checked = !e.target.checked; }
  });
  panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-filter-missing]')) { try { sessionStorage.setItem(FILTER_KEY, JSON.stringify({ q: '', cat: '', status: 'missing' })); } catch { /* ignore */ } }
  });
}

// ---------------------------------------------------------------------------------------------------------------------- Dish form
const newGroup = () => ({ id: null, nameAr: 'إضافات', nameEn: 'Extras', minSelect: 0, maxSelect: 1, maxAuto: true, options: [newExtra()] });
const newExtra = () => ({ id: null, nameAr: '', nameEn: '', price: '', maxQuantity: 1, isAvailable: true });

async function dishForm(box, d, id, focusExtras) {
  render(box, spinner());
  let product = null;
  let groups = [];
  if (id !== null) {
    try {
      const r = await api(`/manage/products/${id}`);
      product = r.product;
      groups = r.optionGroups.map((g) => {
        const gn = bilingual(g, 'name');
        return {
          id: g.id, nameAr: gn.ar, nameEn: gn.en, minSelect: g.minSelect, maxSelect: g.maxSelect, maxAuto: false,
          options: g.options.map((o) => { const on = bilingual(o, 'name'); return { id: o.id, nameAr: on.ar, nameEn: on.en, price: fromCents(o.priceCents), maxQuantity: o.maxQuantity, isAvailable: o.isAvailable }; }),
        };
      });
    } catch (e) { return render(box, errorBox(e)); }
  }
  const name = bilingual(product, 'name');
  const desc = bilingual(product, 'description');
  const legacyText = product && !product.nameAr && !product.nameEn;
  const originalTrackedQty = product?.trackStock ? product.stockQuantity : 0;
  const cur = d.ctx.restaurant.currency;

  render(box, html`<div class="toolbar"><h2>${product ? t('dishForm.editTitle') : t('dishForm.newTitle')}</h2><a class="btn secondary" href="#menu/dishes">${t('dishForm.back')}</a></div>
    ${legacyText ? html`<div class="alert info" role="status">${t('dishForm.legacyNotice')}</div>` : ''}
    <form id="dish" novalidate>
      <div class="form-alert"></div>

      <details class="form-section" open><summary>${t('dishForm.s1')}<span class="sub">${t('dishForm.s1sub')}</span></summary><div class="section-body">
        <div class="row">
          <div class="field"><label for="f-cat">${t('menu.category')}</label><select id="f-cat" name="categoryId" data-field="categoryId"><option value="">${t('dishForm.noCategory')}</option>${d.categories.map((c) => html`<option value="${c.id}" ${product?.categoryId === c.id ? raw('selected') : ''}>${loc(c)}</option>`)}</select>
            ${d.categories.length ? '' : html`<div class="hint">${t('dishForm.noCategoriesHint')} <a href="#menu/categories">${t('menu.nav.categories')}</a></div>`}</div>
          <div class="field"><label>${t('menu.available')}</label><label class="check"><input type="checkbox" name="isAvailable" ${!product || product.isAvailable ? raw('checked') : ''}><span>${t('dishForm.availableHelp')}</span></label></div>
        </div></div></details>

      <details class="form-section" open><summary>${t('dishForm.s2')}<span class="sub">${t('dishForm.s2sub')}</span></summary><div class="section-body">
        <div class="lang-pair">
          <div class="field"><label for="f-name-ar">${t('field.nameAr')} <span class="tag">AR</span></label><input id="f-name-ar" name="nameAr" data-field="nameAr" dir="rtl" lang="ar" required maxlength="120" value="${name.ar}"></div>
          <div class="field"><label for="f-name-en">${t('field.nameEn')} <span class="tag">EN</span></label><input id="f-name-en" name="nameEn" data-field="nameEn" dir="ltr" lang="en" required maxlength="120" value="${name.en}"></div>
          <div class="field"><label for="f-desc-ar">${t('field.descriptionAr')} <span class="tag">AR</span></label><textarea id="f-desc-ar" name="descriptionAr" data-field="descriptionAr" dir="rtl" lang="ar" required maxlength="1000">${desc.ar}</textarea></div>
          <div class="field"><label for="f-desc-en">${t('field.descriptionEn')} <span class="tag">EN</span></label><textarea id="f-desc-en" name="descriptionEn" data-field="descriptionEn" dir="ltr" lang="en" required maxlength="1000">${desc.en}</textarea></div>
        </div><p class="muted small">${t('dishForm.noAutoTranslate')}</p></div></details>

      <details class="form-section" open><summary>${t('dishForm.s3')}<span class="sub">${t('dishForm.s3sub')}</span></summary><div class="section-body">
        <div class="row">
          <div class="field"><label for="f-orig">${t('price.original')} (${cur})</label><input id="f-orig" name="original" data-field="originalPriceCents" inputmode="decimal" required value="${product ? fromCents(product.originalPriceCents) : ''}" autocomplete="off"><div class="hint">${t('price.originalHint')}</div></div>
          <div class="field"><label for="f-disc">${t('price.discounted')} (${cur})</label><input id="f-disc" name="discounted" data-field="discountedPriceCents" inputmode="decimal" value="${product?.hasDiscount ? fromCents(product.discountedPriceCents) : ''}" autocomplete="off"><div class="hint">${t('price.discountedHint')}</div></div>
        </div>
        <div class="actions-row" style="align-items:center"><div class="price-preview" id="price-preview" aria-live="polite"></div><button type="button" class="btn secondary sm" id="rm-disc">${t('discount.remove')}</button></div></div></details>

      <details class="form-section" open><summary>${t('dishForm.s4')}<span class="sub">${t('dishForm.s4sub')}</span></summary><div class="section-body">
        <label class="check"><input type="checkbox" id="f-track" name="trackStock" ${product?.trackStock ? raw('checked') : ''}><span>${t('stock.trackLabel')}</span></label>
        <p class="muted small">${t('stock.trackHelp')}</p>
        ${d.branchCount > 1 ? html`<div class="alert info small" role="note">${t('stock.perBranchNote')} <a href="#menu/stock">${t('menu.nav.stock')}</a></div>` : ''}
        <div class="row" id="stock-fields" ${d.branchCount > 1 ? raw('hidden') : ''}>
          <div class="field"><label for="f-qty">${t('stock.quantity')}</label><input id="f-qty" name="stockQuantity" data-field="stockQuantity" type="number" min="0" max="1000000" inputmode="numeric" value="${product?.trackStock ? product.stockQuantity : 0}"><div class="hint" id="stock-state"></div></div>
          ${product ? html`<div class="field"><label for="f-restock">${t('stock.restock')}</label><div class="inline-edit"><input id="f-restock" type="number" min="1" max="100000" inputmode="numeric" placeholder="+10"><button type="button" class="btn secondary" id="restock-btn">${t('stock.add')}</button></div><div class="hint">${t('stock.restockHint')}</div></div>` : ''}
        </div></div></details>

      <details class="form-section" id="extras-section" open><summary>${t('dishForm.s5')}<span class="sub">${t('dishForm.s5sub')}</span></summary><div class="section-body">
        <p class="muted small">${t('extras.formIntro')}</p>
        <div id="extras"></div>
        <button type="button" class="btn secondary" id="add-group">${icon('plus', { size: 16 })} ${t('extras.addGroup')}</button></div></details>

      <details class="form-section" open><summary>${t('dishForm.s6')}<span class="sub">${t('dishForm.s6sub')}</span></summary><div class="section-body">
        <div class="field"><label for="f-img">${t('dishForm.image')}</label><input id="f-img" type="file" accept="image/png,image/jpeg,image/webp">
          ${product?.imageUrl ? html`<div style="margin-top:.5rem;display:flex;gap:.75rem;align-items:center"><img src="${product.imageUrl}" alt="" width="64" height="64" style="border-radius:10px;object-fit:cover"><span class="hint">${t('dishForm.imageKept')}</span></div>` : html`<div class="hint">${t('dishForm.imageHint')}</div>`}</div></div></details>

      <div class="sticky-actions"><button class="btn" type="submit">${t('common.save')}</button><a class="btn secondary" href="#menu/dishes">${t('common.cancel')}</a></div>
    </form>`);

  const form = $('#dish', box);

  // ---- price preview + discount removal
  const preview = () => {
    const o = toCents(form.elements.original.value);
    const dsc = form.elements.discounted.value.trim();
    const dc = dsc === '' ? null : toCents(dsc);
    const el = $('#price-preview', box);
    $('#rm-disc', box).hidden = dc === null;
    if (Number.isNaN(o)) el.textContent = t('price.enterOriginal');
    else if (dc === null) el.textContent = t('price.customersPay', { price: d.m(o) });
    else if (Number.isNaN(dc) || dc <= 0 || dc >= o) el.textContent = t('price.discountInvalid');
    else el.textContent = t('price.preview', { price: d.m(dc), was: d.m(o), n: discountPercent(o, dc) });
  };
  form.elements.original.addEventListener('input', preview);
  form.elements.discounted.addEventListener('input', preview);
  $('#rm-disc', box).addEventListener('click', () => { form.elements.discounted.value = ''; preview(); });
  preview();

  // ---- stock fields follow the "track stock" switch
  const syncStock = () => {
    const on = form.elements.trackStock.checked;
    form.elements.stockQuantity.disabled = !on;
    const rs = $('#f-restock', box); if (rs) { rs.disabled = !on; $('#restock-btn', box).disabled = !on; }
    const q = Number(form.elements.stockQuantity.value);
    $('#stock-state', box).textContent = !on ? t('stock.unlimitedHint') : q <= 0 ? t('stock.zeroHint') : t('stock.leftHint', { n: q });
  };
  form.elements.trackStock.addEventListener('change', syncStock);
  form.elements.stockQuantity.addEventListener('input', syncStock);
  syncStock();
  $('#restock-btn', box)?.addEventListener('click', async () => {
    const v = $('#f-restock', box).value;
    if (!/^\d+$/.test(v) || Number(v) < 1) { toast(t('stock.enterRestock'), 'err'); return; }
    try {
      const r = await api(`/manage/products/${product.id}/stock`, { method: 'PATCH', body: { restockBy: Number(v) } });
      form.elements.stockQuantity.value = r.product.stockQuantity;
      $('#f-restock', box).value = '';
      product.stockQuantity = r.product.stockQuantity; // the form's baseline: only a hand-edited quantity is sent on save
      syncStock();
      toast(t('stock.restocked'), 'ok');
    } catch (err) { toast(err, 'err'); }
  });

  // ---- extras editor (state in `groups`, kept in sync with the inputs; re-rendered only on structural changes)
  const extrasBox = $('#extras', box);
  const drawExtras = () => {
    render(extrasBox, groups.length ? html`${groups.map((g, gi) => html`<div class="extras-group" data-g="${gi}">
      <header><strong>${t('extras.group')} ${gi + 1}</strong><span class="row-actions">
        <button type="button" class="btn secondary icon" data-do="g-up" data-g="${gi}" ${gi === 0 ? raw('disabled') : ''} aria-label="${t('common.moveUp')}">${icon('up', { size: 16 })}</button>
        <button type="button" class="btn secondary icon" data-do="g-down" data-g="${gi}" ${gi === groups.length - 1 ? raw('disabled') : ''} aria-label="${t('common.moveDown')}">${icon('down', { size: 16 })}</button>
        <button type="button" class="btn danger icon" data-do="g-del" data-g="${gi}">${t('common.delete')}</button></span></header>
      <div class="lang-pair">
        <div class="field"><label>${t('extras.groupNameAr')} <span class="tag">AR</span></label><input data-field="optionGroups[${gi}].nameAr" data-g="${gi}" data-k="nameAr" dir="rtl" lang="ar" maxlength="80" value="${g.nameAr}"></div>
        <div class="field"><label>${t('extras.groupNameEn')} <span class="tag">EN</span></label><input data-field="optionGroups[${gi}].nameEn" data-g="${gi}" data-k="nameEn" dir="ltr" lang="en" maxlength="80" value="${g.nameEn}"></div>
      </div>
      <div class="row" style="margin-bottom:.75rem">
        <div class="field"><label class="check"><input type="checkbox" data-g="${gi}" data-k="required" ${g.minSelect > 0 ? raw('checked') : ''}><span>${t('extras.required')}</span></label><div class="hint">${t('extras.requiredHint')}</div></div>
        ${g.minSelect > 0 ? html`<div class="field"><label>${t('extras.min')}</label><input type="number" min="1" max="${g.options.length}" data-g="${gi}" data-k="minSelect" value="${g.minSelect}"></div>` : ''}
        <div class="field"><label>${t('extras.max')}</label><input type="number" min="1" max="${g.options.length}" data-field="optionGroups[${gi}].maxSelect" data-g="${gi}" data-k="maxSelect" value="${g.maxAuto ? g.options.length : g.maxSelect}"><div class="hint">${t('extras.maxHint')}</div></div>
      </div>
      ${g.options.map((o, oi) => html`<div class="extra-row" data-o="${oi}">
        <div class="field"><label>${t('extras.nameAr')} <span class="tag">AR</span></label><input data-field="optionGroups[${gi}].options[${oi}].nameAr" data-g="${gi}" data-o="${oi}" data-k="nameAr" dir="rtl" lang="ar" maxlength="80" value="${o.nameAr}"></div>
        <div class="field"><label>${t('extras.nameEn')} <span class="tag">EN</span></label><input data-field="optionGroups[${gi}].options[${oi}].nameEn" data-g="${gi}" data-o="${oi}" data-k="nameEn" dir="ltr" lang="en" maxlength="80" value="${o.nameEn}"></div>
        <div class="field"><label>${t('extras.price')} (${cur})</label><input inputmode="decimal" data-field="optionGroups[${gi}].options[${oi}].priceCents" data-g="${gi}" data-o="${oi}" data-k="price" value="${o.price}" placeholder="0.00"></div>
        <div class="field"><label>${t('extras.maxQty')}</label><input type="number" min="1" max="20" data-field="optionGroups[${gi}].options[${oi}].maxQuantity" data-g="${gi}" data-o="${oi}" data-k="maxQuantity" value="${o.maxQuantity}"></div>
        <div class="field"><label class="check"><input type="checkbox" data-g="${gi}" data-o="${oi}" data-k="isAvailable" ${o.isAvailable ? raw('checked') : ''}><span>${t('extras.enabled')}</span></label></div>
        <div class="row-actions"><button type="button" class="btn secondary icon" data-do="o-up" data-g="${gi}" data-o="${oi}" ${oi === 0 ? raw('disabled') : ''} aria-label="${t('common.moveUp')}">${icon('up', { size: 16 })}</button>
          <button type="button" class="btn secondary icon" data-do="o-down" data-g="${gi}" data-o="${oi}" ${oi === g.options.length - 1 ? raw('disabled') : ''} aria-label="${t('common.moveDown')}">${icon('down', { size: 16 })}</button>
          <button type="button" class="btn danger icon" data-do="o-del" data-g="${gi}" data-o="${oi}" ${g.options.length === 1 ? raw('disabled') : ''} aria-label="${t('common.delete')}">${icon('close', { size: 16 })}</button></div></div>`)}
      <button type="button" class="btn secondary sm" data-do="o-add" data-g="${gi}">${icon('plus', { size: 16 })} ${t('extras.addExtra')}</button></div>`)}`
    : html`<p class="muted">${t('extras.none')}</p>`);
    // tie every visible label to its input (the editor is re-rendered often, so ids are generated here)
    $$('.field', extrasBox).forEach((field, i) => {
      const label = $('label', field);
      const input = $('input', field);
      if (label && input && !label.contains(input) && !input.id) { input.id = `ex-${i}-${gi0++}`; label.htmlFor = input.id; }
    });
  };
  let gi0 = 0;
  drawExtras();
  const clamp = (g) => { g.maxSelect = Math.min(Math.max(g.maxAuto ? g.options.length : g.maxSelect, 1), g.options.length); g.minSelect = g.minSelect > 0 ? Math.min(g.minSelect, g.maxSelect) : 0; };
  extrasBox.addEventListener('input', (e) => { // mirror typing into the state (no re-render: focus and caret stay put)
    const el = e.target.closest('[data-k]');
    if (!el) return;
    const g = groups[Number(el.dataset.g)];
    const o = el.dataset.o !== undefined ? g.options[Number(el.dataset.o)] : null;
    const k = el.dataset.k;
    if (el.type === 'checkbox') return; // handled on change
    if (o) o[k] = k === 'maxQuantity' ? Number(el.value) || 1 : el.value;
    else if (k === 'maxSelect') { g.maxSelect = Number(el.value) || 1; g.maxAuto = false; } else if (k === 'minSelect') g.minSelect = Number(el.value) || 1; else g[k] = el.value;
  });
  extrasBox.addEventListener('change', (e) => {
    const el = e.target.closest('input[type=checkbox][data-k]');
    if (!el) return;
    const g = groups[Number(el.dataset.g)];
    const o = el.dataset.o !== undefined ? g.options[Number(el.dataset.o)] : null;
    if (o) o.isAvailable = el.checked;
    else if (el.dataset.k === 'required') { g.minSelect = el.checked ? 1 : 0; drawExtras(); }
  });
  extrasBox.addEventListener('click', (e) => {
    const b = e.target.closest('[data-do]');
    if (!b) return;
    const gi = Number(b.dataset.g); const oi = Number(b.dataset.o);
    const swap = (arr, i, j) => { if (j >= 0 && j < arr.length) [arr[i], arr[j]] = [arr[j], arr[i]]; };
    const act = b.dataset.do;
    if (act === 'g-up') swap(groups, gi, gi - 1);
    else if (act === 'g-down') swap(groups, gi, gi + 1);
    else if (act === 'g-del') groups.splice(gi, 1);
    else if (act === 'o-up') swap(groups[gi].options, oi, oi - 1);
    else if (act === 'o-down') swap(groups[gi].options, oi, oi + 1);
    else if (act === 'o-del') { groups[gi].options.splice(oi, 1); clamp(groups[gi]); } else if (act === 'o-add') { groups[gi].options.push(newExtra()); clamp(groups[gi]); }
    drawExtras();
  });
  $('#add-group', box).addEventListener('click', () => { if (groups.length >= 10) { toast(t('extras.tooManyGroups'), 'err'); return; } groups.push(newGroup()); drawExtras(); });
  if (focusExtras) setTimeout(() => $('#extras-section', box)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);

  // ---- save
  onSubmit(form, async (v) => {
    const fail = (field, reason) => Object.assign(new Error(reason), { code: 'validation_error', details: { field, reason } });
    const orig = toCents(v.original);
    if (Number.isNaN(orig)) throw fail('originalPriceCents', 'invalid_money');
    let disc = null;
    if (v.discounted.trim() !== '') { disc = toCents(v.discounted); if (Number.isNaN(disc)) throw fail('discountedPriceCents', 'invalid_money'); }
    const body = {
      nameAr: v.nameAr, nameEn: v.nameEn, descriptionAr: v.descriptionAr, descriptionEn: v.descriptionEn,
      originalPriceCents: orig, discountedPriceCents: disc,
      categoryId: v.categoryId ? Number(v.categoryId) : null, isAvailable: v.isAvailable, trackStock: v.trackStock,
      optionGroups: groups.map((g, gi) => ({
        id: g.id, nameAr: g.nameAr, nameEn: g.nameEn, minSelect: g.minSelect, maxSelect: g.maxAuto ? g.options.length : g.maxSelect,
        options: g.options.map((o, oi) => {
          const cents = o.price.trim() === '' ? 0 : toCents(o.price);
          if (Number.isNaN(cents)) throw fail(`optionGroups[${gi}].options[${oi}].priceCents`, 'invalid_money');
          return { id: o.id, nameAr: o.nameAr, nameEn: o.nameEn, priceCents: cents, maxQuantity: o.maxQuantity, isAvailable: o.isAvailable };
        }),
      })),
    };
    // The stock quantity is only sent when the owner changed it (or on create): a stale value typed from an old screen must not
    // overwrite units that were sold while the form was open. Restocking uses the atomic "add" action instead.
    // (a disabled field is not part of the form data: with tracking off there is nothing to send)
    if (d.branchCount < 2 && v.trackStock && (!product || !product.trackStock || Number(v.stockQuantity) !== originalTrackedQty)) body.stockQuantity = Number(v.stockQuantity); // several branches: quantities are set per branch on the stock page
    const file = $('#f-img', box).files[0];
    if (file) body.imageUrl = (await api('/manage/uploads', { method: 'POST', raw: true, body: file, headers: { 'Content-Type': file.type } })).url;
    await api(product ? `/manage/products/${product.id}` : '/manage/products', { method: product ? 'PUT' : 'POST', body });
    toast(product ? t('dishForm.updated') : t('dishForm.added'), 'ok');
    location.hash = '#menu/dishes';
  });
}
