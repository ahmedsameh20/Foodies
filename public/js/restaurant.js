import {
  api, session, mountChrome, publicConfig, $, $$, render, html, raw, esc, money, errorBox, emptyState, onSubmit, toast, wireDialog, t, loc, errorMessage,
} from './common.js';
import { lineCents, extraLineCents } from './pricing.js';
import { catThumb, watchCategoryImages } from './category-image.js';

mountChrome({ active: 'restaurants' });

// tenant: injected by the server for <slug>.<platform-domain> / custom domains, otherwise taken from /restaurant/<slug> or /r/<slug>
const slug = document.querySelector('meta[name=tenant-slug]')?.content || decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
const CART_KEY = `foodies.cart.v3.${slug}`;
const OLD_CART_KEY = `foodies.cart.v2.${slug}`;
const BRANCH_KEY = `foodies.branch.${slug}`;
const MAX_LINE_QTY = 50;
const LOW_STOCK = 10;
let data; // { restaurant, categories, products, whatsappUrl }
let config = { serviceFee: { bp: 0, fixedCents: 0 }, paymentMethods: { card: false, cod: true } };
let cart = loadCart(); // dish lines { key, productId, options: [{ id, qty }], instructions, quantity } and general-extra lines { key: 'x:<id>', extraId, quantity }
let orderType = 'delivery';
let query = '';
// Restaurants with several branches: stock and the preparing kitchen are per branch, so the customer picks one (remembered per restaurant).
let branchId = (() => { try { return Number(localStorage.getItem(BRANCH_KEY)) || null; } catch { return null; } })();
function setBranch(id) { branchId = id; try { if (id) localStorage.setItem(BRANCH_KEY, String(id)); else localStorage.removeItem(BRANCH_KEY); } catch { /* storage blocked */ } }
const branchName = (b) => loc(b) || b.name;
const currentBranch = () => (data.branches || []).find((b) => b.id === (data.selectedBranchId ?? branchId));

// The menu as seen from the chosen branch (quantities and availability differ per branch).
async function fetchMenu() {
  const base = `/public/restaurants/${encodeURIComponent(slug)}`;
  let d;
  try { d = await api(branchId ? `${base}?branchId=${branchId}` : base); } catch (e) {
    if (e.code === 'invalid_branch' && branchId) { setBranch(null); return fetchMenu(); } // the remembered branch no longer exists
    throw e;
  }
  if (d.branches.length > 1 && !d.selectedBranchId) { setBranch(d.branches[0].id); return fetchMenu(); }
  if (d.branches.length === 1) branchId = d.branches[0].id; else if (!d.branches.length) branchId = null;
  return d;
}

function loadCart() {
  try {
    const c = JSON.parse(localStorage.getItem(CART_KEY));
    if (Array.isArray(c)) return c;
    // carts saved before extras had quantities: { productId, optionIds, quantity }
    const old = JSON.parse(localStorage.getItem(OLD_CART_KEY));
    if (Array.isArray(old)) return old.map((l) => makeLine(l.productId, (l.optionIds || []).map((id) => ({ id, qty: 1 })), '', l.quantity));
  } catch { /* corrupted or blocked storage: start with an empty cart */ }
  return [];
}
function saveCart() { try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* ignore */ } }
// Two cart lines are the same line when dish, extras (with quantities) and instructions are identical - exactly how the server merges them.
const lineKey = (productId, options, instructions) => JSON.stringify([productId, [...options].sort((a, b) => a.id - b.id).map((o) => [o.id, o.qty]), instructions || '']);
const makeExtraLineFor = (x) => ({ key: extraKey(x.id), extraId: x.id, quantity: 1 });
function makeLine(productId, options, instructions, quantity) {
  return { key: lineKey(productId, options, instructions), productId, options, instructions: instructions || '', quantity };
}

const EXTRA_CATS = ['drinks', 'sides', 'sauces', 'other'];
const productById = (id) => data.products.find((p) => p.id === id);
// General extras (water, fries, sauces ...) are independent cart lines: no dish, their own quantity and price.
const extraById = (id) => (data.extras || []).find((x) => x.id === id);
const isExtraLine = (l) => l.extraId !== undefined;
const extraKey = (id) => `x:${id}`;
// most of this extra the customer may still have in the cart (the owner's per-order maximum, stock when tracked)
const extraMax = (x) => Math.max(0, Math.min(MAX_LINE_QTY, x.maxQuantity, x.trackStock ? x.stockQuantity : MAX_LINE_QTY));
const optionById = (p, id) => p.optionGroups.flatMap((g) => g.options).find((o) => o.id === id);
const groupOf = (p, optionId) => p.optionGroups.find((g) => g.options.some((o) => o.id === optionId));
const currency = () => data.restaurant.currency;
const m = (c) => money(c, currency());

// ---- money (display estimate only: the server recomputes every figure from its own data when the order is placed) ----
// one dish = selling price (discounted when a discount is active) + sum(extra price x extra quantity); a line = one dish x its quantity
const lineTotal = (l) => (isExtraLine(l) ? extraLineCents(extraById(l.extraId), l.quantity) : lineCents(productById(l.productId), l.options, l.quantity));

function totals() {
  const r = data.restaurant;
  const subtotal = cart.reduce((s, l) => s + lineTotal(l), 0);
  const pct = (c, bp) => Math.floor((c * bp + 5000) / 10000);
  const tax = pct(subtotal, r.taxRateBp);
  const fee = orderType === 'delivery' && subtotal > 0 ? r.deliveryFeeCents : 0;
  const service = subtotal > 0 ? pct(subtotal, config.serviceFee.bp) + config.serviceFee.fixedCents : 0;
  return { subtotal, tax, fee, service, total: subtotal + tax + fee + service, count: cart.reduce((a, l) => a + l.quantity, 0) };
}

// ---- coupon ----
// The customer types a code; the SERVER validates it and prices the cart (POST /quote). Everything shown for a coupon comes from that answer, and it is
// asked again whenever the cart, the order type or the branch changes, so a coupon the new cart no longer qualifies for is dropped with the reason.
const COUPON_KEY = `foodies.coupon.${slug}`;
let couponCode = (() => { try { return sessionStorage.getItem(COUPON_KEY) || null; } catch { return null; } })();
let cq = null; // { sig, quote } the server's answer for one exact cart (quote is null when the cart itself could not be priced)
let couponMsg = null; // { kind: 'ok' | 'err', text }
let requoteScheduled = false;
function setCoupon(code) { couponCode = code || null; try { if (code) sessionStorage.setItem(COUPON_KEY, code); else sessionStorage.removeItem(COUPON_KEY); } catch { /* storage blocked */ } }
const cartSig = () => JSON.stringify([cart.map((l) => [l.key, l.quantity]), orderType, branchId, couponCode]);
const isCustomer = () => session.user?.role === 'customer';
const liveQuote = () => (cq && cq.quote && cq.sig === cartSig() ? cq.quote : null);
const payable = () => liveQuote()?.totalCents ?? totals().total;
function cartPayload() {
  return {
    items: cart.filter((l) => !isExtraLine(l)).map((l) => ({ productId: l.productId, quantity: l.quantity, options: l.options.map((o) => ({ optionId: o.id, quantity: o.qty })), instructions: l.instructions || undefined })),
    extras: cart.filter(isExtraLine).map((l) => ({ extraId: l.extraId, quantity: l.quantity })),
    orderType, branchId: (data.branches || []).length ? (currentBranch() || data.branches[0]).id : undefined,
  };
}
async function requote(manual = false) {
  if (!couponCode || !cart.length || !isCustomer()) { cq = null; drawCart(); return; }
  const sig = cartSig();
  try {
    const { quote } = await api(`/public/restaurants/${encodeURIComponent(slug)}/quote`, { method: 'POST', body: { ...cartPayload(), couponCode } });
    if (sig !== cartSig()) return; // the cart changed meanwhile: a newer answer is on its way
    cq = { sig, quote };
    if (manual) couponMsg = { kind: 'ok', text: t('coupon.applied') };
  } catch (err) {
    if (sig !== cartSig()) return;
    couponMsg = { kind: 'err', text: errorMessage(err) };
    if (String(err.code || '').startsWith('coupon_')) { setCoupon(null); cq = null; } else cq = { sig, quote: null };
  }
  drawCart();
}

// ---- stock ----
const inCartQty = (productId, exceptKey) => cart.filter((l) => !isExtraLine(l) && l.productId === productId && l.key !== exceptKey).reduce((s, l) => s + l.quantity, 0);
// how many more units of this dish may still be added (other cart lines of the same dish count against the same stock)
function room(p, exceptKey) {
  if (!p.isAvailable) return 0;
  return Math.max(0, Math.min(MAX_LINE_QTY, p.trackStock ? p.stockQuantity - inCartQty(p.id, exceptKey) : MAX_LINE_QTY));
}

// Drops / trims cart lines that no longer match the menu (dish gone, sold out, extra removed, less stock than in the cart).
function reconcileCart() {
  const before = JSON.stringify(cart);
  const used = new Map();
  cart = cart.filter((l) => {
    if (isExtraLine(l)) { // an extra that is gone, switched off or sold out leaves the cart; a quantity above the maximum / stock is trimmed
      const x = extraById(l.extraId);
      if (!x || !x.orderable) return false;
      l.quantity = Math.min(l.quantity, extraMax(x));
      return l.quantity >= 1;
    }
    const p = productById(l.productId);
    if (!p || !p.isAvailable || (p.trackStock && p.stockQuantity <= 0)) return false;
    const okOptions = l.options.every((o) => { const opt = optionById(p, o.id); return opt && opt.isAvailable && o.qty >= 1 && o.qty <= opt.maxQuantity; });
    if (!okOptions) return false;
    const left = p.trackStock ? p.stockQuantity - (used.get(p.id) || 0) : MAX_LINE_QTY;
    l.quantity = Math.min(l.quantity, left, MAX_LINE_QTY);
    if (l.quantity < 1) return false;
    used.set(p.id, (used.get(p.id) || 0) + l.quantity);
    return true;
  });
  saveCart();
  return JSON.stringify(cart) !== before;
}

async function init() {
  try {
    [data, config] = await Promise.all([fetchMenu(), publicConfig()]);
  } catch (e) {
    document.title = `${t('rest.notFoundTitle')} | Foodies`;
    return render($('#root'), e.status === 404 ? html`<div class="empty"><strong>${t('rest.notFoundTitle')}</strong>${t('rest.notFoundText')}<br><br><a class="btn" href="/restaurants.html">${t('rest.browse')}</a></div>` : errorBox(e));
  }
  document.title = `${loc(data.restaurant)} | ${t('rest.orderOnline')}`;
  reconcileCart();
  draw();
}

// Reloads the menu after the server rejected an order line (stock changed, dish switched off ...) so the visitor sees the truth.
async function refreshMenu() {
  try { data = await fetchMenu(); } catch { return; }
  const changed = reconcileCart();
  draw();
  if (changed) toast(t('cart.adjusted'), '');
}

// ---- search: matches the dish name / description in BOTH languages (a customer may type either), and the category name ----
const norm = (s) => String(s || '').toLocaleLowerCase().normalize('NFKD').replace(/[ً-ٰٟ]/g, ''); // also ignores Arabic diacritics
function matches(p, q) {
  if (!q) return true;
  const hay = norm([p.name, p.nameAr, p.nameEn, p.description, p.descriptionAr, p.descriptionEn].join(' '));
  return norm(q).split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

const extraMatches = (x, q) => {
  if (!q) return true;
  const hay = norm([x.name, x.nameAr, x.nameEn, x.descriptionAr, x.descriptionEn].join(' '));
  return norm(q).split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};

function priceLine(p, prefix = '') {
  return p.hasDiscount
    ? html`<span class="price-line"><span class="price-now">${prefix}${m(p.priceCents)}</span><span class="price-was" aria-label="${t('dish.wasPrice', { price: m(p.originalPriceCents) })}">${m(p.originalPriceCents)}</span><span class="badge sale">${t('dish.percentOff', { n: p.discountPercent })}</span></span>`
    : html`<span class="price-line"><span class="price-now">${prefix}${m(p.priceCents)}</span></span>`;
}

// "Ordering from": a picker for several branches, a plain line for one. Each branch links to its place on OpenStreetMap.
function branchBar() {
  const list = data.branches || [];
  if (!list.length) return '';
  const cur = currentBranch() || list[0];
  const osm = (b) => (b.latitude !== null && b.longitude !== null ? html` <a class="small" href="https://www.openstreetmap.org/?mlat=${b.latitude}&mlon=${b.longitude}#map=17/${b.latitude}/${b.longitude}" target="_blank" rel="noopener">${t('branch.viewMap')}</a>` : '');
  if (list.length === 1) return html`<p class="muted small branch-line">${t('branch.orderingFrom', { name: branchName(cur) })}${cur.address ? ` · ${cur.address}` : ''}${osm(cur)}</p>`;
  return html`<div class="card branch-bar"><div class="field" style="margin:0"><label for="branch-pick">${t('branch.pick')}</label>
    <select id="branch-pick">${list.map((b) => html`<option value="${b.id}" ${b.id === cur.id ? raw('selected') : ''}>${branchName(b)}${b.address ? ` — ${b.address}` : ''}</option>`)}</select>
    <div class="hint">${t('branch.pickHint')}${osm(cur)}</div></div></div>`;
}

watchCategoryImages(document);

function draw() {
  const r = data.restaurant;
  const visible = data.products.filter((p) => matches(p, query));
  const byCat = new Map();
  for (const p of visible) {
    const k = p.categoryId ?? 0;
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k).push(p);
  }
  const cats = [...data.categories.map((c) => ({ id: c.id, name: loc(c), imageUrl: c.imageUrl })), ...(byCat.has(0) ? [{ id: 0, name: t('rest.other') }] : [])].filter((c) => byCat.get(c.id)?.length);
  const visibleExtras = (data.extras || []).filter((x) => extraMatches(x, query));
  const hadFocus = document.activeElement?.id === 'menu-q';

  render($('#root'), html`
    ${r.coverUrl ? html`<img src="${r.coverUrl}" alt="" style="width:100%;max-height:220px;object-fit:cover;border-radius:12px;margin-bottom:1rem">` : ''}
    <div class="rest-head">
      <img src="${r.logoUrl || '/Images/Restaurants/download.png'}" alt="${t('rest.logoOf', { name: loc(r) })}">
      <div><h1 style="margin:0">${loc(r)} ${r.isDemo ? raw(`<span class="badge demo">${esc(t('rest.sample'))}</span>`) : ''}</h1>
        <p class="muted" style="margin:.25rem 0 0">${[r.city, r.address, r.phone].filter(Boolean).join(' · ')}</p>
        ${loc(r, 'description') ? html`<p class="muted small" style="margin:.25rem 0 0">${loc(r, 'description')}</p>` : ''}
        ${data.whatsappUrl ? html`<p class="small" style="margin:.25rem 0 0"><a href="${data.whatsappUrl}" target="_blank" rel="noopener">${t('rest.whatsapp')}</a></p>` : ''}</div>
    </div>
    ${branchBar()}
    ${r.acceptingOrders ? '' : html`<div class="alert warn" role="status">${r.isOpenNow ? t('rest.notAccepting') : t('rest.closed')} ${t('rest.canBrowse')}</div>`}
    <div class="shop">
      <section aria-label="${t('rest.menu')}">
        ${data.products.length || (data.extras || []).length ? html`<div class="field menu-search"><label class="sr-only" for="menu-q">${t('rest.search')}</label><input id="menu-q" type="search" value="${query}" placeholder="${t('rest.searchPlaceholder')}" autocomplete="off"></div>` : ''}
        ${cats.length || visibleExtras.length ? html`<nav class="cat-nav" aria-label="${t('rest.categories')}">${cats.map((c) => html`<a href="#cat-${c.id}" class="cat-chip">${catThumb(c, 'sm')}<span>${c.name}</span></a>`)}${visibleExtras.length ? html`<a href="#extras-section">${t('gx.navChip')}</a>` : ''}</nav>` : ''}
        ${cats.length ? cats.map((c) => html`<h2 id="cat-${c.id}" class="cat-title" style="margin-top:1.25rem">${catThumb(c)}<span>${c.name}</span></h2>
          <div class="grid">${byCat.get(c.id).map(dish)}</div>`)
          : visibleExtras.length ? '' : data.products.length || (data.extras || []).length ? emptyState(t('rest.noMatch'), t('rest.noMatchText')) : emptyState(t('rest.emptyMenu'), t('rest.emptyMenuText'))}
        ${extrasSection(visibleExtras)}
      </section>
      <aside class="cart card" id="cart-anchor" aria-label="${t('cart.title')}"><div id="cart"></div></aside>
    </div>`);
  drawCart();
  if (hadFocus) { const q = $('#menu-q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

// "Extras": drinks, sides and sauces that can be ordered without choosing a dish. In the cart they are lines of their own.
function extrasSection(list) {
  if (!list.length) return '';
  const groups = EXTRA_CATS.map((c) => ({ c, items: list.filter((x) => x.category === c) })).filter((g) => g.items.length);
  return html`<section class="extras-section" id="extras-section" aria-labelledby="extras-h">
    <h2 id="extras-h">${t('gx.section')}</h2><p class="muted sub">${t('gx.sectionIntro')}</p>
    ${groups.map((g) => html`<h3 class="extra-cat">${t(`gx.cat.${g.c}`)}</h3><div class="grid">${g.items.map(extraCard)}</div>`)}</section>`;
}

function extraCard(x) {
  const out = !x.orderable;
  const line = cart.find((l) => l.extraId === x.id);
  const name = loc(x);
  const desc = loc(x, 'description');
  const left = x.trackStock ? x.stockQuantity : null;
  return html`<article class="card extra-card ${out ? 'off' : ''}">
    <img src="${x.imageUrl || '/Images/Restaurants/download.png'}" alt="" loading="lazy">
    <div><div class="name">${name}</div>${desc ? html`<div class="muted small">${desc}</div>` : ''}
      <div><span class="price-now">${m(x.priceCents)}</span> ${!out && left !== null && left <= LOW_STOCK ? html`<span class="badge stock-low">${t('stock.onlyLeft', { n: left })}</span>` : ''}</div></div>
    <div class="add">${out ? html`<span class="badge stock-out">${t('dish.outOfStock')}</span>`
    : line ? html`<span class="qty"><button data-xdec="${x.id}" aria-label="${t('dish.fewer', { name })}">−</button><span aria-live="polite">${line.quantity}</span><button data-xinc="${x.id}" aria-label="${t('dish.more', { name })}" ${line.quantity < extraMax(x) ? '' : raw('disabled')}>+</button></span>`
      : raw(`<button class="btn sm" data-xadd="${x.id}" aria-label="${esc(t('dish.addAria', { name }))}">${esc(t('dish.add'))}</button>`)}</div>
  </article>`;
}

function dish(p) {
  const left = p.trackStock ? p.stockQuantity : null;
  const out = !p.isAvailable || (p.trackStock && left <= 0);
  const inCart = inCartQty(p.id);
  const hasExtras = p.optionGroups.some((g) => g.options.length);
  const name = loc(p);
  const desc = loc(p, 'description');
  return html`<article class="card dish ${out ? 'off' : ''}">
    <img src="${p.imageUrl || '/Images/Restaurants/download.png'}" alt="" loading="lazy">
    <div><div class="name">${name}</div>${desc ? html`<div class="muted small">${desc}</div>` : ''}
      <div>${priceLine(p)} ${inCart ? html`<span class="badge ok nocap">${t('dish.inCart', { n: inCart })}</span>` : ''}
        ${!out && p.trackStock && left <= LOW_STOCK ? html`<span class="badge stock-low">${t('stock.onlyLeft', { n: left })}</span>` : ''}
        ${hasExtras && !out ? html`<span class="badge nocap">${t('dish.hasExtras')}</span>` : ''}</div></div>
    <div class="add">${out ? html`<span class="badge stock-out">${p.isAvailable ? t('dish.outOfStock') : t('dish.soldOut')}</span>`
    : raw(`<button class="btn sm" data-add="${p.id}" aria-label="${esc(t('dish.addAria', { name }))}">${esc(hasExtras ? t('dish.customize') : t('dish.add'))}</button>`)}</div>
  </article>`;
}

function drawCart() {
  const r = data.restaurant;
  const tt = totals();
  const u = session.user;
  if (couponCode && cart.length && isCustomer() && (!cq || cq.sig !== cartSig()) && !requoteScheduled) { // the cart changed: ask the server again
    requoteScheduled = true;
    setTimeout(() => { requoteScheduled = false; requote(); }, 0);
  }
  const q = liveQuote();
  let bar = $('.cart-toggle');
  if (!bar) { bar = document.createElement('a'); bar.className = 'cart-toggle btn'; bar.href = '#cart-anchor'; document.body.append(bar); }
  bar.classList.toggle('has-items', tt.count > 0);
  bar.textContent = t('cart.viewOrder', { n: tt.count, total: m(payable()) });
  render($('#cart'), html`<h2>${t('cart.title')}</h2>
    ${cart.length === 0 ? html`<p class="muted">${t('cart.empty')}</p>` : html`
      ${cart.map((l) => {
    if (isExtraLine(l)) {
      const x = extraById(l.extraId);
      const xname = loc(x);
      return html`<div class="cart-line is-extra"><span><span class="line-title"><strong>${xname}</strong><span class="badge nocap kind">${t('gx.lineBadge')}</span></span>
          <div class="line-extras"><bdi>${m(x.priceCents)}</bdi> × ${l.quantity}</div></span>
        <strong>${m(lineTotal(l))}</strong>
        <span class="qty"><button data-dec="${l.key}" aria-label="${t('cart.removeOne', { name: xname })}">−</button><span aria-live="polite">${l.quantity}</span><button data-inc="${l.key}" aria-label="${t('cart.addOne', { name: xname })}" ${l.quantity < extraMax(x) ? '' : raw('disabled')}>+</button></span>
        <button class="link small" data-rm="${l.key}" style="justify-self:end;color:var(--err)">${t('cart.remove')}</button></div>`;
    }
    const p = productById(l.productId);
    const name = loc(p);
    const canAdd = l.quantity < Math.min(MAX_LINE_QTY, p.trackStock ? p.stockQuantity - inCartQty(p.id, l.key) : MAX_LINE_QTY);
    return html`<div class="cart-line"><span><strong>${name}</strong>
        ${p.hasDiscount ? html`<div class="price-line small"><span class="price-was">${m(p.originalPriceCents)}</span><span>${m(p.priceCents)}</span></div>` : ''}
        ${l.options.length ? html`<ul class="line-extras">${l.options.map((o) => { const opt = optionById(p, o.id); return html`<li>+ ${loc(opt)}${o.qty > 1 ? ` × ${o.qty}` : ''} <bdi>(${m(opt.priceCents * o.qty)})</bdi></li>`; })}</ul>` : ''}
        ${l.instructions ? html`<div class="line-note"><strong>${t('cart.instructions')}:</strong> ${l.instructions}</div>` : ''}</span>
      <strong>${m(lineTotal(l))}</strong>
      <span class="qty"><button data-dec="${l.key}" aria-label="${t('cart.removeOne', { name })}">−</button><span aria-live="polite">${l.quantity}</span><button data-inc="${l.key}" aria-label="${t('cart.addOne', { name })}" ${canAdd ? '' : raw('disabled')}>+</button></span>
      <button class="link small" data-rm="${l.key}" style="justify-self:end;color:var(--err)">${t('cart.remove')}</button></div>`;
  })}
      ${isCustomer() && cart.length ? html`<div class="coupon-box">
        ${q && q.coupon ? html`<div class="coupon-applied"><span><span class="badge ok nocap"><bdi dir="ltr">${q.coupon.code}</bdi></span> ${t('coupon.appliedLabel')}</span><button type="button" class="link small" data-coupon-remove>${t('coupon.remove')}</button></div>`
          : html`<label class="small" for="coupon-input">${t('coupon.haveCode')}</label><div class="inline-edit"><input id="coupon-input" dir="ltr" maxlength="40" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${couponCode || ''}" placeholder="${t('coupon.placeholder')}"><button type="button" class="btn secondary sm" data-coupon-apply>${t('coupon.apply')}</button></div>`}
        <div class="small ${couponMsg?.kind === 'err' ? 'warn-text' : 'ok-text'}" role="status" aria-live="polite">${couponMsg ? couponMsg.text : ''}</div></div>` : ''}
      <div class="totals" style="margin-top:.75rem">
        <div><span>${t('cart.subtotal')}</span><span>${m(q ? q.subtotalCents : tt.subtotal)}</span></div>
        ${q && q.automaticDiscountCents ? html`<div class="muted small"><span>${t('coupon.autoIncluded')}</span><span>${m(q.automaticDiscountCents)}</span></div>` : ''}
        ${q && q.coupon ? html`<div class="muted small"><span>${t('coupon.eligibleSubtotal')}</span><span>${m(q.coupon.eligibleSubtotalCents)}</span></div>
          <div class="ok-text"><span>${t('coupon.discountRow')} <bdi dir="ltr">(${q.coupon.code})</bdi></span><span>−${m(q.couponDiscountCents)}</span></div>` : ''}
        ${(q ? q.taxCents : r.taxRateBp ? tt.tax : 0) ? html`<div><span>${t('cart.tax')}</span><span>${m(q ? q.taxCents : tt.tax)}</span></div>` : ''}
        ${orderType === 'delivery' ? html`<div><span>${t('cart.delivery')}</span><span>${m(q ? q.deliveryFeeCents : tt.fee)}</span></div>` : ''}
        ${(q ? q.platformFeeCents : tt.service) ? html`<div><span>${t('cart.serviceFee')}</span><span>${m(q ? q.platformFeeCents : tt.service)}</span></div>` : ''}
        <div class="grand"><span>${t('cart.total')}</span><span>${m(payable())}</span></div>
      </div>
      ${r.minOrderCents && tt.subtotal < r.minOrderCents ? html`<p class="alert warn small">${t('cart.minimum', { amount: m(r.minOrderCents) })}</p>` : ''}
      <p class="muted small">${t('cart.serverConfirms')}</p>
      ${!u ? html`<a class="btn block" href="/login.html?next=${encodeURIComponent(location.pathname)}">${t('cart.signInToOrder')}</a>
          <p class="small muted" style="margin-top:.5rem">${t('cart.noAccount')} <a href="/register.html?next=${encodeURIComponent(location.pathname)}">${t('cart.register')}</a></p>`
    : u.role !== 'customer' ? html`<div class="alert info small">${t('cart.notCustomer', { role: t(`role.${u.role}`) })}</div>`
      : html`<button class="btn block" data-checkout ${r.acceptingOrders ? '' : raw('disabled')}>${t('cart.checkout')}</button>`}`}`);
}

// ---- dish dialog: choose extras (with quantities), add special instructions and the quantity ----
function groupHint(g) {
  if (g.minSelect > 0) return g.minSelect === g.maxSelect ? t('dish.chooseExactly', { n: g.minSelect }) : t('dish.chooseRange', { min: g.minSelect, max: g.maxSelect });
  return g.maxSelect === 1 ? t('dish.optionalOne') : t('dish.optionalUpTo', { n: g.maxSelect });
}

function dishDialog(p, editKey = null) {
  const maxQty = room(p, editKey);
  if (maxQty < 1) { toast(t('stock.noMore'), 'err'); return; }
  const name = loc(p);
  const desc = loc(p, 'description');
  const dlg = document.createElement('dialog');
  dlg.className = 'wide';
  dlg.setAttribute('aria-labelledby', 'od-title');
  dlg.innerHTML = html`<h2 id="od-title">${name}</h2>${desc ? html`<p class="muted">${desc}</p>` : ''}
    <p>${priceLine(p)} ${p.trackStock && p.stockQuantity <= LOW_STOCK ? html`<span class="badge stock-low">${t('stock.onlyLeft', { n: p.stockQuantity })}</span>` : ''}</p>
    <form novalidate><div class="form-alert"></div>
      ${p.optionGroups.map((g) => html`<fieldset class="option-group" data-group="${g.id}"><legend>${loc(g)} <span class="muted small">${groupHint(g)}</span></legend>
        ${g.options.map((o) => html`<div class="extra"><div class="check"><input type="checkbox" id="opt-${o.id}" data-opt="${o.id}" data-group="${g.id}" ${o.isAvailable ? '' : raw('disabled')}>
          <label for="opt-${o.id}">${loc(o)} ${o.priceCents ? html`<bdi>(+${m(o.priceCents)})</bdi>` : ''}${o.isAvailable ? '' : html` — ${t('dish.extraSoldOut')}`}</label></div>
          ${o.maxQuantity > 1 && o.isAvailable ? html`<span class="stepper" data-stepper="${o.id}" data-max="${o.maxQuantity}" hidden><button type="button" data-step="-1" aria-label="${t('dish.fewer', { name: loc(o) })}">−</button><output aria-live="polite">1</output><button type="button" data-step="1" aria-label="${t('dish.more', { name: loc(o) })}">+</button></span>` : ''}</div>`)}</fieldset>`)}
      <div class="field"><label for="od-notes">${t('dish.instructions')}</label>
        <textarea id="od-notes" name="instructions" maxlength="300" rows="2" placeholder="${t('dish.instructionsPlaceholder')}"></textarea>
        <div class="instructions-note">${t('dish.instructionsNote')}</div></div>
      <div class="field"><label for="od-qty-out">${t('dish.quantity')}</label>
        <span class="stepper" data-qty="1" data-max="${maxQty}"><button type="button" data-step="-1" aria-label="${t('dish.fewer', { name })}">−</button><output id="od-qty-out" aria-live="polite">1</output><button type="button" data-step="1" aria-label="${t('dish.more', { name })}">+</button></span>
        ${p.trackStock ? html`<span class="muted small"> ${t('stock.available', { n: p.stockQuantity })}</span>` : ''}</div>
      <div class="dish-live-total"><span>${t('cart.total')}</span><span id="od-total"></span></div>
      <div class="actions-row"><button class="btn" type="submit">${t('dish.addToOrder')}</button><button class="btn secondary" type="button" data-close>${t('common.cancel')}</button></div></form>`.s;
  document.body.append(dlg);
  dlg.showModal();
  wireDialog(dlg);
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dlg.close(); });

  const qtyBox = $('[data-qty]', dlg);
  const dishQty = () => Number($('output', qtyBox).textContent);
  const optQty = (id) => { const s = $(`[data-stepper="${id}"]`, dlg); return s ? Number($('output', s).textContent) : 1; };
  const picked = () => $$('input[data-opt]:checked', dlg).map((i) => ({ id: Number(i.dataset.opt), qty: optQty(i.dataset.opt) }));
  const refresh = () => {
    const sel = picked();
    // groups with a limit: once the maximum is reached the remaining extras of that group cannot be ticked
    for (const g of p.optionGroups) {
      const n = sel.filter((s) => groupOf(p, s.id)?.id === g.id).length;
      $$(`input[data-group="${g.id}"]`, dlg).forEach((i) => { const opt = optionById(p, Number(i.dataset.opt)); i.disabled = !opt.isAvailable || (!i.checked && g.maxSelect > 1 && n >= g.maxSelect); });
    }
    $$('[data-stepper]', dlg).forEach((s) => { s.hidden = !$(`#opt-${s.dataset.stepper}`, dlg).checked; });
    $('#od-total', dlg).textContent = m(lineCents(p, sel, dishQty()));
  };
  dlg.addEventListener('change', (e) => {
    const input = e.target.closest('input[data-opt]');
    if (input && input.checked) { // a single-choice group behaves like a radio list but stays deselectable
      const g = groupOf(p, Number(input.dataset.opt));
      if (g.maxSelect === 1) $$(`input[data-group="${g.id}"]`, dlg).forEach((i) => { if (i !== input) i.checked = false; });
    }
    refresh();
  });
  dlg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (!b) return;
    const box = b.closest('.stepper');
    const out = $('output', box);
    const next = Number(out.textContent) + Number(b.dataset.step);
    if (next >= 1 && next <= Number(box.dataset.max)) out.textContent = String(next);
    refresh();
  });
  refresh();

  $('form', dlg).addEventListener('submit', (e) => {
    e.preventDefault();
    const sel = picked();
    for (const g of p.optionGroups) {
      const n = sel.filter((s) => groupOf(p, s.id)?.id === g.id).length;
      if (n < g.minSelect || n > g.maxSelect) {
        $('.form-alert', dlg).innerHTML = `<div class="alert err" role="alert">${esc(t('dish.pleaseChoose', { name: loc(g), hint: groupHint(g) }))}</div>`;
        return;
      }
    }
    addToCart(p.id, sel, $('#od-notes', dlg).value.trim().replace(/\s*\n\s*/g, '\n'), dishQty());
    dlg.close();
  });
}

function addToCart(productId, options, instructions, quantity) {
  const p = productById(productId);
  const line = makeLine(productId, options, instructions, quantity);
  const ex = cart.find((l) => l.key === line.key);
  if (ex) ex.quantity = Math.min(ex.quantity + quantity, MAX_LINE_QTY, room(p, ex.key) + ex.quantity);
  else cart.push(line);
  saveCart();
  draw();
}

function checkoutDialog() {
  const r = data.restaurant;
  const u = session.user;
  const card = !!r.paymentMethods?.card;
  const dlg = document.createElement('dialog');
  dlg.className = 'wide';
  dlg.setAttribute('aria-labelledby', 'co-title');
  const idemKey = `ck_${crypto.randomUUID().replace(/-/g, '')}`; // one key per checkout attempt: a double-click can never create two orders
  dlg.innerHTML = html`<h2 id="co-title">${t('checkout.title')}</h2>
    <form id="co" novalidate>
      <div class="form-alert"></div>
      <fieldset class="field" style="border:0;padding:0;margin:0 0 1rem"><legend style="font-weight:600;font-size:.9rem">${t('checkout.how')}</legend>
        <div class="check"><input type="radio" id="t-del" name="orderType" value="delivery" ${orderType === 'delivery' ? raw('checked') : ''}><label for="t-del">${t('checkout.delivery', { fee: m(r.deliveryFeeCents) })}</label></div>
        <div class="check"><input type="radio" id="t-pick" name="orderType" value="pickup" ${orderType === 'pickup' ? raw('checked') : ''}><label for="t-pick">${t('checkout.pickup')}</label></div></fieldset>
      <div class="row"><div class="field"><label for="co-name">${t('checkout.yourName')}</label><input id="co-name" name="customerName" data-field="customerName" required value="${u.name}" maxlength="100"></div>
      <div class="field"><label for="co-phone">${t('field.phone')}</label><input id="co-phone" name="customerPhone" data-field="customerPhone" type="tel" dir="ltr" required value="${u.phone || ''}"></div></div>
      <div class="field" id="addr"><label for="co-addr">${t('checkout.address')}</label><textarea id="co-addr" name="deliveryAddress" data-field="deliveryAddress" maxlength="300"></textarea></div>
      <div class="field"><label for="co-notes">${t('checkout.notes')}</label><input id="co-notes" name="notes" maxlength="500"></div>
      <fieldset class="field" style="border:0;padding:0;margin:0 0 1rem"><legend style="font-weight:600;font-size:.9rem">${t('checkout.payment')}</legend>
        ${card ? html`<div class="check"><input type="radio" id="p-card" name="paymentMethod" value="card" checked><label for="p-card">${t('checkout.payOnline')}</label></div>` : ''}
        <div class="check"><input type="radio" id="p-cod" name="paymentMethod" value="cod" ${card ? '' : raw('checked')}><label for="p-cod">${t('checkout.cash')}</label></div>
        ${card ? html`<div class="hint small muted">${t('checkout.cardNote')}</div>` : html`<div class="hint small muted">${t('checkout.noCard')}</div>`}</fieldset>
      <div class="actions-row"><button class="btn" type="submit"><span id="co-label">${t('checkout.place')}</span> · <span id="co-total"></span></button><button class="btn secondary" type="button" data-close>${t('common.cancel')}</button></div>
    </form>`.s;
  document.body.append(dlg);
  dlg.showModal();
  const sync = () => {
    orderType = dlg.querySelector('input[name=orderType]:checked').value;
    $('#addr', dlg).classList.toggle('hidden', orderType !== 'delivery');
    $('#co-total', dlg).textContent = m(payable());
    $('#co-label', dlg).textContent = dlg.querySelector('input[name=paymentMethod]:checked')?.value === 'card' ? t('checkout.continuePay') : t('checkout.place');
    drawCart();
  };
  dlg.addEventListener('change', sync);
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dlg.close(); });
  wireDialog(dlg);
  sync();
  onSubmit($('#co', dlg), async (d) => {
    // Only ids, quantities and text are sent. Prices are never part of the request: the server prices every line from its own menu.
    const body = {
      items: cart.filter((l) => !isExtraLine(l)).map((l) => ({ productId: l.productId, quantity: l.quantity, options: l.options.map((o) => ({ optionId: o.id, quantity: o.qty })), instructions: l.instructions || undefined })),
      extras: cart.filter(isExtraLine).map((l) => ({ extraId: l.extraId, quantity: l.quantity })),
      orderType: d.orderType, paymentMethod: d.paymentMethod, customerName: d.customerName, customerPhone: d.customerPhone,
      deliveryAddress: d.deliveryAddress || undefined, notes: d.notes || undefined,
      branchId: (data.branches || []).length ? (currentBranch() || data.branches[0]).id : undefined,
      couponCode: couponCode || undefined, // only the code: the server recalculates the discount
    };
    let result;
    try {
      result = await api(`/public/restaurants/${encodeURIComponent(slug)}/orders`, { method: 'POST', body, headers: { 'Idempotency-Key': idemKey } });
    } catch (err) {
      if (String(err.code || '').startsWith('coupon_')) { // the coupon stopped being valid between the quote and the order
        setCoupon(null); cq = null; couponMsg = { kind: 'err', text: errorMessage(err) };
        dlg.close(); drawCart(); toast(couponMsg.text, 'err');
        return;
      }
      // the menu changed under the customer's feet (stock, availability, extras): show the fresh menu and the reason
      if (['insufficient_stock', 'out_of_stock', 'item_unavailable', 'option_unavailable', 'option_quantity_exceeded', 'invalid_item', 'invalid_option', 'invalid_extra', 'extra_unavailable', 'extra_quantity_exceeded', 'invalid_branch', 'branch_required', 'discount_changed'].includes(err.code)) {
        dlg.close();
        await refreshMenu();
        toast(errorMessage(err), 'err');
        return;
      }
      throw err;
    }
    const { order, paymentUrl } = result;
    cart = []; saveCart(); setCoupon(null); cq = null; couponMsg = null;
    dlg.close();
    // an account created before mobile numbers were required keeps the number given here for next time (best effort)
    if (u.phoneMissing || !u.phone) { api('/auth/me', { method: 'PATCH', body: { phone: d.customerPhone } }).then(({ user }) => session.set({ ...u, phone: user.phone })).catch(() => {}); }
    if (paymentUrl) { // hand over to the provider's hosted payment page
      render($('#root'), html`<div class="card" style="max-width:560px;margin:2rem auto"><h1>${t('checkout.redirecting')}</h1><p class="muted">${t('checkout.ifNothing')} <a href="${paymentUrl}">${t('checkout.continuePayLink')}</a>.</p></div>`);
      location.href = paymentUrl;
      return;
    }
    location.href = `/order.html?id=${order.id}`;
  }, { alertBox: $('.form-alert', dlg) });
}

// Applying / removing a coupon. Enter in the box applies it as well.
async function applyCouponFromBox() {
  const code = ($('#coupon-input')?.value || '').trim();
  if (!code) { couponMsg = { kind: 'err', text: t('coupon.enterCode') }; drawCart(); return; }
  setCoupon(code); cq = null; couponMsg = null;
  await requote(true);
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-coupon-apply]')) applyCouponFromBox();
  else if (e.target.closest('[data-coupon-remove]')) { setCoupon(null); cq = null; couponMsg = null; drawCart(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'coupon-input') { e.preventDefault(); applyCouponFromBox(); } });

// Choosing another branch: its own menu quantities apply, so the menu is reloaded and the cart is trimmed to what that branch can serve.
document.addEventListener('change', async (e) => {
  if (e.target.id !== 'branch-pick' || !data) return;
  setBranch(Number(e.target.value));
  await refreshMenu();
});

document.addEventListener('input', (e) => {
  if (e.target.id !== 'menu-q' || !data) return;
  query = e.target.value;
  draw();
});

document.addEventListener('click', (e) => {
  if (!data) return;
  const target = e.target.closest('[data-add],[data-inc],[data-dec],[data-rm],[data-checkout],[data-xadd],[data-xinc],[data-xdec]');
  if (!target) return;
  if (target.dataset.checkout !== undefined) { if (cart.length) checkoutDialog(); else toast(t('cart.isEmpty'), 'err'); return; }
  if (target.dataset.add) { dishDialog(productById(Number(target.dataset.add))); return; }
  const keepY = window.scrollY;
  const finish = () => { saveCart(); draw(); window.scrollTo(0, keepY); };
  // general extras: the card in the Extras section adds / adjusts the same cart line as the cart itself
  const xid = Number(target.dataset.xadd || target.dataset.xinc || target.dataset.xdec);
  if (xid) {
    const x = extraById(xid);
    if (!x) return;
    let line = cart.find((l) => l.extraId === xid);
    if (target.dataset.xadd) {
      if (!x.orderable) { toast(t('gx.noMore'), 'err'); return; }
      if (!line) cart.push(makeExtraLineFor(x));
    } else if (target.dataset.xinc) {
      if (line && line.quantity < extraMax(x)) line.quantity += 1; else toast(t('gx.maxReached', { max: extraMax(x) }), 'err');
    } else if (line) {
      line.quantity -= 1;
      if (line.quantity <= 0) cart = cart.filter((l) => l !== line);
    }
    return finish();
  }
  const line = cart.find((l) => l.key === (target.dataset.inc || target.dataset.dec || target.dataset.rm));
  if (!line) return;
  if (isExtraLine(line)) {
    const x = extraById(line.extraId);
    if (target.dataset.inc) { if (line.quantity < extraMax(x)) line.quantity += 1; else toast(t('gx.maxReached', { max: extraMax(x) }), 'err'); }
    if (target.dataset.dec) line.quantity -= 1;
    if (target.dataset.rm || line.quantity <= 0) cart = cart.filter((l) => l !== line);
    return finish();
  }
  const p = productById(line.productId);
  if (target.dataset.inc) {
    if (line.quantity < Math.min(MAX_LINE_QTY, p.trackStock ? p.stockQuantity - inCartQty(p.id, line.key) : MAX_LINE_QTY)) line.quantity += 1;
    else toast(t('stock.noMore'), 'err');
  }
  if (target.dataset.dec) line.quantity -= 1;
  if (target.dataset.rm || line.quantity <= 0) cart = cart.filter((l) => l !== line);
  finish();
});

init();
