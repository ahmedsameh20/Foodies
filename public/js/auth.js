import { api, session, homeFor, onSubmit, mountChrome, $, $$ } from './common.js';

// Only follow same-site relative redirects (prevents open-redirect via ?next=).
export function safeNext(fallback) {
  const next = new URLSearchParams(location.search).get('next');
  return next && /^\/(?!\/)[^\s\\]*$/.test(next) ? next : fallback;
}

// Password step. Resolves { user } or { mfaRequired, mfaToken } when the account has two-factor authentication.
export const signIn = (email, password) => api('/auth/login', { method: 'POST', body: { email, password } });
export const completeMfa = (mfaToken, code) => api('/auth/mfa', { method: 'POST', body: { mfaToken, code } });

export function initLogin() {
  mountChrome({ active: 'login' });
  if (new URLSearchParams(location.search).has('next')) {
    $('#next-note').innerHTML = '<div class="alert info">Please sign in to continue.</div>';
  }
  const go = (user) => {
    session.set(user); // the session itself lives in an httpOnly cookie
    location.href = user.role === 'super_admin' ? '/admin/dashboard' : safeNext(homeFor(user));
  };
  onSubmit($('#form'), async (d) => {
    const r = await signIn(d.email, d.password);
    if (!r.mfaRequired) return go(r.user);
    // two-factor step (admins)
    const form = document.createElement('form');
    form.id = 'mfa';
    form.noValidate = true;
    form.innerHTML = '<div class="form-alert"></div><p>Enter the 6-digit code from your authenticator app, or a backup code.</p><div class="field"><label for="code">Verification code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required></div><button class="btn block" type="submit">Verify</button>';
    $('#form').replaceWith(form);
    $('#code').focus();
    onSubmit(form, async (m) => go((await completeMfa(r.mfaToken, m.code)).user));
  });
}

export function initRegister() {
  mountChrome();
  const params = new URLSearchParams(location.search);
  if (params.get('kind') === 'owner') $('input[name=kind][value=owner]').checked = true;
  onSubmit($('#form'), async (d) => {
    const kind = $$('input[name=kind]').find((r) => r.checked).value;
    const data = await api(kind === 'owner' ? '/auth/register-owner' : '/auth/register', {
      method: 'POST', body: { name: d.name, email: d.email, password: d.password },
    });
    session.set(data.user);
    location.href = safeNext(homeFor(data.user));
  });
}
