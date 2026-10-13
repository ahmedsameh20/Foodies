import { session, homeFor, $, t } from './common.js';

const u = session.user;
$('#home').href = homeFor(u);
if (!u) $('#home').textContent = t('nav.signIn');
