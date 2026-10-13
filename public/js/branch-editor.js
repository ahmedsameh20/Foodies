// Add / edit one branch (names, phone, address and its own map location) from the dashboard. The registration wizard (onboarding.js)
// uses the same map picker and the same field names, and the server validates both through the same code (services/branches.js).
import {
  api, $, html, raw, toast, onSubmit, wireDialog, t, loc,
} from './common.js';
import { mountMapPicker } from './map-picker.js';

const AR = /[؀-ۿ]/;
// A branch created before it had separate Arabic / English names keeps its single name in the box that matches its script.
export function branchNames(b) {
  const ar = b?.nameAr || '';
  const en = b?.nameEn || '';
  if (ar || en) return { ar, en };
  return AR.test(b?.name || '') ? { ar: b.name, en: '' } : { ar: '', en: b?.name || '' };
}
export const branchLabel = (b) => loc(b) || b.name;
export const hasLocation = (b) => Number.isFinite(b?.latitude) && Number.isFinite(b?.longitude);

export function branchDialog(branch, done) {
  return new Promise((resolve) => {
    const n = branchNames(branch);
    const dlg = document.createElement('dialog');
    dlg.className = 'wide';
    dlg.setAttribute('aria-labelledby', 'bd-title');
    dlg.innerHTML = html`<h2 id="bd-title">${branch ? t('branch.edit') : t('branch.add')}</h2>
      <form novalidate><div class="form-alert"></div>
        <div class="lang-pair">
          <div class="field"><label for="bd-ar">${t('branch.nameAr')} <span class="tag">AR</span></label><input id="bd-ar" name="nameAr" data-field="nameAr" dir="rtl" lang="ar" required maxlength="100" value="${n.ar}"></div>
          <div class="field"><label for="bd-en">${t('branch.nameEn')} <span class="tag">EN</span></label><input id="bd-en" name="nameEn" data-field="nameEn" dir="ltr" lang="en" required maxlength="100" value="${n.en}"></div>
        </div>
        <div class="row">
          <div class="field"><label for="bd-phone">${t('branch.phone')}</label><input id="bd-phone" name="phone" data-field="phone" type="tel" dir="ltr" autocomplete="off" value="${branch?.phone || ''}"></div>
          <div class="field"><label for="bd-addr">${t('field.address')}</label><input id="bd-addr" name="address" data-field="address" maxlength="300" value="${branch?.address || ''}"><div class="hint">${t('branch.addressHint')}</div></div>
        </div>
        <h3 style="font-size:1rem;margin:1rem 0 .25rem">${t('branch.location')}</h3>
        <div id="bd-map" data-field="latitude"></div>
        ${branch ? html`<label class="check" style="margin-top:.75rem"><input type="checkbox" name="isActive" ${branch.isActive ? raw('checked') : ''}><span>${t('branch.activeLabel')}</span></label><p class="hint">${t('branch.activeHint')}</p>` : ''}
        <div class="actions-row"><button class="btn" type="submit">${t('common.save')}</button><button class="btn secondary" type="button" data-close>${t('common.cancel')}</button></div></form>`.s;
    document.body.append(dlg);
    dlg.showModal();
    wireDialog(dlg, resolve);
    dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dlg.close(); });

    const form = $('form', dlg);
    let point = hasLocation(branch) ? { latitude: branch.latitude, longitude: branch.longitude } : null;
    let components = branch?.addressComponents || null;
    let addressTyped = !!branch?.address; // an address the owner typed (or saved earlier) is not replaced by the map's suggestion
    form.elements.address.addEventListener('input', () => { addressTyped = form.elements.address.value.trim() !== ''; });
    mountMapPicker($('#bd-map', dlg), {
      lat: point?.latitude ?? null, lng: point?.longitude ?? null, label: t('branch.location'),
      onChange: (ev) => {
        if (ev.source !== 'reverse') point = { latitude: ev.latitude, longitude: ev.longitude };
        if (ev.components) components = ev.components;
        if (ev.address && (ev.source === 'search' || !addressTyped)) { form.elements.address.value = ev.address.slice(0, 300); addressTyped = ev.source === 'search'; }
      },
    });

    onSubmit(form, async (v) => {
      if (!point) throw Object.assign(new Error('location'), { code: 'validation_error', details: { field: 'latitude', reason: 'location_required' } });
      const body = {
        nameAr: v.nameAr, nameEn: v.nameEn, phone: v.phone || null, address: v.address || null,
        latitude: point.latitude, longitude: point.longitude, addressComponents: components || undefined,
        ...(branch ? { isActive: v.isActive } : {}),
      };
      await api(branch ? `/manage/branches/${branch.id}` : '/manage/branches', { method: branch ? 'PUT' : 'POST', body });
      toast(branch ? t('branch.saved') : t('team.branchAdded'), 'ok');
      dlg.close(); done();
    }, { alertBox: $('.form-alert', dlg) });
  });
}
