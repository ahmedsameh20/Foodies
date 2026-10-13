import {
  api, session, mountChrome, publicConfig, $, render, html, onSubmit, toast, spinner, emptyState, errorBox, fmtDate, cap, t, has, locKeys,
} from './common.js';

mountChrome({ active: 'help' });
const user = session.user;

publicConfig().then((c) => {
  if (c.whatsappUrl) {
    render($('#whatsapp'), html`<div class="card" style="margin-bottom:1rem"><h2>${t('report.needHelp')}</h2>
      <p class="muted">${t('report.whatsappText')}</p><a class="btn" href="${c.whatsappUrl}" target="_blank" rel="noopener">${t('report.chat')}</a></div>`);
  }
});

async function loadList() {
  render($('#list'), spinner());
  try {
    const { reports } = await api('/support/reports');
    render($('#list'), reports.length ? html`<div class="grid">${reports.map((r) => html`<article class="card">
      <div class="toolbar" style="margin-bottom:.25rem"><strong>${r.subject}</strong><span class="badge nocap ${r.status === 'resolved' || r.status === 'closed' ? 'ok' : 'warn'}">${has(`report.status.${r.status}`) ? t(`report.status.${r.status}`) : cap(r.status)}</span></div>
      <div class="muted small">${has(`report.cat.${r.category}`) ? t(`report.cat.${r.category}`) : cap(r.category)} · ${fmtDate(r.createdAt)}</div>
      ${r.adminResponse ? html`<div class="alert info" style="margin:.75rem 0 0"><strong>${t('report.reply')}</strong> ${r.adminResponse}</div>` : ''}</article>`)}</div>`
      : emptyState(t('report.noneYet'), t('report.noneYetText')));
  } catch (e) { render($('#list'), errorBox(e)); }
}

if (!user) {
  render($('#form').closest('.card'), html`<h2>${t('report.formTitle')}</h2><p>${t('report.signInBefore')} <a href="/login.html?next=/report.html">${t('report.signInLink')}</a> ${t('report.signInAfter')}</p>`);
  $('#list').innerHTML = '';
} else {
  if (user.role === 'customer') {
    api('/me/orders').then(({ orders }) => {
      const sel = $('#orderId');
      for (const o of orders.slice(0, 30)) sel.append(Object.assign(document.createElement('option'), { value: o.id, textContent: `#${o.orderNumber} · ${locKeys(o, 'restaurantNameAr', 'restaurantNameEn', 'restaurantName')}` }));
      const pre = new URLSearchParams(location.search).get('order');
      if (pre) { sel.value = pre; $('#category').value = 'order'; }
    }).catch(() => {});
  } else {
    $('#orderId').closest('.field').classList.add('hidden');
  }
  onSubmit($('#form'), async (d, form) => {
    await api('/support/reports', { method: 'POST', body: { category: d.category, subject: d.subject, description: d.description, orderId: d.orderId || undefined } });
    toast(t('report.sent'), 'ok');
    form.reset();
    loadList();
  });
  loadList();
}
