import { session, homeFor, $ } from './common.js';

const u = session.user;
$('#home').href = homeFor(u);
if (!u) $('#home').textContent = 'Sign in';
