import {
  api, session, mountChrome, publicConfig, $, render, html, raw, money, errorBox, emptyState, onSubmit, toast, wireDialog,
} from './common.js';

mountChrome({ active: 'restaurants' });

// tenant: injected by the server for <slug>.<platform-domain> / custom domains, otherwise taken from /restaurant/<slug> or /r/<slug>
const slug = document.querySelector('meta[name=tenant-slug]')?.content || decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
const CART_KEY = `foodies.cart.v2.${slug}`;
let data; // { restaurant, categories, products, whatsappUrl }
let config = { serviceFee: { bp: 0, fixedCents: 0 }, paymentMethods: { card: false, cod: true } };
let cart = loadCart(); // [{ key, productId, optionIds, quantity }]
let orderType = 'delivery';

function loadCart() { try { const c = JSON.parse(localStorage.getItem(CART_KEY)); return Array.isArray(c) ? c : []; } catch { return []; } }
function saveCart() { try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* ignore */ } }
const lineKey = (productId, optionIds) => `${productId}:${[...optionIds].sort((a, b) => a - b).join(',')}`;

async function init() {
  try {
    [data, config] = await Promise.all([api(`/public/restaurants/${encodeURIComponent(slug)}`), publicConfig()]);
  } catch (e) {
    document.title = 'Restaurant not found | Foodies';
    return render($('#root'), e.status === 404 ? html`<div class="empty"><strong>Restaurant not found</strong>It may have been renamed or is currently unavailable.<br><br><a class="btn" href="/restaurants.html">Browse restaurants</a></div>` : errorBox(e));
  }
  document.title = `${data.restaurant.name} | Order online`;
  // Drop cart lines whose dish or options no longer exist / are unavailable.
  cart = cart.filter((l) => {
    const p = productById(l.productId);
    return p && p.isAvailable && l.optionIds.every((id) => p.optionGroups.some((g) => g.options.some((o) => o.id === id && o.isAvailable)));
  });
  saveCart();
  draw();
}

const productById = (id) => data.products.find((p) => p.id === id);
const optionById = (p, id) => p.optionGroups.flatMap((g) => g.options).find((o) => o.id === id);
const unitPrice = (l) => { const p = productById(l.productId); return p.priceCents + l.optionIds.reduce((s, id) => s + optionById(p, id).priceCents, 0); };
const esc = (s) => String(s).replace(/[<>"&']/g, '');

// Display estimate only. The server recomputes every figure from its own data when the order is placed.
function totals() {
  const r = data.restaurant;
  const subtotal = cart.reduce((s, l) => s + unitPrice(l) * l.quantity, 0);
  const pct = (c, bp) => Math.floor((c * bp + 5000) / 10000);
  const tax = pct(subtotal, r.taxRateBp);
  const fee = orderType === 'delivery' && subtotal > 0 ? r.deliveryFeeCents : 0;
  const service = subtotal > 0 ? pct(subtotal, config.serviceFee.bp) + config.serviceFee.fixedCents : 0;
  return { subtotal, tax, fee, service, total: subtotal + tax + fee + service, count: cart.reduce((a, l) => a + l.quantity, 0) };
}

function draw() {
  const r = data.restaurant;
  const byCat = new Map();
  for (const p of data.products) {
    const k = p.categoryId ?? 0;
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k).push(p);
  }
  const cats = [...data.categories.map((c) => ({ id: c.id, name: c.name })), ...(byCat.has(0) ? [{ id: 0, name: 'Other' }] : [])].filter((c) => byCat.get(c.id)?.length);

  render($('#root'), html`
    ${r.coverUrl ? html`<img src="${r.coverUrl}" alt="" style="width:100%;max-height:220px;object-fit:cover;border-radius:12px;margin-bottom:1rem">` : ''}
    <div class="rest-head">
      <img src="${r.logoUrl || '/Images/Restaurants/download.png'}" alt="${r.name} logo">
      <div><h1 style="margin:0">${r.name} ${r.isDemo ? raw('<span class="badge demo">Sample</span>') : ''}</h1>
        <p class="muted" style="margin:.25rem 0 0">${[r.city, r.address, r.phone].filter(Boolean).join(' · ')}</p>
        ${r.description ? html`<p class="muted small" style="margin:.25rem 0 0">${r.description}</p>` : ''}
        ${data.whatsappUrl ? html`<p class="small" style="margin:.25rem 0 0"><a href="${data.whatsappUrl}" target="_blank" rel="noopener">Message on WhatsApp</a></p>` : ''}</div>
    </div>
    ${r.acceptingOrders ? '' : html`<div class="alert warn" role="status">${r.isOpenNow ? 'This restaurant is not accepting orders right now.' : 'This restaurant is closed right now.'} You can still browse the menu.</div>`}
    <div class="shop">
      <section aria-label="Menu">
        ${cats.length ? html`<nav class="cat-nav" aria-label="Menu categories">${cats.map((c) => html`<a href="#cat-${c.id}">${c.name}</a>`)}</nav>` : ''}
        ${cats.length ? cats.map((c) => html`<h2 id="cat-${c.id}" style="margin-top:1.25rem">${c.name}</h2>
          <div class="grid">${byCat.get(c.id).map((p) => dish(p, r))}</div>`)
          : emptyState('This menu is empty', 'The restaurant has not added any dishes yet.')}
      </section>
      <aside class="cart card" id="cart-anchor" aria-label="Your order"><div id="cart"></div></aside>
    </div>`);
  drawCart();
}

function dish(p, r) {
  const hasOptions = p.optionGroups.length > 0;
  const inCart = cart.filter((l) => l.productId === p.id).reduce((s, l) => s + l.quantity, 0);
  return html`<article class="card dish ${p.isAvailable ? '' : 'off'}">
    <img src="${p.imageUrl || '/Images/Restaurants/download.png'}" alt="" loading="lazy">
    <div><div class="name">${p.name}</div>${p.description ? html`<div class="muted small">${p.description}</div>` : ''}
      <div><strong>${hasOptions ? 'from ' : ''}${money(p.priceCents, r.currency)}</strong>${inCart ? html` <span class="badge ok">${inCart} in cart</span>` : ''}</div></div>
    <div class="add">${!p.isAvailable ? raw('<span class="badge">Sold out</span>')
    : raw(`<button class="btn sm" data-add="${p.id}" aria-label="Add ${esc(p.name)} to order">${hasOptions ? 'Customise' : 'Add'}</button>`)}</div>
  </article>`;
}

function drawCart() {
  const r = data.restaurant;
  const t = totals();
  const u = session.user;
  let bar = $('.cart-toggle');
  if (!bar) { bar = document.createElement('a'); bar.className = 'cart-toggle btn'; bar.href = '#cart-anchor'; document.body.append(bar); }
  bar.classList.toggle('has-items', t.count > 0);
  bar.textContent = `View order (${t.count}) · ${money(t.total, r.currency)}`;
  render($('#cart'), html`<h2>Your order</h2>
    ${cart.length === 0 ? html`<p class="muted">Your cart is empty. Add dishes from the menu.</p>` : html`
      ${cart.map((l) => {
    const p = productById(l.productId);
    return html`<div class="cart-line"><span>${p.name}${l.optionIds.length ? html`<div class="muted small">${l.optionIds.map((id) => optionById(p, id).name).join(', ')}</div>` : ''}</span><strong>${money(unitPrice(l) * l.quantity, r.currency)}</strong>
      <span class="qty"><button data-dec="${l.key}" aria-label="Remove one ${esc(p.name)}">−</button><span aria-live="polite">${l.quantity}</span><button data-inc="${l.key}" aria-label="Add one ${esc(p.name)}">+</button></span>
      <button class="link small" data-rm="${l.key}" style="justify-self:end;color:var(--err)">Remove</button></div>`;
  })}
      <div class="totals" style="margin-top:.75rem">
        <div><span>Subtotal</span><span>${money(t.subtotal, r.currency)}</span></div>
        ${r.taxRateBp ? html`<div><span>Tax</span><span>${money(t.tax, r.currency)}</span></div>` : ''}
        ${orderType === 'delivery' ? html`<div><span>Delivery</span><span>${money(t.fee, r.currency)}</span></div>` : ''}
        ${t.service ? html`<div><span>Service fee</span><span>${money(t.service, r.currency)}</span></div>` : ''}
        <div class="grand"><span>Total</span><span>${money(t.total, r.currency)}</span></div>
      </div>
      ${r.minOrderCents && t.subtotal < r.minOrderCents ? html`<p class="alert warn small">Minimum order is ${money(r.minOrderCents, r.currency)}.</p>` : ''}
      <p class="muted small">The final total is confirmed by our server when you place the order.</p>
      ${!u ? html`<a class="btn block" href="/login.html?next=${encodeURIComponent(location.pathname)}">Sign in to order</a>
          <p class="small muted" style="margin-top:.5rem">No account? <a href="/register.html?next=${encodeURIComponent(location.pathname)}">Register</a></p>`
    : u.role !== 'customer' ? html`<div class="alert info small">You are signed in as ${u.role.replace('_', ' ')}. Use a customer account to place orders.</div>`
      : html`<button class="btn block" data-checkout ${r.acceptingOrders ? '' : raw('disabled')}>Checkout</button>`}`}`);
}

// Dish dialog: choose options (add-ons) and quantity.
function optionsDialog(p) {
  const r = data.restaurant;
  const dlg = document.createElement('dialog');
  dlg.setAttribute('aria-labelledby', 'od-title');
  dlg.innerHTML = html`<h2 id="od-title">${p.name}</h2>${p.description ? html`<p class="muted">${p.description}</p>` : ''}
    <form novalidate><div class="form-alert"></div>
      ${p.optionGroups.map((g) => html`<fieldset class="option-group"><legend>${g.name} <span class="muted small">${g.minSelect ? `choose ${g.minSelect === g.maxSelect ? g.minSelect : `${g.minSelect}-${g.maxSelect}`}` : `optional, up to ${g.maxSelect}`}</span></legend>
        ${g.options.map((o) => html`<div class="check"><input type="${g.maxSelect === 1 ? 'radio' : 'checkbox'}" id="opt-${o.id}" name="g${g.id}" value="${o.id}" ${o.isAvailable ? '' : raw('disabled')}><label for="opt-${o.id}">${o.name} ${o.priceCents ? `(+${money(o.priceCents, r.currency)})` : ''}${o.isAvailable ? '' : ' — sold out'}</label></div>`)}</fieldset>`)}
      <div class="field"><label for="od-qty">Quantity</label><input id="od-qty" name="qty" type="number" min="1" max="50" value="1"></div>
      <div class="actions-row"><button class="btn" type="submit">Add to order</button><button class="btn secondary" type="button" data-close>Cancel</button></div></form>`.s;
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dlg.close(); });
  wireDialog(dlg);
  dlg.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const optionIds = [];
    for (const g of p.optionGroups) {
      const chosen = [...dlg.querySelectorAll(`input[name="g${g.id}"]:checked`)].map((i) => Number(i.value));
      if (chosen.length < g.minSelect || chosen.length > g.maxSelect) {
        dlg.querySelector('.form-alert').innerHTML = `<div class="alert err" role="alert">Please choose ${g.minSelect === g.maxSelect ? g.minSelect : `${g.minSelect}-${g.maxSelect}`} option(s) for "${esc(g.name)}".</div>`;
        return;
      }
      optionIds.push(...chosen);
    }
    addToCart(p.id, optionIds, Math.min(Math.max(parseInt(dlg.querySelector('#od-qty').value, 10) || 1, 1), 50));
    dlg.close();
  });
}

function addToCart(productId, optionIds, quantity) {
  const key = lineKey(productId, optionIds);
  const ex = cart.find((l) => l.key === key);
  if (ex) ex.quantity = Math.min(ex.quantity + quantity, 50);
  else cart.push({ key, productId, optionIds, quantity });
  saveCart();
  draw();
}

function checkoutDialog() {
  const r = data.restaurant;
  const u = session.user;
  const card = !!r.paymentMethods?.card;
  const dlg = document.createElement('dialog');
  dlg.setAttribute('aria-labelledby', 'co-title');
  const idemKey = `ck_${crypto.randomUUID().replace(/-/g, '')}`; // one key per checkout attempt: a double-click can never create two orders
  dlg.innerHTML = html`<h2 id="co-title">Checkout</h2>
    <form id="co" novalidate>
      <div class="form-alert"></div>
      <fieldset class="field" style="border:0;padding:0;margin:0 0 1rem"><legend style="font-weight:600;font-size:.9rem">How would you like it?</legend>
        <div class="check"><input type="radio" id="t-del" name="orderType" value="delivery" ${orderType === 'delivery' ? raw('checked') : ''}><label for="t-del">Delivery (${money(r.deliveryFeeCents, r.currency)})</label></div>
        <div class="check"><input type="radio" id="t-pick" name="orderType" value="pickup" ${orderType === 'pickup' ? raw('checked') : ''}><label for="t-pick">Pickup (free)</label></div></fieldset>
      <div class="row"><div class="field"><label for="co-name">Your name</label><input id="co-name" name="customerName" required value="${u.name}" maxlength="100"></div>
      <div class="field"><label for="co-phone">Phone</label><input id="co-phone" name="customerPhone" type="tel" required value="${u.phone || ''}"></div></div>
      <div class="field" id="addr"><label for="co-addr">Delivery address</label><textarea id="co-addr" name="deliveryAddress" maxlength="300"></textarea></div>
      <div class="field"><label for="co-notes">Notes for the restaurant (optional)</label><input id="co-notes" name="notes" maxlength="500"></div>
      <fieldset class="field" style="border:0;padding:0;margin:0 0 1rem"><legend style="font-weight:600;font-size:.9rem">Payment</legend>
        ${card ? html`<div class="check"><input type="radio" id="p-card" name="paymentMethod" value="card" checked><label for="p-card">Pay online (the secure payment page shows the payment methods enabled for this restaurant)</label></div>` : ''}
        <div class="check"><input type="radio" id="p-cod" name="paymentMethod" value="cod" ${card ? '' : raw('checked')}><label for="p-cod">Cash on delivery / pickup</label></div>
        ${card ? html`<div class="hint small muted">You will be taken to our payment provider's secure page. Your card details never reach this site.</div>` : html`<div class="hint small muted">Online card payment is not available for this restaurant right now.</div>`}</fieldset>
      <div class="actions-row"><button class="btn" type="submit"><span id="co-label">Place order</span> · <span id="co-total"></span></button><button class="btn secondary" type="button" data-close>Cancel</button></div>
    </form>`.s;
  document.body.append(dlg);
  dlg.showModal();
  const sync = () => {
    orderType = dlg.querySelector('input[name=orderType]:checked').value;
    $('#addr', dlg).classList.toggle('hidden', orderType !== 'delivery');
    $('#co-total', dlg).textContent = money(totals().total, r.currency);
    $('#co-label', dlg).textContent = dlg.querySelector('input[name=paymentMethod]:checked')?.value === 'card' ? 'Continue to payment' : 'Place order';
    drawCart();
  };
  dlg.addEventListener('change', sync);
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dlg.close(); });
  wireDialog(dlg);
  sync();
  onSubmit($('#co', dlg), async (d) => {
    const body = {
      items: cart.map((l) => ({ productId: l.productId, quantity: l.quantity, optionIds: l.optionIds })),
      orderType: d.orderType, paymentMethod: d.paymentMethod, customerName: d.customerName, customerPhone: d.customerPhone,
      deliveryAddress: d.deliveryAddress || undefined, notes: d.notes || undefined,
    };
    const { order, paymentUrl } = await api(`/public/restaurants/${encodeURIComponent(slug)}/orders`, { method: 'POST', body, headers: { 'Idempotency-Key': idemKey } });
    cart = []; saveCart();
    dlg.close();
    if (paymentUrl) { // hand over to the provider's hosted payment page
      render($('#root'), html`<div class="card" style="max-width:560px;margin:2rem auto"><h1>Redirecting to secure payment…</h1><p class="muted">If nothing happens, <a href="${paymentUrl}">continue to payment</a>.</p></div>`);
      location.href = paymentUrl;
      return;
    }
    location.href = `/order.html?id=${order.id}`;
  }, { alertBox: $('.form-alert', dlg) });
}

document.addEventListener('click', (e) => {
  if (!data) return;
  const t = e.target.closest('[data-add],[data-inc],[data-dec],[data-rm],[data-checkout]');
  if (!t) return;
  if (t.dataset.checkout !== undefined) { if (cart.length) checkoutDialog(); else toast('Your cart is empty', 'err'); return; }
  if (t.dataset.add) {
    const p = productById(Number(t.dataset.add));
    if (p.optionGroups.length) optionsDialog(p); else addToCart(p.id, [], 1);
    return;
  }
  const line = cart.find((l) => l.key === (t.dataset.inc || t.dataset.dec || t.dataset.rm));
  if (!line) return;
  if (t.dataset.inc) line.quantity = Math.min(line.quantity + 1, 50);
  if (t.dataset.dec) line.quantity -= 1;
  if (t.dataset.rm || line.quantity <= 0) cart = cart.filter((l) => l !== line);
  saveCart();
  const keepY = window.scrollY;
  draw();
  window.scrollTo(0, keepY);
});

init();
