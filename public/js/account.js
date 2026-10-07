import { api, mountChrome, onSubmit, $, render, html } from './common.js';

export function initForgot() {
  mountChrome();
  onSubmit($('#form'), async (d) => {
    const r = await api('/auth/forgot-password', { method: 'POST', body: { email: d.email } });
    render($('.card'), html`<h1>Check your email</h1><p>${r.message}</p><a class="btn" href="/login.html">Back to sign in</a>`);
  });
}

export function initReset() {
  mountChrome();
  const token = new URLSearchParams(location.search).get('token');
  if (!token) { render($('.card'), html`<h1>Link not valid</h1><p>This reset link is missing its token. Request a new one.</p><a class="btn" href="/forgot-password.html">Request a link</a>`); return; }
  onSubmit($('#form'), async (d) => {
    await api('/auth/reset-password', { method: 'POST', body: { token, password: d.password } });
    render($('.card'), html`<h1>Password updated</h1><p>You can now sign in with your new password.</p><a class="btn" href="/login.html">Sign in</a>`);
  });
}

export async function initVerify() {
  mountChrome();
  const token = new URLSearchParams(location.search).get('token');
  const box = $('#result');
  if (!token) return render(box, html`<h1>Link not valid</h1><p>This confirmation link is incomplete.</p>`);
  try {
    await api('/auth/verify-email', { method: 'POST', body: { token } });
    render(box, html`<h1>Email confirmed</h1><p>Thank you. Your email address is now verified.</p><a class="btn" href="/">Continue</a>`);
  } catch (e) {
    render(box, html`<h1>Link expired</h1><p>${e.message}</p><p class="muted small">Sign in and use "Resend" from your account to get a new link.</p>`);
  }
}
