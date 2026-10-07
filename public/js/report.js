import {
  api, session, mountChrome, publicConfig, $, render, html, raw, onSubmit, toast, spinner, emptyState, errorBox, fmtDate, cap,
} from './common.js';

mountChrome({ active: 'help' });
const user = session.user;

publicConfig().then((c) => {
  if (c.whatsappUrl) {
    render($('#whatsapp'), html`<div class="card" style="margin-bottom:1rem"><h2>Need help right now?</h2>
      <p class="muted">Message our support team on WhatsApp.</p><a class="btn" href="${c.whatsappUrl}" target="_blank" rel="noopener">Chat on WhatsApp</a></div>`);
  }
});

async function loadList() {
  render($('#list'), spinner());
  try {
    const { reports } = await api('/support/reports');
    render($('#list'), reports.length ? html`<div class="grid">${reports.map((r) => html`<article class="card">
      <div class="toolbar" style="margin-bottom:.25rem"><strong>${r.subject}</strong><span class="badge ${r.status === 'resolved' || r.status === 'closed' ? 'ok' : 'warn'}">${cap(r.status)}</span></div>
      <div class="muted small">${cap(r.category)} · ${fmtDate(r.createdAt)}</div>
      ${r.adminResponse ? html`<div class="alert info" style="margin:.75rem 0 0"><strong>Reply from support:</strong> ${r.adminResponse}</div>` : ''}</article>`)}</div>`
      : emptyState('No reports yet', 'Anything you report will show up here with our reply.'));
  } catch (e) { render($('#list'), errorBox(e)); }
}

if (!user) {
  render($('#form').closest('.card'), html`<h2>Report a problem</h2><p>Please <a href="/login.html?next=/report.html">sign in</a> to send a report so we can follow up with you.</p>`);
  $('#list').innerHTML = '';
} else {
  if (user.role === 'customer') {
    api('/me/orders').then(({ orders }) => {
      const sel = $('#orderId');
      for (const o of orders.slice(0, 30)) sel.append(Object.assign(document.createElement('option'), { value: o.id, textContent: `#${o.orderNumber} · ${o.restaurantName}` }));
      const pre = new URLSearchParams(location.search).get('order');
      if (pre) { sel.value = pre; $('#category').value = 'order'; }
    }).catch(() => {});
  } else {
    $('#orderId').closest('.field').classList.add('hidden');
  }
  onSubmit($('#form'), async (d, form) => {
    await api('/support/reports', { method: 'POST', body: { category: d.category, subject: d.subject, description: d.description, orderId: d.orderId || undefined } });
    toast('Report sent. We will get back to you.', 'ok');
    form.reset();
    loadList();
  });
  loadList();
}
