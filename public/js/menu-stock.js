// Menu -> Availability & stock for restaurants WITH branches: one branch is selected at a time and every quantity on the page belongs to
// that branch. A searchable branch picker (not a long list) scales to 15+ branches and shows each branch's out / low counts.
// Restaurants without branches keep the original single table (menu-manager.js).
import {
  api, $, render, html, raw, spinner, errorBox, emptyState, toast, confirmDialog, t, loc,
} from './common.js';
import { icon } from './icons.js';

const KEY = 'dash.stockBranch';
const norm = (s) => String(s || '').toLocaleLowerCase().normalize('NFKD').replace(/[ً-ٰٟ]/g, '');
const urlKind = (k) => (k === 'extra' ? 'extras' : 'dishes');

const stateBadge = (it) => {
  if (!it.trackStock) return html`<span class="badge nocap">${t('stock.unlimited')}</span>`;
  if (it.state === 'out') return html`<span class="badge stock-out">${t('stock.out')}</span>`;
  if (it.state === 'low') return html`<span class="badge stock-low">${t('stock.lowCount', { n: it.quantity })}</span>`;
  return html`<span class="badge stock-ok">${t('stock.inStock', { n: it.quantity })}</span>`;
};
const branchName = (b) => loc(b) || b.name;

export async function branchStockView(box, d, summaries) {
  let branches = summaries.branches.filter((b) => b.isActive);
  let legacy = summaries.legacy;
  let branchId = null;
  try { branchId = Number(sessionStorage.getItem(KEY)); } catch { /* storage blocked */ }
  if (!branches.some((b) => b.id === branchId)) branchId = branches[0].id;
  const f = { q: '', status: '', kind: '' };
  let items = [];
  let summary = { tracked: 0, out: 0, low: 0, ok: 0 };
  let panelOpen = false;
  let bq = '';

  const current = () => branches.find((b) => b.id === branchId);

  function pickerHtml() {
    const list = branches.filter((b) => !bq || norm(`${b.name} ${b.nameAr} ${b.nameEn} ${b.address}`).includes(norm(bq)));
    return html`<div class="branch-picker">
      <span class="label-text" id="bp-label">${t('stock.branch')}</span>
      <button type="button" class="branch-current" aria-haspopup="listbox" aria-expanded="${panelOpen}" aria-controls="bp-panel" aria-labelledby="bp-label bp-cur" data-bp-toggle>
        <span id="bp-cur"><strong>${branchName(current())}</strong>${current().address ? html`<span class="muted small"> · ${current().address}</span>` : ''}</span>
        <span class="side-chev">${icon('chevron', { size: 16 })}</span></button>
      <div class="branch-panel" id="bp-panel" ${panelOpen ? '' : raw('hidden')}>
        ${branches.length > 6 ? html`<input type="search" data-bp-q value="${bq}" placeholder="${t('stock.searchBranches')}" aria-label="${t('stock.searchBranches')}" autocomplete="off">` : ''}
        <ul role="listbox" aria-labelledby="bp-label">${list.length ? list.map((b) => html`<li role="option" tabindex="0" aria-selected="${b.id === branchId}" data-bp-id="${b.id}">
          <span><strong>${branchName(b)}</strong>${b.address ? html`<span class="muted small"> · ${b.address}</span>` : ''}</span>
          <span class="bp-badges">${b.out ? html`<span class="badge stock-out">${t('stock.nOut', { n: b.out })}</span>` : ''}${b.low ? html`<span class="badge stock-low">${t('stock.nLow', { n: b.low })}</span>` : ''}</span></li>`)
          : html`<li class="muted" aria-disabled="true">${t('stock.noBranchMatch')}</li>`}</ul></div></div>`;
  }

  const pass = (it) => (!f.q || norm(f.q).split(/\s+/).every((w) => norm(`${it.name} ${it.nameAr} ${it.nameEn}`).includes(w)))
    && (!f.kind || it.kind === f.kind)
    && (!f.status || ({
      available: it.itemAvailable && it.branchAvailable && it.state !== 'out', low: it.state === 'low', out: it.state === 'out', unlimited: !it.trackStock, off: !it.branchAvailable || !it.itemAvailable,
    })[f.status]);

  function rowHtml(it) {
    const id = `${it.kind}:${it.id}`;
    const nm = loc(it) || it.name;
    return html`<tr data-row="${id}"><td><strong>${nm}</strong></td><td><span class="badge nocap">${it.kind === 'extra' ? t('stock.kindExtra') : t('stock.kindDish')}</span></td>
      <td><label class="check"><input type="checkbox" data-s-avail="${id}" ${it.branchAvailable ? raw('checked') : ''} ${it.itemAvailable ? '' : raw('disabled')}><span class="sr-only">${nm} — ${t('stock.availableHere')}</span></label></td>
      <td><label class="check"><input type="checkbox" data-s-track="${id}" ${it.trackStock ? raw('checked') : ''}><span class="sr-only">${nm} — ${t('stock.track')}</span></label></td>
      <td>${it.trackStock ? html`<div class="inline-edit"><input type="number" min="0" max="1000000" inputmode="numeric" data-s-qty="${id}" value="${it.quantity}" aria-label="${t('stock.quantity')} — ${nm}"><button class="btn secondary sm" data-s-set="${id}">${t('common.save')}</button></div>` : html`<span class="muted small">${t('stock.unlimited')}</span>`}</td>
      <td>${it.trackStock ? html`<div class="inline-edit"><input type="number" min="1" max="100000" inputmode="numeric" data-s-addq="${id}" placeholder="+10" aria-label="${t('stock.restock')} — ${nm}"><button class="btn sm" data-s-add="${id}">${t('stock.add')}</button></div>` : ''}</td>
      <td>${it.trackStock ? html`<div class="inline-edit"><input type="number" min="0" max="1000000" inputmode="numeric" data-s-lowq="${id}" value="${it.lowStockThreshold ?? ''}" placeholder="${it.lowLimit}" aria-label="${t('stock.lowAt')} — ${nm}"><button class="btn secondary sm" data-s-low="${id}">${t('common.save')}</button></div>` : ''}</td>
      <td>${stateBadge(it)}${!it.itemAvailable ? html` <span class="badge stock-out">${t('dish.soldOut')}</span>` : !it.branchAvailable ? html` <span class="badge stock-out">${t('stock.offHere')}</span>` : ''}</td></tr>`;
  }

  function drawTable() {
    const list = items.filter(pass);
    render($('#stock-rows', box), list.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('menu.dish')}</th><th>${t('stock.type')}</th><th>${t('stock.availableHere')}</th><th>${t('stock.track')}</th><th>${t('stock.quantity')}</th><th>${t('stock.restock')}</th><th>${t('stock.lowAt')}</th><th>${t('stock.status')}</th></tr></thead><tbody>${list.map(rowHtml)}</tbody></table></div>`
      : items.length ? emptyState(t('menu.noMatch'), t('menu.noMatchText')) : emptyState(t('menu.emptyTitle'), t('menu.emptyOwner')));
  }

  function drawChips() {
    const chip = (key, label, n, cls = '') => html`<button type="button" class="chip ${cls}" data-s-chip="${key}" aria-pressed="${f.status === key}">${label} <span class="count">${n}</span></button>`;
    render($('#stock-chips', box), html`${chip('', t('stock.chipAll'), items.length)}${chip('available', t('stock.chipAvailable'), summary.ok + summary.low + items.filter((i) => !i.trackStock).length)}${chip('low', t('stock.chipLow'), summary.low)}${chip('out', t('stock.chipOut'), summary.out)}`);
  }

  function drawLegacy() {
    const n = legacy.unassignedDishes + legacy.unassignedExtras;
    render($('#stock-legacy', box), n && legacy.ambiguous ? html`<div class="alert warn" role="status"><strong>${t('stock.legacyTitle')}</strong> ${t('stock.legacyText', { n })}
      ${d.owner ? html`<div class="actions-row" style="margin-top:.5rem"><button class="btn sm" data-adopt>${t('stock.legacyAssign', { branch: branchName(current()) })}</button></div>` : ''}</div>` : '');
  }

  function drawShell() {
    render(box, html`<div class="toolbar"><h2>${t('menu.nav.stock')}</h2></div>
      <p class="muted">${t('stock.introBranch')}</p>
      <div id="stock-picker"></div><div id="stock-legacy"></div>
      <div class="card branch-summary" id="stock-head" aria-live="polite"></div>
      <div class="menu-toolbar" role="search">
        <div class="field"><label for="sq">${t('menu.search')}</label><input id="sq" type="search" value="${f.q}" placeholder="${t('menu.searchPlaceholder')}" autocomplete="off"></div>
        <div class="field"><label for="skind">${t('stock.type')}</label><select id="skind"><option value="">${t('stock.kindAll')}</option><option value="dish" ${f.kind === 'dish' ? raw('selected') : ''}>${t('stock.kindDish')}</option><option value="extra" ${f.kind === 'extra' ? raw('selected') : ''}>${t('stock.kindExtra')}</option></select></div>
        <div class="field"><label for="sstatus">${t('menu.show')}</label><select id="sstatus">${['', 'available', 'low', 'out', 'unlimited', 'off'].map((s) => html`<option value="${s}" ${s === f.status ? raw('selected') : ''}>${t(`stock.filter.${s || 'all'}`)}</option>`)}</select></div>
      </div>
      <div id="stock-chips" class="chips" role="group" aria-label="${t('stock.chipsLabel')}"></div>
      <div id="stock-rows"></div>`);
    drawAll();
  }
  function drawAll() {
    render($('#stock-picker', box), pickerHtml());
    render($('#stock-head', box), html`<h3 style="margin:0">${t('stock.showing', { branch: branchName(current()) })}</h3>
      <p class="muted small" style="margin:.25rem 0 0">${t('stock.summaryLine', { tracked: summary.tracked, ok: summary.ok, low: summary.low, out: summary.out })}</p>`);
    drawChips(); drawLegacy(); drawTable();
  }

  async function load() {
    try {
      const [s, sums] = await Promise.all([api(`/manage/stock?branchId=${branchId}`), api('/manage/stock/branches')]);
      items = s.items; summary = s.summary; legacy = sums.legacy;
      branches = sums.branches.filter((b) => b.isActive);
      drawAll();
    } catch (e) { toast(e, 'err'); }
  }

  const find = (key) => { const [kind, id] = key.split(':'); return { kind, id: Number(id), item: items.find((i) => i.kind === kind && i.id === Number(id)) }; };
  const patchStock = async (key, body, okMsg) => {
    const { kind, id } = find(key);
    try { await api(`/manage/stock/${urlKind(kind)}/${id}`, { method: 'PATCH', body: { branchId, ...body } }); toast(okMsg, 'ok'); await load(); } catch (e) { toast(e, 'err'); await load(); }
  };

  box.addEventListener('click', async (e) => {
    const tg = e.target.closest('[data-bp-toggle]');
    if (tg) { panelOpen = !panelOpen; drawAll(); if (panelOpen) $('[data-bp-q]', box)?.focus(); return; }
    const opt = e.target.closest('[data-bp-id]');
    if (opt) { branchId = Number(opt.dataset.bpId); try { sessionStorage.setItem(KEY, String(branchId)); } catch { /* ignore */ } panelOpen = false; bq = ''; await load(); $('[data-bp-toggle]', box)?.focus(); return; }
    const chip = e.target.closest('[data-s-chip]');
    if (chip) { f.status = chip.dataset.sChip; const sel = $('#sstatus', box); if (sel) sel.value = f.status; drawChips(); drawTable(); return; }
    const set = e.target.closest('[data-s-set]');
    if (set) { const v = $(`[data-s-qty="${set.dataset.sSet}"]`, box).value; if (!/^\d+$/.test(v)) { toast(t('stock.enterQty'), 'err'); return; } return patchStock(set.dataset.sSet, { quantity: Number(v) }, t('stock.updated')); }
    const add = e.target.closest('[data-s-add]');
    if (add) { const v = $(`[data-s-addq="${add.dataset.sAdd}"]`, box).value; if (!/^\d+$/.test(v) || Number(v) < 1) { toast(t('stock.enterRestock'), 'err'); return; } return patchStock(add.dataset.sAdd, { restockBy: Number(v) }, t('stock.restocked')); }
    const low = e.target.closest('[data-s-low]');
    if (low) { const v = $(`[data-s-lowq="${low.dataset.sLow}"]`, box).value; if (v !== '' && !/^\d+$/.test(v)) { toast(t('stock.enterQty'), 'err'); return; } return patchStock(low.dataset.sLow, { lowStockThreshold: v === '' ? null : Number(v) }, t('stock.updated')); }
    if (e.target.closest('[data-adopt]')) {
      if (!await confirmDialog(t('stock.legacyConfirm', { branch: branchName(current()) }), { confirmLabel: t('stock.legacyConfirmBtn') })) return;
      try { await api('/manage/stock/adopt-legacy', { method: 'POST', body: { branchId } }); toast(t('stock.updated'), 'ok'); await load(); } catch (err) { toast(err, 'err'); }
      return;
    }
    if (panelOpen && !e.target.closest('.branch-picker')) { panelOpen = false; drawAll(); }
  });
  document.addEventListener('click', (e) => { if (panelOpen && box.isConnected && !e.target.closest('.branch-picker')) { panelOpen = false; render($('#stock-picker', box), pickerHtml()); } });
  box.addEventListener('keydown', (e) => {
    const opt = e.target.closest('[data-bp-id]');
    if (e.key === 'Escape' && panelOpen) { panelOpen = false; drawAll(); $('[data-bp-toggle]', box)?.focus(); return; }
    if (!opt) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opt.click(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); opt.nextElementSibling?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); (opt.previousElementSibling || $('[data-bp-q]', box))?.focus(); }
  });
  box.addEventListener('input', (e) => {
    if (e.target.id === 'sq') { f.q = e.target.value; drawTable(); }
    if (e.target.matches('[data-bp-q]')) { bq = e.target.value; const pos = e.target.selectionStart; render($('#stock-picker', box), pickerHtml()); const q = $('[data-bp-q]', box); q.focus(); q.setSelectionRange(pos, pos); }
  });
  box.addEventListener('change', async (e) => {
    if (e.target.id === 'skind') { f.kind = e.target.value; drawTable(); return; }
    if (e.target.id === 'sstatus') { f.status = e.target.value; drawChips(); drawTable(); return; }
    const av = e.target.closest('[data-s-avail]');
    const tr = e.target.closest('[data-s-track]');
    if (av) return patchStock(av.dataset.sAvail, { isAvailable: av.checked }, t('menu.availabilityUpdated'));
    if (tr) {
      const { kind, id } = find(tr.dataset.sTrack);
      try { await api(`/manage/${kind === 'extra' ? 'extras' : 'products'}/${id}/stock`, { method: 'PATCH', body: { trackStock: tr.checked } }); toast(t('stock.updated'), 'ok'); } catch (err) { toast(err, 'err'); }
      await load();
    }
  });

  render(box, spinner());
  try {
    const s = await api(`/manage/stock?branchId=${branchId}`);
    items = s.items; summary = s.summary; legacy = s.legacy;
  } catch (e) { return render(box, errorBox(e)); }
  drawShell();
  return true;
}
