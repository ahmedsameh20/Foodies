// All dishes -> Export to Excel / Import from Excel. The browser only picks the file, shows the server's preview and asks for confirmation:
// every rule (required fields, prices, categories, duplicates, plan limits, ownership) is decided by the server, which validates the
// whole file again when the import is confirmed.
import {
  api, ApiError, $, render, html, raw, t, has, toast, wireDialog, errorMessage, spinner, errorBox,
} from './common.js';
import { icon } from './icons.js';

const MAX_BYTES = 2 * 1024 * 1024;

// Downloads a file from the (cookie-authenticated) API: the response is a binary workbook, not JSON.
export async function downloadFile(path, fallbackName) {
  let res;
  try { res = await fetch(`/api${path}`, { credentials: 'same-origin' }); } catch { throw new ApiError(0, { message: 'Cannot reach the server.' }); }
  if (!res.ok) {
    let err = null;
    try { err = (await res.json()).error; } catch { /* not JSON */ }
    throw new ApiError(res.status, err || { message: `Request failed (${res.status})` });
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function exportDishes(d) {
  try {
    await downloadFile('/manage/dishes/export.xlsx', 'foodies-dishes.xlsx');
    toast(d.products.length ? t('import.exported') : t('import.exportedEmpty'), 'ok');
  } catch (e) { toast(e, 'err'); }
}

const issueText = (e) => (has(`import.err.${e.code}`) ? t(`import.err.${e.code}`, { field: e.field, max: e.max }) : `${e.field}: ${e.message}`);
const headerText = (e) => (has(`import.hdr.${e.code}`) ? t(`import.hdr.${e.code}`, { field: e.field }) : e.message);

export function importDialog(d) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'wide import-dialog';
    dlg.setAttribute('aria-labelledby', 'imp-title');
    document.body.append(dlg);
    dlg.showModal();
    let changed = false;
    wireDialog(dlg, () => { resolve(); if (changed) d.refresh(); });

    const st = { mode: 'create', file: null, key: null, report: null, skipInvalid: false, busy: false, error: null, result: null };
    const close = () => dlg.close();

    function stepPick() {
      render(dlg, html`<h2 id="imp-title">${t('import.title')}</h2>
        <p class="muted">${t('import.intro')}</p>
        <ol class="import-steps small">
          <li>${t('import.step1')} <button type="button" class="btn secondary sm" data-tpl>${icon('down', { size: 14 })} ${t('import.template')}</button></li>
          <li>${t('import.step2')}</li><li>${t('import.step3')}</li></ol>
        ${st.error ? errorBox(st.error) : ''}
        <fieldset class="field" style="border:0;padding:0;margin:0 0 1rem"><legend style="font-weight:600;font-size:.9rem">${t('import.mode')}</legend>
          <div class="check"><input type="radio" id="imp-m-create" name="mode" value="create" ${st.mode === 'create' ? raw('checked') : ''}><label for="imp-m-create">${t('import.modeCreate')}</label></div>
          <div class="hint">${t('import.modeCreateHint')}</div>
          <div class="check"><input type="radio" id="imp-m-update" name="mode" value="update" ${st.mode === 'update' ? raw('checked') : ''}><label for="imp-m-update">${t('import.modeUpdate')}</label></div>
          <div class="hint">${t('import.modeUpdateHint')}</div></fieldset>
        <div class="field"><label for="imp-file">${t('import.file')}</label><input id="imp-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"><div class="hint">${t('import.fileHint')}</div></div>
        <div class="actions-row"><button class="btn" type="button" data-preview ${st.file ? '' : raw('disabled')}>${t('import.preview')}</button><button class="btn secondary" type="button" data-close>${t('common.cancel')}</button></div>`);
    }

    const badge = (r) => (r.status === 'ok' ? html`<span class="badge ok">${r.action === 'update' ? t('import.willUpdate') : t('import.willCreate')}</span>`
      : r.status === 'skipped' ? html`<span class="badge warn">${t('import.willSkip')}</span>` : html`<span class="badge err">${t('import.invalid')}</span>`);

    function stepPreview() {
      const rep = st.report;
      const tot = rep.totals;
      const importable = rep.creates + rep.updates;
      const blocked = rep.headerErrors.length > 0 || (tot.errors > 0 && !st.skipInvalid) || importable === 0;
      render(dlg, html`<h2 id="imp-title">${t('import.previewTitle')}</h2>
        <p class="muted small"><bdi>${st.file.name}</bdi> · ${st.mode === 'update' ? t('import.modeUpdate') : t('import.modeCreate')}</p>
        ${st.error ? errorBox(st.error) : ''}
        ${rep.headerErrors.length ? html`<div class="alert err" role="alert"><strong>${t('import.headerProblems')}</strong><ul>${rep.headerErrors.map((e) => html`<li>${headerText(e)}</li>`)}</ul></div>` : ''}
        ${rep.ignoredColumns.length ? html`<div class="alert info small" role="status">${t('import.ignored', { cols: rep.ignoredColumns.join(', ') })}</div>` : ''}
        <div class="import-totals">
          <span class="badge ok">${t('import.nValid', { n: importable })}</span>
          <span class="badge ${tot.errors ? 'err' : 'nocap'}">${t('import.nInvalid', { n: tot.errors })}</span>
          <span class="badge ${tot.skipped ? 'warn' : 'nocap'}">${t('import.nSkipped', { n: tot.skipped })}</span></div>
        ${rep.rows.length ? html`<div class="table-wrap import-rows"><table><thead><tr><th class="num">${t('import.row')}</th><th>${t('menu.dish')}</th><th>${t('import.action')}</th><th>${t('import.issues')}</th></tr></thead><tbody>
          ${rep.rows.map((r) => html`<tr class="${r.status === 'error' ? 'row-err' : ''}"><td class="num">${r.row}</td><td><bdi>${r.name || '—'}</bdi></td><td>${badge(r)}</td>
            <td>${r.errors.length ? html`<ul class="issues">${r.errors.map((e) => html`<li>${issueText(e)}</li>`)}</ul>` : r.status === 'skipped' ? t('import.dupExisting') : ''}
              ${r.warnings.map((w) => html`<div class="muted small">${has(`import.warn.${w.code}`) ? t(`import.warn.${w.code}`, { field: w.field }) : w.code}</div>`)}</td></tr>`)}</tbody></table></div>` : (rep.headerErrors.length ? '' : html`<p class="muted">${t('import.noRows')}</p>`)}
        ${tot.errors > 0 && !rep.headerErrors.length ? html`<label class="check"><input type="checkbox" id="imp-skip" ${st.skipInvalid ? raw('checked') : ''}><span>${t('import.skipInvalid', { n: tot.errors })}</span></label>` : ''}
        <div class="actions-row"><button class="btn" type="button" data-confirm ${blocked || st.busy ? raw('disabled') : ''}>${st.busy ? t('common.loading') : t('import.confirm', { n: importable })}</button>
          <button class="btn secondary" type="button" data-back>${t('import.chooseAnother')}</button><button class="btn secondary" type="button" data-close>${t('common.cancel')}</button></div>`);
    }

    function stepDone() {
      const s = st.result;
      render(dlg, html`<h2 id="imp-title">${t('import.doneTitle')}</h2>
        <div class="grid cols-4 import-summary">
          <div class="card stat"><div class="label">${t('import.created')}</div><div class="value">${s.created}</div></div>
          <div class="card stat"><div class="label">${t('import.updated')}</div><div class="value">${s.updated}</div></div>
          <div class="card stat"><div class="label">${t('import.skipped')}</div><div class="value">${s.skipped}</div></div>
          <div class="card stat"><div class="label">${t('import.failed')}</div><div class="value">${s.failed}</div></div></div>
        ${s.failed ? html`<p class="muted small">${t('import.failedNote')}</p>` : ''}
        <div class="actions-row"><button class="btn" type="button" data-close>${t('import.finish')}</button></div>`);
    }

    // ---- the server reads the same file again on every call: preview first, then the confirmed import
    const query = () => `mode=${st.mode}${st.skipInvalid ? '&skipInvalid=1' : ''}`;
    async function runPreview() {
      st.busy = true; st.error = null;
      render(dlg, spinner());
      try {
        const { report } = await api(`/manage/dishes/import/preview?mode=${st.mode}`, { method: 'POST', raw: true, body: st.file, headers: { 'Content-Type': st.file.type || 'application/octet-stream' } });
        st.report = report; st.skipInvalid = false; st.busy = false;
        stepPreview();
      } catch (e) { st.busy = false; st.error = e; stepPick(); }
    }
    async function runImport() {
      st.busy = true; st.error = null;
      stepPreview();
      try {
        const out = await api(`/manage/dishes/import?${query()}`, { method: 'POST', raw: true, body: st.file, headers: { 'Content-Type': st.file.type || 'application/octet-stream', 'Idempotency-Key': st.key } });
        st.result = out.summary; st.busy = false; changed = true;
        stepDone();
      } catch (e) {
        st.busy = false;
        if (e.code === 'import_invalid' && e.details?.report) { st.report = e.details.report; st.error = e; } else st.error = e;
        stepPreview();
      }
    }

    dlg.addEventListener('click', async (e) => {
      if (e.target.closest('[data-close]')) return close();
      if (e.target.closest('[data-tpl]')) { try { await downloadFile('/manage/dishes/template.xlsx', 'foodies-dishes-template.xlsx'); } catch (err) { toast(err, 'err'); } return; }
      if (e.target.closest('[data-preview]')) return runPreview();
      if (e.target.closest('[data-confirm]')) return runImport();
      if (e.target.closest('[data-back]')) { st.file = null; st.report = null; st.error = null; stepPick(); }
    });
    dlg.addEventListener('change', (e) => {
      if (e.target.name === 'mode') st.mode = e.target.value;
      if (e.target.id === 'imp-skip') { st.skipInvalid = e.target.checked; stepPreview(); }
      if (e.target.id === 'imp-file') {
        const f = e.target.files[0];
        st.error = null;
        // quick checks before uploading anything; the server repeats and enforces all of them
        if (f && !/\.xlsx$/i.test(f.name)) { st.file = null; st.error = Object.assign(new Error('type'), { code: 'validation_error', details: { field: 'file', reason: 'not_xlsx' } }); }
        else if (f && f.size > MAX_BYTES) { st.file = null; st.error = Object.assign(new Error('size'), { code: 'validation_error', details: { field: 'file', reason: 'file_too_big' } }); }
        else { st.file = f || null; st.key = f ? `imp_${crypto.randomUUID().replace(/-/g, '')}` : null; } // one key per chosen file: a retry or double click imports once
        if (st.error) stepPick();
        else $('[data-preview]', dlg).disabled = !st.file;
      }
    });
    void errorMessage;
    stepPick();
  });
}
