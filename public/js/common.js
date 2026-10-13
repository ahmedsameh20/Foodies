// Shared helpers: API client, session, safe HTML templating, toasts, header.
// No inline scripts or inline event handlers anywhere (strict CSP). Authentication uses an httpOnly cookie that
// JavaScript cannot read; only the non-sensitive user profile is cached here to render the navigation.
import { t, has, lang, locale, isRtl, langLocked, setLang, adoptLang, isDefaultText, loc, locKeys } from './i18n.js';

export { t, has, lang, locale, isRtl, loc, locKeys, isDefaultText };

const USER_KEY = 'foodies.user';
const DRAFT_PREFIX = 'foodies.draft.';

export const session = {
  get user() { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } },
  set(user) {
    try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch { /* storage blocked */ }
    if (user?.lang) adoptLang(user.lang); // the language chosen on another device / session applies from the next page load
  },
  clear() {
    try { localStorage.removeItem(USER_KEY); } catch { /* ignore */ }
    clearDrafts();
  },
};

// ---- form drafts: values typed into a multi-step form survive validation errors and navigation, but never leave the tab,
// are keyed by the signed-in user (one person's draft is never shown to another) and are wiped on sign-out. Passwords are never stored.
export const draft = {
  key: (name) => `${DRAFT_PREFIX}${name}.${session.user?.id ?? 'anon'}`,
  load(name) { try { return JSON.parse(sessionStorage.getItem(draft.key(name))) || null; } catch { return null; } },
  save(name, values) { try { sessionStorage.setItem(draft.key(name), JSON.stringify(values)); } catch { /* storage blocked */ } },
  clear(name) { try { sessionStorage.removeItem(draft.key(name)); } catch { /* ignore */ } },
};
export function clearDrafts() {
  try {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith(DRAFT_PREFIX)) sessionStorage.removeItem(k);
  } catch { /* storage blocked */ }
}

// ---- translated error text ----
// Server messages are English. Errors carry a stable `code` (and, for validation, a `details.reason`), which are translated here.
const lastSegment = (field) => String(field || '').replace(/\[\d+\]/g, '').split('.').pop();
export function fieldLabel(field) {
  const seg = lastSegment(field);
  return has(`field.${seg}`) ? t(`field.${seg}`) : seg;
}
// Validation reasons are translated in both languages (the field is named in plain words). Other server errors keep their own, more
// specific English message; in Arabic they are replaced by the translation of their code when there is one.
export function errorMessage(e) {
  if (!e) return t('err.generic');
  const d = e.details || {};
  const vars = { ...d, label: fieldLabel(d.field), name: locKeys(d, 'nameAr', 'nameEn', 'name') };
  if (e.code === 'validation_error' && d.reason && has(`v.${d.reason}`)) return t(`v.${d.reason}`, vars);
  if (e.status === 0) return t('err.network');
  if (lang === 'ar') {
    if (e.code && has(`err.${e.code}`)) return t(`err.${e.code}`, vars);
    if (e.status >= 500 || !e.code) return t('err.generic'); // no stable code to translate by (e.g. a proxy's HTML error page): never show English technical text
  }
  return e.message || t('err.generic');
}

export class ApiError extends Error {
  constructor(status, error) { super(error?.message || 'Request failed'); this.status = status; this.code = error?.code; this.details = error?.details; }
  get friendly() { return errorMessage(this); }
}

export async function api(path, { method = 'GET', body, raw, headers } = {}) {
  const h = { ...(headers || {}) };
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers: h, credentials: 'same-origin', body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, { message: 'Cannot reach the server. Check your connection and try again.' });
  }
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) {
    if (!res.ok) throw new ApiError(res.status, { message: `Request failed (${res.status})` });
    return res; // e.g. CSV
  }
  const json = await res.json();
  if (!res.ok) {
    if (res.status === 401 && session.user) { // session expired or revoked
      session.clear();
      if (!/^\/(login|register|forgot|reset)/.test(location.pathname)) location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
    }
    throw new ApiError(res.status, json.error);
  }
  return json.data;
}

// ---- safe templating: interpolated values are escaped unless wrapped in raw()/nested html`` ----
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Safe(String(s));
const escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => escMap[c]);
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    const part = Array.isArray(v) ? v.map((x) => (x instanceof Safe ? x.s : esc(x))).join('') : v instanceof Safe ? v.s : esc(v);
    out += part + strings[i + 1];
  });
  return new Safe(out);
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function render(el, content) { el.innerHTML = content instanceof Safe ? content.s : esc(content); }

export function money(cents, currency = 'USD') {
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency }).format((cents || 0) / 100); }
  catch { return `${((cents || 0) / 100).toFixed(2)} ${currency}`; }
}
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString(locale, { dateStyle: 'medium' }) : '');
export const cap = (s) => String(s || '').replace(/_/g, ' ');
// status / payment status in the visitor's language (falls back to the raw code with underscores removed)
export const statusLabel = (s) => (has(`status.${s}`) ? t(`status.${s}`) : cap(s));
export const payLabel = (s) => (has(`pay.${s}`) ? t(`pay.${s}`) : cap(s));
// The platform's default plans are shown in the visitor's language while their text is still the unedited default; edited plans show as written.
export const planName = (p) => (isDefaultText(`plan.${p.code}.name`, p.name) ? t(`plan.${p.code}.name`) : p.name);
export const planDesc = (p) => (isDefaultText(`plan.${p.code}.desc`, p.description) ? t(`plan.${p.code}.desc`) : p.description);
export const planHighlights = (p) => (p.highlights.length
  ? p.highlights.map((h, i) => (isDefaultText(`plan.${p.code}.f${i + 1}`, h) ? t(`plan.${p.code}.f${i + 1}`) : h))
  : [t('sub.productsN', { n: p.limits.menuItems ?? t('sub.unlimited') }), t('sub.staffN', { n: p.limits.staff ?? t('sub.unlimited') })]);
// "12.50" / "12,5" / "١٢٫٥٠" -> 1250 (integer cents, no float arithmetic on the result); NaN when not a plain amount
const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
export function toCents(v) {
  const s = String(v).trim().replace(/[٠-٩]/g, (d) => ARABIC_DIGITS[d]).replace(/[٫]/g, '.');
  const m = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(s);
  return m ? Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0') || 0) : NaN;
}
export const fromCents = (c) => `${Math.trunc((c || 0) / 100)}.${String(Math.abs(c || 0) % 100).padStart(2, '0')}`;

// ---- toasts ----
export function toast(messageOrError, kind = '') {
  let box = $('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const isErr = messageOrError instanceof Error;
  el.textContent = isErr ? errorMessage(messageOrError) : messageOrError;
  if (isErr && messageOrError.details?.upgrade) { // plan limit / feature not in plan: never fail silently, offer the way forward
    const a = document.createElement('a');
    a.href = '/dashboard.html#subscription'; a.textContent = ` ${t('common.upgrade')}`; a.style.color = 'inherit'; a.style.fontWeight = '700';
    el.append(a);
  }
  box.append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 8000 : 3500);
}

export const spinner = () => html`<div class="spinner" role="status" aria-label="${t('common.loading')}"></div>`;
export const emptyState = (title, text = '') => html`<div class="empty"><strong>${title}</strong>${text}</div>`;
export const errorBox = (e) => html`<div class="alert err" role="alert">${errorMessage(e)}${e?.details?.upgrade ? raw(` <a href="/dashboard.html#subscription"><strong>${esc(t('common.upgrade'))}</strong></a>`) : ''}</div>`;

// Dialog lifecycle that does not depend on the browser firing a "close" event: closing (by code, Esc or the
// backdrop) always removes the element and runs `onClose` exactly once.
export function wireDialog(dlg, onClose) {
  let done = false;
  const finish = () => { if (done) return; done = true; dlg.remove(); if (onClose) onClose(); };
  const nativeClose = dlg.close.bind(dlg);
  dlg.close = (...a) => { if (dlg.open) nativeClose(...a); finish(); };
  dlg.addEventListener('close', finish);
  dlg.addEventListener('cancel', () => setTimeout(finish, 0)); // Esc
  return dlg;
}

// Confirmation dialog (replaces window.confirm so it is styled, accessible and testable).
export function confirmDialog(message, { confirmLabel = t('common.confirm'), danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.setAttribute('aria-label', t('common.confirmAction'));
    dlg.innerHTML = html`<p style="margin-top:0">${message}</p><div class="actions-row"><button class="btn ${danger ? 'danger' : ''}" data-yes>${confirmLabel}</button><button class="btn secondary" data-no>${t('common.cancel')}</button></div>`.s;
    document.body.append(dlg);
    let answer = false;
    wireDialog(dlg, () => resolve(answer));
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-yes]')) { answer = true; dlg.close(); }
      if (e.target.closest('[data-no]')) dlg.close();
    });
    dlg.showModal();
  });
}

// Prompt for a required text value (e.g. a rejection reason). Resolves with the trimmed text or null.
export function promptDialog(label, { confirmLabel = t('common.submit'), placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.setAttribute('aria-label', label);
    dlg.innerHTML = html`<form novalidate><div class="field"><label for="pd-input">${label}</label><input id="pd-input" name="v" maxlength="200" placeholder="${placeholder}" required></div>
      <div class="actions-row"><button class="btn" type="submit">${confirmLabel}</button><button class="btn secondary" type="button" data-no>${t('common.cancel')}</button></div></form>`.s;
    document.body.append(dlg);
    let answer = null;
    wireDialog(dlg, () => resolve(answer));
    dlg.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      answer = dlg.querySelector('input').value.trim() || null;
      dlg.close();
    });
    dlg.addEventListener('click', (e) => { if (e.target.closest('[data-no]')) dlg.close(); });
    dlg.showModal();
    dlg.querySelector('input').focus();
  });
}

// ---- forms ----
export function formData(form) {
  const o = {};
  for (const [k, v] of new FormData(form)) o[k] = v;
  $$('input[type=checkbox]', form).forEach((c) => { if (c.name) o[c.name] = c.checked; });
  return o;
}
// Marks the field named in err.details.field as invalid with a translated message. Fields are found by name or, for nested form
// controls (dish extras), by data-field="optionGroups[0].options[1].nameAr". Returns true when a field was marked.
export function showFieldErrors(form, err) {
  $$('.field.invalid', form).forEach((f) => { f.classList.remove('invalid'); $('.error-text', f)?.remove(); });
  const field = err?.details?.field;
  if (!field) return false;
  const input = $$('[data-field]', form).find((el) => el.dataset.field === field) || form.elements[field.replace(/\[.*$/, '')];
  if (!input) return false;
  input.closest('details')?.setAttribute('open', ''); // a collapsed form section holding the problem is opened
  const wrap = input.closest('.field');
  if (wrap) {
    wrap.classList.add('invalid');
    const p = document.createElement('div');
    p.className = 'error-text'; p.setAttribute('role', 'alert');
    // validation reasons are translated (and name the field); anything else shows the server text after the "field:" prefix
    const translated = err.details.reason && has(`v.${err.details.reason}`);
    p.textContent = translated ? errorMessage(err) : `${$('label', wrap)?.textContent.trim() || ''} ${String(err.message).replace(/^[^:]+:\s*/, '')}`.trim();
    wrap.append(p);
  }
  input.focus();
  return true;
}
// Wrap an async submit handler: disables the button, shows errors inline.
export function onSubmit(form, handler, { alertBox } = {}) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const box = alertBox || $('.form-alert', form);
    if (box) box.innerHTML = '';
    showFieldErrors(form, null);
    if (btn) btn.disabled = true;
    try { await handler(formData(form), form); }
    catch (err) {
      if (!showFieldErrors(form, err) && box) box.innerHTML = errorBox(err).s;
      else if (!box) toast(err, 'err');
    } finally { if (btn) btn.disabled = false; }
  });
}

// ---- header / footer ----
export function homeFor(user) {
  if (!user) return '/';
  return { super_admin: '/admin/dashboard', owner: user.restaurantId ? '/dashboard.html' : '/onboarding.html', staff: '/dashboard.html', customer: '/orders.html' }[user.role] || '/';
}

let configCache;
export async function publicConfig() {
  if (!configCache) configCache = api('/public/config').catch(() => ({ whatsappUrl: null, paymentMethods: { card: false, cod: true }, currency: 'USD', serviceFee: { bp: 0, fixedCents: 0 } }));
  return configCache;
}

export function mountChrome({ active } = {}) {
  const user = session.user;
  const link = (href, label, key) => html`<a href="${href}" ${active === key ? raw('aria-current="page"') : ''}>${label}</a>`;
  const items = [link('/restaurants.html', t('nav.restaurants'), 'restaurants')];
  if (!user) items.push(link('/login.html', t('nav.signIn'), 'login'), raw(`<a class="btn sm" href="/register.html">${esc(t('nav.createAccount'))}</a>`));
  else {
    if (user.role === 'customer') items.push(link('/orders.html', t('nav.myOrders'), 'orders'));
    if (user.role === 'owner' || user.role === 'staff') items.push(link(homeFor(user), t('nav.dashboard'), 'dashboard'));
    if (user.role === 'super_admin') items.push(link('/admin/dashboard', t('nav.admin'), 'admin'));
    items.push(link('/report.html', t('nav.help'), 'help'), html`<span class="muted small">${user.name}</span>`, raw(`<button class="link" type="button" data-logout>${esc(t('nav.signOut'))}</button>`));
  }
  // language switcher: shows the OTHER language's name, written in that language so it is recognisable
  if (!langLocked) items.push(raw(`<button class="link lang-switch" type="button" data-lang-switch lang="${isRtl ? 'en' : 'ar'}" aria-label="${esc(t('nav.switchLanguage'))}">${isRtl ? 'English' : 'العربية'}</button>`));
  const header = document.createElement('header');
  header.className = 'site-header';
  header.innerHTML = `<div class="wrap"><a class="logo" href="/">Foodies<span>.</span><span class="sr-only"> ${esc(t('nav.home'))}</span></a><nav class="nav" aria-label="${esc(t('nav.main'))}">${items.map((i) => i.toString()).join('')}</nav></div>`;
  const skip = document.createElement('a');
  skip.className = 'skip'; skip.href = '#main'; skip.textContent = t('nav.skip');
  document.body.prepend(header);
  document.body.prepend(skip);
  header.addEventListener('click', async (e) => {
    if (e.target.closest('[data-lang-switch]')) return setLang(isRtl ? 'en' : 'ar');
    if (e.target.closest('[data-logout]')) {
      try { await api('/auth/logout', { method: 'POST' }); } catch { /* already signed out */ }
      session.clear();
      location.href = '/';
    }
  });
  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.innerHTML = `<div class="wrap footer-row"><span>&copy; Foodies</span><span class="footer-links"><a href="/report.html">${esc(t('nav.report'))}</a><a id="wa-link" href="#" rel="noopener" target="_blank" class="hidden">${esc(t('nav.whatsapp'))}</a></span></div>`;
  document.body.append(footer);
  publicConfig().then((c) => {
    if (c.whatsappUrl) { const a = $('#wa-link'); a.href = c.whatsappUrl; a.classList.remove('hidden'); }
  });
}

// Gate a page by role; redirects when the signed-in user does not match.
export function requireRoles(...roles) {
  const u = session.user;
  if (!u) { location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`; return null; }
  if (!roles.includes(u.role)) { location.href = homeFor(u); return null; }
  return u;
}
