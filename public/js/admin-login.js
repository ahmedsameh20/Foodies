import { session, onSubmit, $, mountChrome, t, esc } from './common.js';
import { signIn, completeMfa, safeNext } from './auth.js';

mountChrome();
if (new URLSearchParams(location.search).has('next')) $('#next-note').innerHTML = `<div class="alert info">${esc(t('admlogin.pleaseSignIn'))}</div>`;

let mfaToken = null;
// The backend decides who is an admin (every /api/admin call and every /admin page checks the role);
// this page only refuses to continue for accounts that are not administrators.
function finish(user) {
  if (user.role !== 'super_admin') {
    session.clear();
    fetch('/api/auth/logout', { method: 'POST' });
    throw Object.assign(new Error(t('admlogin.notAdmin')), { code: 'not_admin' });
  }
  session.set(user);
  const next = safeNext('/admin/dashboard');
  location.href = next.startsWith('/admin') ? next : '/admin/dashboard';
}

onSubmit($('#form'), async (d) => {
  const r = await signIn(d.email, d.password);
  if (r.mfaRequired) {
    mfaToken = r.mfaToken;
    $('#form').classList.add('hidden');
    $('#mfa').classList.remove('hidden');
    $('#code').focus();
    return;
  }
  finish(r.user);
});
onSubmit($('#mfa'), async (d) => {
  const r = await completeMfa(mfaToken, d.code);
  finish(r.user);
});
