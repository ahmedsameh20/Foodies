// International mobile-number input: a country-code selector plus the national number, composed into one E.164 value ("+966500000000")
// that is what the form submits and the server validates. Typing a complete international number ("+44 7700 900123", "00966...", Arabic
// digits) into the number box is understood too: the country is detected from the longest matching dial code.
import { html, raw, esc, t, lang, $ } from './common.js';
import { COUNTRIES, splitPhone, composePhone } from './phone-format.js';

// Renders the field into `container` (a .field wrapper is created). Returns { set(e164), get() }.
export function mountPhoneInput(container, { id = 'phone', name = 'phone', label = t('field.phone'), value = '', required = true, hint = '' } = {}) {
  const options = COUNTRIES.map(([dial, en, ar]) => `<option value="${dial}">+${dial} ${esc(lang === 'ar' ? ar : en)}</option>`).join('')
    + `<option value="">${esc(t('phone.other'))}</option>`;
  container.innerHTML = html`<div class="field">
    <label for="${id}">${label}</label>
    <div class="phone-input">
      <select id="${id}-cc" aria-label="${t('phone.countryCode')}">${raw(options)}</select>
      <input id="${id}" type="tel" inputmode="tel" autocomplete="tel-national" data-field="${name}" ${required ? raw('required') : ''} placeholder="5X XXX XXXX" maxlength="30" dir="ltr">
    </div>
    <input type="hidden" name="${name}">
    <div class="hint">${hint || t('phone.hint')}</div></div>`.s;
  const cc = $(`#${id}-cc`, container);
  const input = $(`#${id}`, container);
  const hidden = $(`input[type=hidden][name="${name}"]`, container);
  const sync = () => { hidden.value = composePhone(cc.value, input.value); };
  const set = (e164) => {
    const p = splitPhone(e164 || '');
    if (p.dial === null) { input.value = p.national; } else {
      cc.value = COUNTRIES.some(([d]) => d === p.dial) ? p.dial : '';
      input.value = p.dial === '' ? `+${p.national}` : p.national;
    }
    sync();
  };
  input.addEventListener('input', () => {
    // a complete international number pasted/typed in the box: adopt its country and keep only the national part visible
    const p = splitPhone(input.value);
    if (p.dial) { cc.value = p.dial; input.value = p.national; }
    sync();
  });
  cc.addEventListener('change', sync);
  cc.value = '966';
  if (value) set(value); else sync();
  return { set, get: () => hidden.value };
}
