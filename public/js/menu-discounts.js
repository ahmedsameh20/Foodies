// Menu -> Discounts & offers: discount RULES that apply to one or more dishes, a whole category, or the entire menu. Rules are evaluated by the
// server whenever a price is needed (menu, cart, checkout, order snapshot) with one fixed precedence, so this screen only edits the rules:
//   a dish's own discounted price  >  a rule for specific dishes  >  a category rule  >  a menu-wide rule   (no stacking; best price wins within a level)
import {
  api, $, render, html, raw, toCents, fromCents, spinner, emptyState, errorBox, toast, onSubmit, confirmDialog, wireDialog, t, loc, fmtDate,
} from './common.js';
import { icon } from './icons.js';
import { couponsView } from './menu-coupons.js';

const norm = (s) => String(s || '').toLocaleLowerCase().normalize('NFKD').replace(/[ً-ٰٟ]/g, '');
const pad = (n) => String(n).padStart(2, '0');
// ISO instant <-> the value of <input type="datetime-local"> (the owner's local time; the server stores UTC instants)
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const toIso = (v) => (v ? new Date(v).toISOString() : null);

const ruleName = (r) => loc(r) || r.nameEn || r.nameAr;
const valueText = (r, m) => (r.kind === 'percent' ? t('disc.percentOff', { n: r.percent }) : t('disc.amountOff', { amount: m(r.amountCents) }));

// Two kinds of promotion side by side: automatic discounts (applied to dishes by themselves) and coupons (typed in at checkout).
export async function discountRulesView(box, d) {
  const KEY = 'dash.promoTab';
  let tab = 'auto';
  try { tab = sessionStorage.getItem(KEY) === 'coupons' ? 'coupons' : 'auto'; } catch { /* storage blocked */ }
  render(box, html`<div class="actions-row" role="tablist" aria-label="${t('coupon.tabsLabel')}" id="promo-tabs" style="margin-bottom:1rem">
      <button type="button" role="tab" class="btn sm" data-ptab="auto">${t('coupon.tabAuto')}</button>
      <button type="button" role="tab" class="btn sm" data-ptab="coupons">${icon('plus', { size: 14 })} ${t('coupon.tabCoupons')}</button></div><div id="promo-body"></div>`);
  const body = $('#promo-body', box);
  const show = () => {
    for (const b of box.querySelectorAll('[data-ptab]')) { b.classList.toggle('secondary', b.dataset.ptab !== tab); b.setAttribute('aria-selected', String(b.dataset.ptab === tab)); }
    return tab === 'coupons' ? couponsView(body, d) : automaticView(body, d);
  };
  $('#promo-tabs', box).addEventListener('click', (e) => {
    const b = e.target.closest('[data-ptab]');
    if (!b || b.dataset.ptab === tab) return;
    tab = b.dataset.ptab;
    try { sessionStorage.setItem(KEY, tab); } catch { /* storage blocked */ }
    show();
  });
  return show();
}

async function automaticView(box, d) {
  render(box, spinner());
  let rules;
  try { ({ rules } = await api('/manage/discounts')); } catch (e) { return render(box, errorBox(e)); }
  const catName = (id) => { const c = d.categories.find((x) => x.id === id); return c ? loc(c) : '—'; };
  const scopeText = (r) => (r.scope === 'restaurant' ? t('disc.scope.restaurant') : r.scope === 'category' ? t('disc.scopeCategoryName', { name: catName(r.categoryId) }) : t('disc.scopeProducts', { n: r.productIds.length }));
  const when = (r) => (r.startsAt || r.endsAt ? `${r.startsAt ? fmtDate(r.startsAt) : '…'} → ${r.endsAt ? fmtDate(r.endsAt) : '…'}` : t('disc.always'));

  render(box, html`<div class="toolbar"><h3 style="margin:0">${t('disc.rulesTitle')}</h3><button class="btn" data-new-rule>${icon('plus', { size: 16 })} ${t('disc.newRule')}</button></div>
    <p class="muted">${t('disc.rulesIntro')}</p>
    <details class="precedence"><summary>${t('disc.precedenceTitle')}</summary><ol><li>${t('disc.prec1')}</li><li>${t('disc.prec2')}</li><li>${t('disc.prec3')}</li><li>${t('disc.prec4')}</li></ol></details>
    ${rules.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('disc.name')}</th><th>${t('disc.appliesTo')}</th><th>${t('disc.value')}</th><th>${t('disc.schedule')}</th><th>${t('stock.status')}</th><th></th></tr></thead><tbody>
      ${rules.map((r) => html`<tr><td><strong>${ruleName(r)}</strong>${r.usageLimit ? html`<div class="muted small">${t('disc.usage', { used: r.usedCount, max: r.usageLimit })}</div>` : ''}<div class="muted small">${r.maxUsesPerCustomer ? t('disc.perCustomerShort', { n: r.maxUsesPerCustomer }) : t('disc.perCustomerNone')}</div></td>
        <td>${scopeText(r)}<div class="muted small">${t('disc.affects', { n: r.affectedCount, total: r.eligibleCount })}</div></td>
        <td><span class="badge sale">${valueText(r, d.m)}</span></td><td class="small">${when(r)}</td>
        <td><span class="badge ${r.status === 'active' ? 'ok' : r.status === 'scheduled' ? 'info' : 'nocap'}">${t(`disc.status.${r.status}`)}</span></td>
        <td class="right"><button class="btn secondary sm" data-view-rule="${r.id}">${t('disc.viewDishes')}</button> <button class="btn secondary sm" data-edit-rule="${r.id}">${t('common.edit')}</button>
          <button class="btn secondary sm" data-toggle-rule="${r.id}">${r.isActive ? t('disc.deactivate') : t('disc.activate')}</button> <button class="btn danger sm" data-del-rule="${r.id}">${t('common.delete')}</button></td></tr>`)}</tbody></table></div>`
      : emptyState(t('disc.noRules'), t('disc.noRulesText'))}`);

  box.onclick = async (e) => {
    const get = (attr) => rules.find((r) => String(r.id) === e.target.closest(`[${attr}]`)?.getAttribute(attr));
    try {
      if (e.target.closest('[data-new-rule]')) await ruleDialog(null, d);
      else if (get('data-edit-rule')) await ruleDialog(get('data-edit-rule'), d);
      else if (get('data-view-rule')) await affectedDialog(get('data-view-rule'), d);
      else if (get('data-toggle-rule')) { const r = get('data-toggle-rule'); await api(`/manage/discounts/${r.id}`, { method: 'PUT', body: { isActive: !r.isActive } }); toast(t('menu.saved'), 'ok'); d.refresh(); }
      else if (get('data-del-rule')) {
        const r = get('data-del-rule');
        if (await confirmDialog(t('disc.deleteConfirm', { name: ruleName(r) }), { confirmLabel: t('common.delete'), danger: true })) { await api(`/manage/discounts/${r.id}`, { method: 'DELETE' }); toast(t('discount.removed'), 'ok'); d.refresh(); }
      }
    } catch (err) { toast(err, 'err'); }
  };
}

async function affectedDialog(rule, d) {
  const { rule: full } = await api(`/manage/discounts/${rule.id}`);
  await new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'wide';
    dlg.setAttribute('aria-labelledby', 'ad-title');
    dlg.innerHTML = html`<h2 id="ad-title">${ruleName(full)}</h2><p class="muted">${t('disc.affects', { n: full.affectedCount, total: full.eligibleCount })}</p>
      ${full.items.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('menu.dish')}</th><th class="num">${t('disc.before')}</th><th class="num">${t('disc.after')}</th></tr></thead><tbody>
        ${full.items.map((i) => html`<tr><td>${loc(i) || i.name}</td><td class="num"><s>${d.m(i.beforeCents)}</s></td><td class="num"><strong>${d.m(i.afterCents)}</strong></td></tr>`)}</tbody></table></div>` : emptyState(t('disc.noAffected'), t('disc.noAffectedText'))}
      <div class="actions-row"><button class="btn secondary" data-close>${t('common.close')}</button></div>`.s;
    document.body.append(dlg);
    dlg.showModal();
    wireDialog(dlg, resolve);
    dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dlg.close(); });
  });
}

function ruleDialog(rule, d) {
  return new Promise((resolve) => {
    const cur = d.ctx.restaurant.currency;
    const st = { scope: rule?.scope || 'restaurant', kind: rule?.kind || 'percent', picked: new Set(rule?.productIds || []), q: '' };
    const dlg = document.createElement('dialog');
    dlg.className = 'wide';
    dlg.setAttribute('aria-labelledby', 'rd-title');
    const radio = (name, value, label, hint) => html`<div class="check"><input type="radio" id="rd-${name}-${value}" name="${name}" value="${value}"><label for="rd-${name}-${value}">${label}</label></div>${hint ? html`<div class="hint">${hint}</div>` : ''}`;
    dlg.innerHTML = html`<h2 id="rd-title">${rule ? t('disc.editRule') : t('disc.newRule')}</h2>
      <form novalidate><div class="form-alert"></div>
        <div class="lang-pair">
          <div class="field"><label for="rd-name-ar">${t('field.nameAr')} <span class="tag">AR</span></label><input id="rd-name-ar" name="nameAr" data-field="nameAr" dir="rtl" lang="ar" required maxlength="120" value="${rule?.nameAr || ''}"></div>
          <div class="field"><label for="rd-name-en">${t('field.nameEn')} <span class="tag">EN</span></label><input id="rd-name-en" name="nameEn" data-field="nameEn" dir="ltr" lang="en" required maxlength="120" value="${rule?.nameEn || ''}"></div>
          <div class="field"><label for="rd-desc-ar">${t('field.descriptionAr')} <span class="tag">AR</span> <span class="muted small">(${t('gx.optional')})</span></label><textarea id="rd-desc-ar" name="descriptionAr" data-field="descriptionAr" dir="rtl" lang="ar" maxlength="500" rows="2">${rule?.descriptionAr || ''}</textarea></div>
          <div class="field"><label for="rd-desc-en">${t('field.descriptionEn')} <span class="tag">EN</span> <span class="muted small">(${t('gx.optional')})</span></label><textarea id="rd-desc-en" name="descriptionEn" data-field="descriptionEn" dir="ltr" lang="en" maxlength="500" rows="2">${rule?.descriptionEn || ''}</textarea></div>
        </div>
        <fieldset class="field" style="border:0;padding:0;margin:0 0 1rem"><legend style="font-weight:600;font-size:.9rem">${t('disc.scopeLabel')}</legend>
          ${radio('scope', 'product', t('disc.scope.product'))}${radio('scope', 'category', t('disc.scope.category'))}${radio('scope', 'restaurant', t('disc.scope.restaurant'), t('disc.scope.restaurantHint'))}</fieldset>
        <div id="rd-products" class="field" data-field="productIds"><label for="rd-pq">${t('disc.pickDishes')}</label>
          <div class="inline-edit"><input id="rd-pq" type="search" placeholder="${t('menu.searchPlaceholder')}" autocomplete="off"><button type="button" class="btn secondary sm" data-pick-all>${t('disc.selectShown')}</button><button type="button" class="btn secondary sm" data-pick-none>${t('disc.clearSelection')}</button></div>
          <div class="pick-list" role="group" aria-label="${t('disc.pickDishes')}" id="rd-plist"></div><div class="hint" id="rd-pcount"></div></div>
        <div id="rd-category" class="field"><label for="rd-cat">${t('menu.category')}</label><select id="rd-cat" name="categoryId" data-field="categoryId"><option value="">—</option>${d.categories.map((c) => html`<option value="${c.id}" ${rule?.categoryId === c.id ? raw('selected') : ''}>${loc(c)}</option>`)}</select></div>
        <fieldset class="field" style="border:0;padding:0;margin:0 0 1rem"><legend style="font-weight:600;font-size:.9rem">${t('disc.kindLabel')}</legend>
          ${radio('kind', 'percent', t('disc.kind.percent'))}${radio('kind', 'fixed', t('disc.kind.fixed'))}</fieldset>
        <div class="row">
          <div class="field" id="rd-pct"><label for="rd-percent">${t('disc.percent')}</label><input id="rd-percent" name="percent" data-field="percent" inputmode="decimal" autocomplete="off" value="${rule?.kind === 'percent' ? rule.percent : ''}"><div class="hint">${t('disc.percentHint')}</div></div>
          <div class="field" id="rd-amt"><label for="rd-amount">${t('disc.amount')} (${cur})</label><input id="rd-amount" name="amount" data-field="amountCents" inputmode="decimal" autocomplete="off" value="${rule?.kind === 'fixed' ? fromCents(rule.amountCents) : ''}"><div class="hint">${t('disc.amountHint')}</div></div>
        </div>
        <fieldset class="discount-limits"><legend>${t('disc.limitsTitle')}</legend>
          <div class="row">
            <div class="field"><label for="rd-limit">${t('disc.usageLimit')}</label><input id="rd-limit" name="usageLimit" data-field="usageLimit" type="number" min="1" inputmode="numeric" value="${rule?.usageLimit ?? ''}" aria-describedby="rd-limit-hint"><div class="hint" id="rd-limit-hint">${t('disc.usageLimitHint')}</div></div>
            <div class="field"><label for="rd-percust">${t('disc.perCustomer')}</label><input id="rd-percust" name="maxUsesPerCustomer" data-field="maxUsesPerCustomer" type="number" min="1" inputmode="numeric" value="${rule ? (rule.maxUsesPerCustomer ?? '') : 1}" aria-describedby="rd-percust-hint"><div class="hint" id="rd-percust-hint">${t('disc.perCustomerHint')}</div></div>
          </div></fieldset>
        <div class="row">
          <div class="field"><label for="rd-start">${t('disc.starts')}</label><input id="rd-start" name="startsAt" data-field="startsAt" type="datetime-local" dir="ltr" value="${toLocalInput(rule?.startsAt)}"></div>
          <div class="field"><label for="rd-end">${t('disc.ends')}</label><input id="rd-end" name="endsAt" data-field="endsAt" type="datetime-local" dir="ltr" value="${toLocalInput(rule?.endsAt)}"></div>
        </div>
        <label class="check"><input type="checkbox" name="isActive" ${!rule || rule.isActive ? raw('checked') : ''}><span>${t('disc.activeLabel')}</span></label>
        <div class="alert info small" id="rd-summary" role="status" aria-live="polite" style="margin-top:1rem"></div>
        <div class="actions-row"><button class="btn" type="submit">${t('common.save')}</button><button class="btn secondary" type="button" data-close>${t('common.cancel')}</button></div></form>`.s;
    document.body.append(dlg);
    dlg.showModal();
    wireDialog(dlg, resolve);
    const form = $('form', dlg);
    form.elements.scope.value = st.scope;
    form.elements.kind.value = st.kind;

    const shown = () => d.products.filter((p) => !st.q || norm(st.q).split(/\s+/).every((w) => norm(`${p.name} ${p.nameAr} ${p.nameEn}`).includes(w)));
    const drawList = () => {
      render($('#rd-plist', dlg), html`${shown().map((p) => html`<label class="check"><input type="checkbox" data-pick="${p.id}" ${st.picked.has(p.id) ? raw('checked') : ''}><span>${loc(p)} <span class="muted small">${d.m(p.originalPriceCents)}</span></span></label>`)}`);
    };
    // what the rule would do, from the dishes the dashboard already has (the server decides the real prices and re-validates everything)
    const summarise = () => {
      const kind = form.elements.kind.value;
      const val = kind === 'percent' ? Number(String(form.elements.percent.value).replace(',', '.')) : toCents(form.elements.amount.value);
      const pool = st.scope === 'restaurant' ? d.products : st.scope === 'category' ? d.products.filter((p) => String(p.categoryId) === form.elements.categoryId.value) : d.products.filter((p) => st.picked.has(p.id));
      const after = (p) => {
        const base = p.originalPriceCents;
        const off = kind === 'percent' ? Math.round((base * Math.round(val * 100)) / 10000) : val;
        return Number.isFinite(off) && off > 0 && base - off > 0 ? base - off : null;
      };
      const eligible = pool.filter((p) => !p.hasDiscount && after(p) !== null);
      const sample = eligible[0];
      $('#rd-summary', dlg).textContent = !pool.length ? t('disc.summaryNone')
        : t('disc.summary', { n: eligible.length, total: pool.length }) + (sample ? ` ${t('disc.summarySample', { name: loc(sample), before: d.m(sample.originalPriceCents), after: d.m(after(sample)) })}` : '');
      $('#rd-pcount', dlg).textContent = t('disc.selectedCount', { n: st.picked.size });
    };
    const sync = () => {
      st.scope = form.elements.scope.value; st.kind = form.elements.kind.value;
      $('#rd-products', dlg).hidden = st.scope !== 'product';
      $('#rd-category', dlg).hidden = st.scope !== 'category';
      $('#rd-pct', dlg).hidden = st.kind !== 'percent';
      $('#rd-amt', dlg).hidden = st.kind !== 'fixed';
      summarise();
    };
    drawList(); sync();
    dlg.addEventListener('input', (e) => { if (e.target.id === 'rd-pq') { st.q = e.target.value; drawList(); } summarise(); });
    dlg.addEventListener('change', (e) => {
      const pick = e.target.closest('[data-pick]');
      if (pick) { const id = Number(pick.dataset.pick); if (pick.checked) st.picked.add(id); else st.picked.delete(id); }
      sync();
    });
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) dlg.close();
      if (e.target.closest('[data-pick-all]')) { shown().forEach((p) => st.picked.add(p.id)); drawList(); summarise(); }
      if (e.target.closest('[data-pick-none]')) { st.picked.clear(); drawList(); summarise(); }
    });
    onSubmit(form, async (v) => {
      const fail = (field, reason) => Object.assign(new Error(reason), { code: 'validation_error', details: { field, reason } });
      const body = {
        nameAr: v.nameAr, nameEn: v.nameEn, descriptionAr: v.descriptionAr || null, descriptionEn: v.descriptionEn || null,
        scope: st.scope, kind: st.kind, isActive: v.isActive,
        usageLimit: v.usageLimit === '' ? null : Number(v.usageLimit), maxUsesPerCustomer: v.maxUsesPerCustomer === '' ? null : Number(v.maxUsesPerCustomer), startsAt: toIso(v.startsAt), endsAt: toIso(v.endsAt),
      };
      if (st.kind === 'percent') body.percent = String(v.percent).trim() === '' ? undefined : Number(String(v.percent).replace(',', '.'));
      else { const c = toCents(v.amount); if (Number.isNaN(c)) throw fail('amountCents', 'invalid_money'); body.amountCents = c; }
      if (st.scope === 'product') body.productIds = [...st.picked];
      if (st.scope === 'category') body.categoryId = v.categoryId ? Number(v.categoryId) : undefined;
      await api(rule ? `/manage/discounts/${rule.id}` : '/manage/discounts', { method: rule ? 'PUT' : 'POST', body });
      toast(t('menu.saved'), 'ok');
      dlg.close(); d.refresh();
    }, { alertBox: $('.form-alert', dlg) });
  });
}
