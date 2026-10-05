import { el, clear, toast, field } from './ui.js';

// Admin shell: sign-in check, second factor, role-based navigation, hash router. Real authorization is in the database and
// admin-api; hiding menu entries here is only convenience.
const SUPABASE_URL = 'https://hvbcmilcjragrcezwzlo.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh2YmNtaWxjanJhZ3JjZXp3emxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEwNjMyODMsImV4cCI6MjEwNjYzOTI4M30.Q6TlQnDToz2oPr4FXNgKdgdrZT3ojUToCroLRVQGRsw';
const sb = window.supabase.createClient(SUPABASE_URL, ANON);
const V = new URL(import.meta.url).search;            // ?v=N keeps modules in step with this file
const app = document.getElementById('app');

async function api(action, payload) {
  const { data } = await sb.auth.getSession();
  if (!data.session) { location.replace('/login?next=%2Fadmin'); throw new Error('Signed out'); }
  const r = await fetch(SUPABASE_URL + '/functions/v1/admin-api', {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + data.session.access_token },
    body: JSON.stringify({ action, ...(payload || {}) }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(out.error || 'Request failed'), { code: out.error, status: r.status });
  return out;
}

const WH_READ = [['approvals', 'Approvals'], ['orders', 'Orders'], ['inbound', 'Inbound'], ['stock', 'Stock'], ['products', 'Products'], ['discrepancies', 'Discrepancies']];
const NAV = {
  admin: [['', 'Overview'], ['customers', 'Customers'], ['requests', 'Requests'], ['domains', 'Domains'], ...WH_READ, ['locations', 'Locations'], ['staff', 'Staff'], ['audit', 'Audit log'], ['help', 'Help'], ['/scan', 'Scan app ↗']],
  support: [['', 'Overview'], ['customers', 'Customers'], ['requests', 'Requests'], ['domains', 'Domains'], ...WH_READ, ['audit', 'Audit log'], ['help', 'Help']],
  warehouse: [['', 'Overview'], ...WH_READ, ['locations', 'Locations'], ['help', 'Help'], ['/scan', 'Scan app ↗']],
};
const screen = (children) => clear(app).append(el('div', { class: 'center' }, el('div', { class: 'auth-card' }, children)));

// ---------- sign-in extras ----------
async function setPassword(reason) {
  return new Promise((resolve) => {
    const pw = el('input', { type: 'password', autocomplete: 'new-password', minlength: '8' });
    const err = el('p', { class: 'err' });
    screen([el('h1', { text: reason === 'invite' ? 'Welcome to the 2ACE admin' : 'Choose a new password' }), el('p', { class: 'muted', text: 'Set a password (at least 8 characters).' }), field('Password', pw), err,
      el('button', { class: 'btn', text: 'Save password', onclick: async () => {
        if (pw.value.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
        const { error } = await sb.auth.updateUser({ password: pw.value });
        if (error) { err.textContent = error.message; return; }
        history.replaceState(null, '', '/admin'); resolve();
      } })]);
  });
}

async function secondFactor() {
  const { data: f } = await sb.auth.mfa.listFactors();
  const verified = (f?.totp || []).find((x) => x.status === 'verified');
  const code = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '123456' });
  const err = el('p', { class: 'err' });
  if (verified) {
    return new Promise((resolve) => {
      const go = async () => {
        const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: verified.id, code: code.value.trim() });
        if (error) { err.textContent = 'That code did not work. Try the newest one.'; return; }
        await sb.auth.refreshSession(); resolve();
      };
      code.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      screen([el('h1', { text: 'Two-step check' }), el('p', { class: 'muted', text: 'Enter the 6-digit code from your authenticator app.' }), field('Code', code), err, el('button', { class: 'btn', text: 'Continue', onclick: go }), signOutLink()]);
    });
  }
  // First time: remove half-finished attempts, then enroll a new authenticator.
  for (const u of (f?.all || []).filter((x) => x.status === 'unverified')) await sb.auth.mfa.unenroll({ factorId: u.id });
  const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: '2ACE admin ' + new Date().toISOString().slice(0, 10) });
  if (error) { screen([el('h1', { text: 'Could not start setup' }), el('p', { class: 'err', text: error.message }), signOutLink()]); return new Promise(() => {}); }
  return new Promise((resolve) => {
    const go = async () => {
      const { error: e2 } = await sb.auth.mfa.challengeAndVerify({ factorId: data.id, code: code.value.trim() });
      if (e2) { err.textContent = 'That code did not work. Check the time on your phone and try again.'; return; }
      await sb.auth.refreshSession(); resolve();
    };
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    screen([el('h1', { text: 'Set up your authenticator' }),
      el('p', { class: 'muted', text: 'Admin and support accounts need a second step. Scan this code with Google Authenticator, 1Password, Authy or a similar app.' }),
      el('img', { class: 'qr', src: data.totp.qr_code, alt: 'Authenticator QR code' }), el('p', { class: 'muted', text: 'Cannot scan? Enter this key by hand: ' + data.totp.secret }),
      field('Code from the app', code), err, el('button', { class: 'btn', text: 'Finish setup', onclick: go }), signOutLink()]);
  });
}
const signOutLink = () => el('button', { class: 'btn ghost tiny', text: 'Sign out', onclick: async () => { await sb.auth.signOut(); location.replace('/login?next=%2Fadmin'); } });

// ---------- shell + router ----------
async function start() {
  clear(app).append(el('p', { class: 'muted pad', text: 'Loading…' }));
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (['invite', 'recovery'].includes(h.get('type'))) { await sb.auth.getSession(); await setPassword(h.get('type')); }
  const { data: s } = await sb.auth.getSession();
  if (!s.session) return location.replace('/login?next=%2Fadmin');

  let me;
  for (let tries = 0; tries < 3 && !me; tries++) {
    try { me = await api('me'); }
    catch (e) {
      if (e.code === 'mfa_required') { await secondFactor(); continue; }
      if (e.code === 'no_staff_access' || e.code === 'forbidden') return screen([el('h1', { text: 'No access' }), el('p', { class: 'muted', text: 'This account is not part of the 2ACE staff. If you should have access, ask an admin to invite you.' }), signOutLink(), el('a', { class: 'btn ghost tiny', href: '/', text: 'Back to the website' })]);
      if (e.code === 'unauthorized') return location.replace('/login?next=%2Fadmin');
      return screen([el('h1', { text: 'Something went wrong' }), el('p', { class: 'err', text: e.message }), el('button', { class: 'btn', onclick: () => location.reload(), text: 'Try again' })]);
    }
  }
  if (!me) return screen([el('h1', { text: 'Sign-in incomplete' }), el('button', { class: 'btn', onclick: () => location.reload(), text: 'Try again' })]);

  let staff = [];
  if (me.role !== 'warehouse') { try { staff = (await api('staff.directory')).staff; } catch { /* names only */ } }
  const ctx = { sb, api, me, staff, session: {}, go: (r) => { location.hash = r; } };
  const main = el('main', { class: 'main' });
  const nav = el('nav', { class: 'side' }, NAV[me.role].map(([r, label]) => el('a', { href: r.startsWith('/') ? r : '#' + r, 'data-route': r, text: label })));
  clear(app).append(el('div', { class: 'shell' },
    el('header', { class: 'top' }, el('a', { class: 'logo', href: '#', text: '2ACE' }), el('span', { class: 'tag', text: 'admin' }), el('span', { class: 'sp' }),
      el('span', { class: 'who', text: me.email }), el('span', { class: 'pill', text: me.role }), signOutLink()),
    el('div', { class: 'body' }, nav, main)));

  const route = async () => {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const name = parts[0] || '';
    nav.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.route === name));
    if (name && !NAV[me.role].some(([r]) => r === name)) return clear(main).append(el('h1', { text: 'Not available' }), el('p', { class: 'muted', text: 'Your role cannot open this page.' }));
    try {
      const mod = await import(`./${name || 'home'}.js${V}`);
      await mod.render(ctx, main, parts.slice(1));
    } catch (e) { console.error(e); clear(main).append(el('h1', { text: 'Something went wrong' }), el('p', { class: 'err', text: e.message })); }
  };
  addEventListener('hashchange', route); route();
}
start().catch((e) => { console.error(e); screen([el('h1', { text: 'Something went wrong' }), el('p', { class: 'err', text: String(e.message || e) })]); });
