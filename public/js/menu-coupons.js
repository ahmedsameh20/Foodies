// Menu -> Discounts & offers -> Coupons: codes the customer types at checkout. The server validates and prices every coupon (services/coupons.js);
// this screen creates / edits them and shows how they perform (redemptions, unique customers, discount granted, history).
import {
  api, $, render, html, raw, toCents, fromCents, spinner, emptyState, errorBox, toast, onSubmit, confirmDialog, wireDialog, t, loc, fmtDate,
} from './common.js';
import { icon } from './icons.js';

const norm = (s) => String(s || '').toLocaleLowerCase().normalize('NFKD').replace(/[ً-ٰٟ]/g, '');
const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const toIso = (v) => (v ? new Date(v).toISOString() : null);
const name = (c) => loc(c) || c.nameEn || c.nameAr;
const STATUS_BADGE = { active: 'ok', scheduled: 'info', expired: 'nocap', disabled: 'nocap', fully_redeemed: 'warn' };

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* clipboard unavailable */ }
    ta.remove();
  }
  toast(t('coupon.copied'), 'ok');
}

export async function couponsView(box, d) {
  render(box, spinner());
  let list;
  try { ({ coupons: list } = await api('/manage/coupons')); } catch (e) { return render(box, errorBox(e)); }
  const catName = (id) => { const c = d.categories.find((x) => x.id === id); return c ? loc(c) : '—'; };
  const scopeText = (c) => (c.scope === 'order' ? t('coupon.scope.order') : c.scope === 'menu' ? t('coupon.scope.menu')
    : c.scope === 'category' ? t('coupon.scopeCategoryName', { name: catName(c.categoryId) }) : t('coupon.scopeProducts', { n: c.productIds.length }));
  const valueText = (c) => (c.kind === 'percent' ? t('disc.percentOff', { n: c.percent }) : t('disc.amountOff', { amount: d.m(c.amountCents) }));
  const when = (c) => (c.startsAt || c.endsAt ? `${c.startsAt ? fmtDate(c.startsAt) : '…'} → ${c.endsAt ? fmtDate(c.endsAt) : '…'}` : t('disc.always'));

  render(box, html`<div class="toolbar"><h3 style="margin:0">${t('coupon.title')}</h3><button class="btn" data-new-coupon>${icon('plus', { size: 16 })} ${t('coupon.create')}</button></div>
    <p class="muted">${t('coupon.intro')}</p>
    <details class="precedence"><summary>${t('coupon.precedenceTitle')}</summary><ol><li>${t('coupon.prec1')}</li><li>${t('coupon.prec2')}</li><li>${t('coupon.prec3')}</li></ol></details>
    ${list.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('coupon.code')}</th><th>${t('coupon.discount')}</th><th>${t('disc.appliesTo')}</th><th>${t('disc.schedule')}</th><th>${t('coupon.usage')}</th><th>${t('coupon.perCustomerCol')}</th><th>${t('stock.status')}</th><th></th></tr></thead><tbody>
      ${list.map((c) => html`<tr><td><code dir="ltr" class="coupon-code">${c.code}</code> <button class="link small" data-copy="${c.code}" aria-label="${t('coupon.copy')}">${icon('copy', { size: 14 })}</button><div class="muted small">${name(c)}</div></td>
        <td><span class="badge sale">${valueText(c)}</span>${c.maxDiscountCents ? html`<div class="muted small">${t('coupon.upTo', { amount: d.m(c.maxDiscountCents) })}</div>` : ''}${c.minSubtotalCents ? html`<div class="muted small">${t('coupon.minOrder', { amount: d.m(c.minSubtotalCents) })}</div>` : ''}</td>
        <td>${scopeText(c)}</td><td class="small">${when(c)}</td>
        <td>${c.redemptions}${c.usageLimit ? ` / ${c.usageLimit}` : ` / ${t('menu.unlimited')}`}</td>
        <td>${c.maxUsesPerCustomer ?? t('menu.unlimited')}</td>
        <td><span class="badge ${STATUS_BADGE[c.status]}">${t(`coupon.status.${c.status}`)}</span></td>
        <td class="right"><button class="btn secondary sm" data-view-coupon="${c.id}">${t('coupon.view')}</button> <button class="btn secondary sm" data-edit-coupon="${c.id}">${t('common.edit')}</button>
          <button class="btn secondary sm" data-toggle-coupon="${c.id}">${c.isActive ? t('disc.deactivate') : t('disc.activate')}</button>
          ${c.redemptions ? '' : html`<button class="btn danger sm" data-del-coupon="${c.id}">${t('common.delete')}</button>`}</td></tr>`)}</tbody></table></div>`
      : emptyState(t('coupon.none'), t('coupon.noneText'))}`);

  box.onclick = async (e) => {
    const get = (attr) => list.find((c) => String(c.id) === e.target.closest(`[${attr}]`)?.getAttribute(attr));
    try {
      if (e.target.closest('[data-new-coupon]')) await couponDialog(null, d);
      else if (e.target.closest('[data-copy]')) await copyText(e.target.closest('[data-copy]').dataset.copy);
      else if (get('data-edit-coupon')) await couponDialog(get('data-edit-coupon'), d);
      else if (get('data-view-coupon')) await detailDialog(get('data-view-coupon'), d);
      else if (get('data-toggle-coupon')) { const c = get('data-toggle-coupon'); await api(`/manage/coupons/${c.id}`, { method: 'PUT', body: { isActive: !c.isActive } }); toast(t('menu.saved'), 'ok'); d.refresh(); }
      else if (get('data-del-coupon')) {
        const c = get('data-del-coupon');
        if (await confirmDialog(t('coupon.deleteConfirm', { code: c.code }), { confirmLabel: t('common.delete'), danger: true })) { await api(`/manage/coupons/${c.id}`, { method: 'DELETE' }); toast(t('discount.removed'), 'ok'); d.refresh(); }
      }
    } catch (err) { toast(err, 'err'); }
  };
}

async function detailDialog(coupon, d) {
  const { coupon: c, redemptions } = await api(`/manage/coupons/${coupon.id}`);
  await new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'wide';
    dlg.setAttribute('aria-labelledby', 'cv-title');
    dlg.innerHTML = html`<h2 id="cv-title"><code dir="ltr">${c.code}</code> <span class="badge ${STATUS_BADGE[c.status]}">${t(`coupon.status.${c.status}`)}</span></h2>
      <p class="muted">${name(c)}</p>
      <div class="grid cols-4">
        <div class="card stat"><div class="label">${t('coupon.stat.redemptions')}</div><div class="value">${c.redemptions}</div></div>
        <div class="card stat"><div class="label">${t('coupon.stat.remaining')}</div><div class="value">${c.remaining ?? t('menu.unlimited')}</div></div>
        <div class="card stat"><div class="label">${t('coupon.stat.customers')}</div><div class="value">${c.uniqueCustomers}</div></div>
        <div class="card stat"><div class="label">${t('coupon.stat.granted')}</div><div class="value">${d.m(c.totalDiscountCents)}</div></div></div>
      <h3>${t('coupon.history')}</h3>
      ${redemptions.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('coupon.order')}</th><th>${t('coupon.customer')}</th><th class="num">${t('coupon.discount')}</th><th class="num">${t('cart.total')}</th><th>${t('stock.status')}</th><th>${t('coupon.date')}</th></tr></thead><tbody>
        ${redemptions.map((r) => html`<tr><td>#${r.orderNumber}</td><td>${r.customerName}</td><td class="num">${d.m(r.discountCents)}</td><td class="num">${d.m(r.orderTotalCents)}</td><td><span class="badge nocap">${t(`coupon.redemption.${r.status}`)}</span></td><td class="small">${fmtDate(r.createdAt)}</td></tr>`)}</tbody></table></div>`
        : emptyState(t('coupon.noHistory'))}
      <div class="actions-row"><button class="btn secondary" data-close>${t('common.close')}</button></div>`.s;
    document.body.append(dlg);
    dlg.showModal();
    wireDialog(dlg, resolve);
    dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dlg.close(); });
  });
}

function couponDialog(coupon, d) {
  return new Promise((resolve) => {
    const cur = d.ctx.restaurant.currency;
    const st = { scope: coupon?.scope || 'order', kind: coupon?.kind || 'percent', picked: new Set(coupon?.productIds || []), q: '' };
    const dlg = document.createElement('dialog');
    dlg.className = 'wide';
    dlg.setAttribute('aria-labelledby', 'cp-title');
    const radio = (nm, value, label) => html`<div class="check"><input type="radio" id="cp-${nm}-${value}" name="${nm}" value="${value}"><label for="cp-${nm}-${value}">${label}</label></div>`;
    const money = (cents) => (cents ? fromCents(cents) : '');
    dlg.innerHTML = html`<h2 id="cp-title">${coupon ? t('coupon.edit') : t('coupon.create')}</h2>
      <form novalidate><div class="form-alert"></div>
        <div class="lang-pair">
          <div class="field"><label for="cp-name-ar">${t('field.nameAr')} <span class="tag">AR</span></label><input id="cp-name-ar" name="nameAr" data-field="nameAr" dir="rtl" lang="ar" required maxlength="120" value="${coupon?.nameAr || ''}"></div>
          <div class="field"><label for="cp-name-en">${t('field.nameEn')} <span class="tag">EN</span></label><input id="cp-name-en" name="nameEn" data-field="nameEn" dir="ltr" lang="en" required maxlength="120" value="${coupon?.nameEn || ''}"></div>
          <div class="field"><label for="cp-desc-ar">${t('field.descriptionAr')} <span class="tag">AR</span> <span class="muted small">(${t('gx.optional')})</span></label><textarea id="cp-desc-ar" name="descriptionAr" data-field="descriptionAr" dir="rtl" lang="ar" maxlength="500" rows="2">${coupon?.descriptionAr || ''}</textarea></div>
          <div class="field"><label for="cp-desc-en">${t('field.descriptionEn')} <span class="tag">EN</span> <span class="muted small">(${t('gx.optional')})</span></label><textarea id="cp-desc-en" name="descriptionEn" data-field="descriptionEn" dir="ltr" lang="en" maxlength="500" rows="2">${coupon?.descriptionEn || ''}</textarea></div>
        </div>
        <div class="field"><label for="cp-code">${t('coupon.code')}</label>
          <div class="inline-edit"><input id="cp-code" name="code" data-field="code" dir="ltr" required maxlength="32" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${coupon?.code || ''}" aria-describedby="cp-code-hint"><button type="button" class="btn secondary sm" data-generate>${t('coupon.generate')}</button></div>
          <div class="hint" id="cp-code-hint">${t('coupon.codeHint')}</div></div>
        <fieldset class="field" style="border:0;padding:0;margin:0 0 1rem"><legend style="font-weight:600;font-size:.9rem">${t('disc.kindLabel')}</legend>${radio('kind', 'percent', t('disc.kind.percent'))}${radio('kind', 'fixed', t('disc.kind.fixed'))}</fieldset>
        <div class="row">
          <div class="field" id="cp-pct"><label for="cp-percent">${t('disc.percent')}</label><input id="cp-percent" name="percent" data-field="percent" inputmode="decimal" autocomplete="off" value="${coupon?.kind === 'percent' ? coupon.percent : ''}"><div class="hint">${t('disc.percentHint')}</div></div>
          <div class="field" id="cp-amt"><label for="cp-amount">${t('disc.amount')} (${cur})</label><input id="cp-amount" name="amount" data-field="amountCents" inputmode="decimal" autocomplete="off" value="${coupon?.kind === 'fixed' ? fromCents(coupon.amountCents) : ''}"><div class="hint">${t('disc.amountHint')}</div></div>
          <div class="field" id="cp-max"><label for="cp-maxd">${t('coupon.maxDiscount')} (${cur})</label><input id="cp-maxd" name="maxDiscount" data-field="maxDiscountCents" inputmode="decimal" autocomplete="off" value="${money(coupon?.maxDiscountCents)}"><div class="hint">${t('coupon.maxDiscountHint')}</div></div>
          <div class="field"><label for="cp-min">${t('coupon.minSubtotal')} (${cur})</label><input id="cp-min" name="minSubtotal" data-field="minSubtotalCents" inputmode="decimal" autocomplete="off" value="${money(coupon?.minSubtotalCents)}"><div class="hint">${t('coupon.minSubtotalHint')}</div></div>
        </div>
        <fieldset class="field" style="border:0;padding:0;margin:0 0 1rem"><legend style="font-weight:600;font-size:.9rem">${t('coupon.scopeLabel')}</legend>
          ${radio('scope', 'order', t('coupon.scope.order'))}${radio('scope', 'menu', t('coupon.scope.menu'))}${radio('scope', 'category', t('coupon.scope.category'))}${radio('scope', 'product', t('coupon.scope.product'))}</fieldset>
        <div id="cp-category" class="field"><label for="cp-cat">${t('menu.category')}</label><select id="cp-cat" name="categoryId" data-field="categoryId"><option value="">—</option>${d.categories.map((c) => html`<option value="${c.id}" ${coupon?.categoryId === c.id ? raw('selected') : ''}>${loc(c)}</option>`)}</select></div>
        <div id="cp-products" class="field" data-field="productIds"><label for="cp-pq">${t('disc.pickDishes')}</label>
          <div class="inline-edit"><input id="cp-pq" type="search" placeholder="${t('menu.searchPlaceholder')}" autocomplete="off"><button type="button" class="btn secondary sm" data-pick-all>${t('disc.selectShown')}</button><button type="button" class="btn secondary sm" data-pick-none>${t('disc.clearSelection')}</button></div>
          <div class="pick-list" role="group" aria-label="${t('disc.pickDishes')}" id="cp-plist"></div><div class="hint" id="cp-pcount"></div></div>
        <div class="row">
          <div class="field"><label for="cp-start">${t('disc.starts')}</label><input id="cp-start" name="startsAt" data-field="startsAt" type="datetime-local" dir="ltr" value="${toLocalInput(coupon?.startsAt)}"></div>
          <div class="field"><label for="cp-end">${t('disc.ends')}</label><input id="cp-end" name="endsAt" data-field="endsAt" type="datetime-local" dir="ltr" value="${toLocalInput(coupon?.endsAt)}"></div>
        </div>
        <fieldset class="discount-limits"><legend>${t('disc.limitsTitle')}</legend>
          <div class="row">
            <div class="field"><label for="cp-limit">${t('disc.usageLimit')}</label><input id="cp-limit" name="usageLimit" data-field="usageLimit" type="number" min="1" inputmode="numeric" value="${coupon?.usageLimit ?? ''}" aria-describedby="cp-limit-hint"><div class="hint" id="cp-limit-hint">${t('coupon.usageLimitHint')}</div></div>
            <div class="field"><label for="cp-percust">${t('disc.perCustomer')}</label><input id="cp-percust" name="maxUsesPerCustomer" data-field="maxUsesPerCustomer" type="number" min="1" inputmode="numeric" value="${coupon ? (coupon.maxUsesPerCustomer ?? '') : 1}" aria-describedby="cp-percust-hint"><div class="hint" id="cp-percust-hint">${t('disc.perCustomerHint')}</div></div>
          </div></fieldset>
        <label class="check"><input type="checkbox" name="allowStacking" ${coupon?.allowStacking ? raw('checked') : ''}><span>${t('coupon.stacking')}</span></label><div class="hint">${t('coupon.stackingHint')}</div>
        <label class="check"><input type="checkbox" name="isActive" ${!coupon || coupon.isActive ? raw('checked') : ''}><span>${t('disc.activeLabel')}</span></label>
        <div class="actions-row"><button class="btn" type="submit">${t('common.save')}</button><button class="btn secondary" type="button" data-close>${t('common.cancel')}</button></div></form>`.s;
    document.body.append(dlg);
    dlg.showModal();
    wireDialog(dlg, resolve);
    const form = $('form', dlg);
    form.elements.scope.value = st.scope;
    form.elements.kind.value = st.kind;

    const shown = () => d.products.filter((p) => !st.q || norm(st.q).split(/\s+/).every((w) => norm(`${p.name} ${p.nameAr} ${p.nameEn}`).includes(w)));
    const drawList = () => render($('#cp-plist', dlg), html`${shown().map((p) => html`<label class="check"><input type="checkbox" data-pick="${p.id}" ${st.picked.has(p.id) ? raw('checked') : ''}><span>${loc(p)} <span class="muted small">${d.m(p.originalPriceCents)}</span></span></label>`)}`);
    const sync = () => {
      st.scope = form.elements.scope.value; st.kind = form.elements.kind.value;
      $('#cp-products', dlg).hidden = st.scope !== 'product';
      $('#cp-category', dlg).hidden = st.scope !== 'category';
      $('#cp-pct', dlg).hidden = st.kind !== 'percent';
      $('#cp-max', dlg).hidden = st.kind !== 'percent';
      $('#cp-amt', dlg).hidden = st.kind !== 'fixed';
      $('#cp-pcount', dlg).textContent = t('disc.selectedCount', { n: st.picked.size });
    };
    drawList(); sync();
    dlg.addEventListener('input', (e) => { if (e.target.id === 'cp-pq') { st.q = e.target.value; drawList(); } });
    dlg.addEventListener('change', (e) => {
      const pick = e.target.closest('[data-pick]');
      if (pick) { const id = Number(pick.dataset.pick); if (pick.checked) st.picked.add(id); else st.picked.delete(id); }
      sync();
    });
    dlg.addEventListener('click', async (e) => {
      if (e.target.closest('[data-close]')) dlg.close();
      if (e.target.closest('[data-pick-all]')) { shown().forEach((p) => st.picked.add(p.id)); drawList(); sync(); }
      if (e.target.closest('[data-pick-none]')) { st.picked.clear(); drawList(); sync(); }
      if (e.target.closest('[data-generate]')) {
        try { form.elements.code.value = (await api('/manage/coupons/generate-code')).code; } catch (err) { toast(err, 'err'); }
      }
    });
    onSubmit(form, async (v) => {
      const fail = (field, reason) => Object.assign(new Error(reason), { code: 'validation_error', details: { field, reason } });
      const cents = (raw, field) => { if (String(raw).trim() === '') return null; const c = toCents(raw); if (Number.isNaN(c)) throw fail(field, 'invalid_money'); return c; };
      const body = {
        nameAr: v.nameAr, nameEn: v.nameEn, descriptionAr: v.descriptionAr || null, descriptionEn: v.descriptionEn || null, code: v.code,
        scope: st.scope, kind: st.kind, isActive: v.isActive, allowStacking: v.allowStacking,
        usageLimit: v.usageLimit === '' ? null : Number(v.usageLimit), maxUsesPerCustomer: v.maxUsesPerCustomer === '' ? null : Number(v.maxUsesPerCustomer),
        minSubtotalCents: cents(v.minSubtotal, 'minSubtotalCents') ?? 0, startsAt: toIso(v.startsAt), endsAt: toIso(v.endsAt),
      };
      if (st.kind === 'percent') {
        body.percent = String(v.percent).trim() === '' ? undefined : Number(String(v.percent).replace(',', '.'));
        body.maxDiscountCents = cents(v.maxDiscount, 'maxDiscountCents');
      } else { body.amountCents = cents(v.amount, 'amountCents'); if (body.amountCents === null) delete body.amountCents; }
      if (st.scope === 'product') body.productIds = [...st.picked];
      if (st.scope === 'category') body.categoryId = v.categoryId ? Number(v.categoryId) : undefined;
      await api(coupon ? `/manage/coupons/${coupon.id}` : '/manage/coupons', { method: coupon ? 'PUT' : 'POST', body });
      toast(t('menu.saved'), 'ok');
      dlg.close(); d.refresh();
    }, { alertBox: $('.form-alert', dlg) });
  });
}
