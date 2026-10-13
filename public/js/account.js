import { api, mountChrome, onSubmit, $, render, html, errorMessage, t } from './common.js';

export function initForgot() {
  mountChrome();
  onSubmit($('#form'), async (d) => {
    await api('/auth/forgot-password', { method: 'POST', body: { email: d.email } });
    render($('.card'), html`<h1>${t('forgot.checkEmail')}</h1><p>${t('forgot.sent')}</p><a class="btn" href="/login.html">${t('forgot.back')}</a>`);
  });
}

export function initReset() {
  mountChrome();
  const token = new URLSearchParams(location.search).get('token');
  if (!token) { render($('.card'), html`<h1>${t('reset.invalidHead')}</h1><p>${t('reset.invalidText')}</p><a class="btn" href="/forgot-password.html">${t('reset.request')}</a>`); return; }
  onSubmit($('#form'), async (d) => {
    await api('/auth/reset-password', { method: 'POST', body: { token, password: d.password } });
    render($('.card'), html`<h1>${t('reset.doneHead')}</h1><p>${t('reset.doneText')}</p><a class="btn" href="/login.html">${t('nav.signIn')}</a>`);
  });
}

export async function initVerify() {
  mountChrome();
  const token = new URLSearchParams(location.search).get('token');
  const box = $('#result');
  if (!token) return render(box, html`<h1>${t('verify.invalidHead')}</h1><p>${t('verify.invalidText')}</p>`);
  try {
    await api('/auth/verify-email', { method: 'POST', body: { token } });
    render(box, html`<h1>${t('verify.okHead')}</h1><p>${t('verify.okText')}</p><a class="btn" href="/">${t('verify.continue')}</a>`);
  } catch (e) {
    render(box, html`<h1>${t('verify.expiredHead')}</h1><p>${errorMessage(e)}</p><p class="muted small">${t('verify.expiredHint')}</p>`);
  }
}
