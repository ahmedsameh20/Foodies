// Shared helpers: API client, session, safe HTML templating, toasts, header.
// No inline scripts or inline event handlers anywhere (strict CSP). Authentication uses an httpOnly cookie that
// JavaScript cannot read; only the non-sensitive user profile is cached here to render the navigation.

const USER_KEY = 'foodies.user';

export const session = {
  get user() { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } },
  set(user) { try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch { /* storage blocked */ } },
  clear() { try { localStorage.removeItem(USER_KEY); } catch { /* ignore */ } },
};

export class ApiError extends Error {
  constructor(status, error) { super(error?.message || 'Request failed'); this.status = status; this.code = error?.code; this.details = error?.details; }
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
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format((cents || 0) / 100); }
  catch { return `${((cents || 0) / 100).toFixed(2)} ${currency}`; }
}
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString([], { dateStyle: 'medium' }) : '');
export const cap = (s) => String(s || '').replace(/_/g, ' ');
// "12.50" / "12,5" -> 1250 (integer cents, no float arithmetic on the result); NaN when not a plain amount
export function toCents(v) {
  const m = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(String(v).trim());
  return m ? Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0') || 0) : NaN;
}
export const fromCents = (c) => `${Math.trunc((c || 0) / 100)}.${String(Math.abs(c || 0) % 100).padStart(2, '0')}`;

// ---- toasts ----
export function toast(messageOrError, kind = '') {
  let box = $('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  const isErr = messageOrError instanceof Error;
  t.textContent = isErr ? messageOrError.message : messageOrError;
  if (isErr && messageOrError.details?.upgrade) { // plan limit / feature not in plan: never fail silently, offer the way forward
    const a = document.createElement('a');
    a.href = '/dashboard.html#subscription'; a.textContent = ' Upgrade your plan →'; a.style.color = 'inherit'; a.style.fontWeight = '700';
    t.append(a);
  }
  box.append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 8000 : 3500);
}

export const spinner = () => html`<div class="spinner" role="status" aria-label="Loading"></div>`;
export const emptyState = (title, text = '') => html`<div class="empty"><strong>${title}</strong>${text}</div>`;
export const errorBox = (e) => html`<div class="alert err" role="alert">${e?.message || 'Something went wrong'}${e?.details?.upgrade ? raw(' <a href="/dashboard.html#subscription"><strong>Upgrade your plan →</strong></a>') : ''}</div>`;

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
export function confirmDialog(message, { confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.setAttribute('aria-label', 'Confirm action');
    dlg.innerHTML = html`<p style="margin-top:0">${message}</p><div class="actions-row"><button class="btn ${danger ? 'danger' : ''}" data-yes>${confirmLabel}</button><button class="btn secondary" data-no>Cancel</button></div>`.s;
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
export function promptDialog(label, { confirmLabel = 'Submit', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.setAttribute('aria-label', label);
    dlg.innerHTML = html`<form novalidate><div class="field"><label for="pd-input">${label}</label><input id="pd-input" name="v" maxlength="200" placeholder="${placeholder}" required></div>
      <div class="actions-row"><button class="btn" type="submit">${confirmLabel}</button><button class="btn secondary" type="button" data-no>Cancel</button></div></form>`.s;
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
  $$('input[type=checkbox]', form).forEach((c) => { o[c.name] = c.checked; });
  return o;
}
export function showFieldErrors(form, err) {
  $$('.field.invalid', form).forEach((f) => { f.classList.remove('invalid'); $('.error-text', f)?.remove(); });
  const field = err?.details?.field;
  const input = field && form.elements[field.replace(/\[.*$/, '')];
  if (input) {
    const wrap = input.closest('.field');
    if (wrap) {
      wrap.classList.add('invalid');
      const p = document.createElement('div');
      p.className = 'error-text'; p.setAttribute('role', 'alert');
      const label = $('label', wrap)?.textContent.trim() || '';
      p.textContent = `${label} ${err.message.replace(/^[^:]+:\s*/, '')}`.trim();
      wrap.append(p);
    }
    input.focus();
    return true;
  }
  return false;
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
      else if (!box) toast(err.message, 'err');
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
  const items = [link('/restaurants.html', 'Restaurants', 'restaurants')];
  if (!user) items.push(link('/login.html', 'Sign in', 'login'), raw('<a class="btn sm" href="/register.html">Create account</a>'));
  else {
    if (user.role === 'customer') items.push(link('/orders.html', 'My orders', 'orders'));
    if (user.role === 'owner' || user.role === 'staff') items.push(link(homeFor(user), 'Dashboard', 'dashboard'));
    if (user.role === 'super_admin') items.push(link('/admin/dashboard', 'Admin Panel', 'admin'));
    items.push(link('/report.html', 'Help', 'help'), html`<span class="muted small">${user.name}</span>`, raw('<button class="link" type="button" data-logout>Sign out</button>'));
  }
  const header = document.createElement('header');
  header.className = 'site-header';
  header.innerHTML = `<div class="wrap"><a class="logo" href="/">Foodies<span>.</span><span class="sr-only"> home</span></a><nav class="nav" aria-label="Main">${items.map((i) => i.toString()).join('')}</nav></div>`;
  const skip = document.createElement('a');
  skip.className = 'skip'; skip.href = '#main'; skip.textContent = 'Skip to content';
  document.body.prepend(header);
  document.body.prepend(skip);
  header.addEventListener('click', async (e) => {
    if (e.target.closest('[data-logout]')) {
      try { await api('/auth/logout', { method: 'POST' }); } catch { /* already signed out */ }
      session.clear();
      location.href = '/';
    }
  });
  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.innerHTML = '<div class="wrap footer-row"><span>&copy; Foodies</span><span class="footer-links"><a href="/report.html">Report a problem</a><a id="wa-link" href="#" rel="noopener" target="_blank" class="hidden">WhatsApp support</a></span></div>';
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
