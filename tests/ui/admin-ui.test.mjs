import { ROOT } from '../lib/root.mjs';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>', { url: 'https://2ace.pl/admin' });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
const base = 'file://' + ROOT + '/assets/admin/';
const ui = await import(base + 'ui.js'); const { el } = ui;
const mods = {}; for (const n of ['home', 'customers', 'requests', 'domains', 'staff', 'audit']) mods[n] = await import(base + n + '.js');
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  -> ' + x : '')); };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const root = () => document.getElementById('root');
const text = () => root().textContent.replace(/\s+/g, ' ');

// ---- fake supabase: tables -> rows, with a thenable chainable query ----
const DB = {};
const mkQuery = (table) => { const f = []; let rows = () => DB[table] || []; let head = false, one = false;
  const q = new Proxy({}, { get(_, k) {
    if (k === 'then') return (res) => { let r = rows().filter((row) => f.every((fn) => fn(row))); if (one) return res({ data: r[0] ?? null, error: null }); return res({ data: head ? null : r, count: r.length, error: null }); };
    return (...a) => { if (k === 'select') { head = !!(a[1] && a[1].head); } else if (k === 'eq') f.push((row) => row[a[0]] === a[1]); else if (k === 'in') f.push((row) => a[1].includes(row[a[0]])); else if (k === 'maybeSingle') one = true; return q; }; } });
  return q; };
const sb = { from: mkQuery, rpc: async (n) => ({ data: DB.__rpc[n], error: null }) };
const calls = [];
const mkCtx = (role) => ({ sb, me: { id: 'u-admin', role, email: role + '@2ace.pl' }, staff: [{ user_id: 'u-admin', email: 'admin@2ace.pl', role: 'admin', active: true }, { user_id: 'u-sup', email: 'sup@2ace.pl', role: 'support', active: true }], session: {}, go: (r) => calls.push(['go', r]), api: async (a, p) => { calls.push([a, p]); if (a === 'staff.list') return { staff: DB.__staff }; if (a === 'domain.retry') return { outcome: 'manual', message: 'Registry says no' }; return { ok: true }; } });
const modalClick = async (label, fill) => { await tick(); const m = document.querySelector('.modal'); if (!m) return false; if (fill) fill(m); [...m.querySelectorAll('button')].find((b) => b.textContent.trim() === label).click(); await tick(); return true; };

DB.organizations = [{ id: 'o1', name: 'Acme Sp z oo', status: 'active', country: 'PL', vat_id: '5251234567', address_line: 'Prosta 1', postal_code: '00-001', city: 'Warszawa', region: 'Mazowieckie', phone: '+48600100200', stripe_customer_id: 'cus_1', created_at: '2026-10-01T10:00:00Z' }];
DB.__rpc = { admin_customers: [
  { org_id: 'o1', name: 'Acme Sp z oo', country: 'PL', status: 'active', created_at: '2026-10-01T10:00:00Z', owner_name: 'Anna Kowalska', owner_email: 'anna@acme.pl', monthly_pln: 4320, plan_status: 'active', sub_status: 'active', domain: 'acme.pl', open_requests: 2 },
  { org_id: 'o2', name: 'Beta GmbH', country: 'DE', status: 'past_due', created_at: '2026-10-02T10:00:00Z', owner_name: 'Bernd', owner_email: 'bernd@beta.de', monthly_pln: 900, plan_status: 'active', sub_status: 'past_due', domain: null, open_requests: 0 }] };
DB.members = [{ org_id: 'o1', user_id: 'u1', role: 'owner' }];
DB.profiles = [{ user_id: 'u1', full_name: 'Anna Kowalska', email: 'anna@acme.pl', phone: '+48600100200' }];
DB.plans = [{ id: 'p1', org_id: 'o1', status: 'active', monthly_pln: 4320, once_pln: 0, created_at: '2026-10-01T10:00:00Z', config: { storageType: 'pallet', qty: 12, pkgs: { ful: true }, storeOn: true } }];
DB.subscriptions = [{ org_id: 'o1', stripe_subscription_id: 'sub_1', status: 'active', current_period_end: '2026-11-01T00:00:00Z', updated_at: '2026-10-01' }];
DB.agreements = [{ org_id: 'o1', signer_name: 'Anna Kowalska', version: '2026-10-v1', ip: '1.2.3.4', signed_at: '2026-10-01T10:00:00Z' }];
DB.domain_orders = [
  { id: 'd1', org_id: 'o1', domain: 'acme.pl', status: 'pending', availability: 'free', auto: false, notes: null, order_ref: null, created_at: '2026-10-03T10:00:00Z', organizations: DB.organizations[0] },
  { id: 'd2', org_id: 'o2', domain: 'beta.pl', status: 'registered', availability: 'free', auto: true, notes: 'ok', created_at: '2026-10-02T10:00:00Z', organizations: { name: 'Beta GmbH' } }];
DB.requests = [
  { id: 'r1', org_id: 'o1', subject: 'Book an inbound delivery', requester_name: 'Anna', requester_email: 'anna@acme.pl', source: 'dashboard', status: 'new', priority: 'high', assignee: null, last_message_at: '2026-10-04T10:00:00Z', created_at: '2026-10-04T10:00:00Z', organizations: { id: 'o1', name: 'Acme Sp z oo' } },
  { id: 'r2', org_id: null, subject: 'Message from the website', requester_name: 'Joe', requester_email: 'joe@x.com', source: 'website', status: 'resolved', priority: 'normal', assignee: 'u-sup', last_message_at: '2026-10-01T10:00:00Z', created_at: '2026-10-01T10:00:00Z', organizations: null }];
DB.request_messages = [{ request_id: 'r1', direction: 'in', body: 'Pallets arrive Friday', created_at: '2026-10-04T10:00:00Z' }, { request_id: 'r1', direction: 'note', author_id: 'u-sup', body: 'Check dock 2', created_at: '2026-10-04T11:00:00Z' }];
DB.audit_log = [{ id: 1, at: '2026-10-04T12:00:00Z', actor_id: 'u-sup', actor_role: 'support', action: 'impersonate_view', entity: 'organizations', reason: 'Support request: call' }, { id: 2, at: '2026-10-04T13:00:00Z', actor_id: 'u-admin', actor_role: 'admin', action: 'org.set_status', entity: 'organizations', reason: 'fixed typo' }];
DB.__staff = [{ user_id: 'u-admin', email: 'admin@2ace.pl', role: 'admin', active: true, created_at: '2026-10-01' }, { user_id: 'u-sup', email: 'sup@2ace.pl', role: 'support', active: true, created_at: '2026-10-02' }];

const mount = async (name, role, params) => { document.body.innerHTML = '<div id="root"></div>'; calls.length = 0; const c = mkCtx(role); await mods[name].render(c, root(), params); await tick(); return c; };

// home
DB.requests_count = 0; await mount('home', 'admin'); ok('home shows stat cards', document.querySelectorAll(".stat").length === 12, text().slice(0, 90));
// customers list
let c = await mount('customers', 'support'); ok('customers lists both companies', /Acme Sp z oo/.test(text()) && /Beta GmbH/.test(text()));
const search = root().querySelector('input[type=search]'); search.value = 'bernd'; search.dispatchEvent(new window.Event('input')); await tick();
ok('search filters by owner email', /Beta GmbH/.test(text()) && !/Acme Sp z oo/.test(text()));
search.value = ''; search.dispatchEvent(new window.Event('input')); const stSel = root().querySelector('select'); stSel.value = 'past_due'; stSel.dispatchEvent(new window.Event('change')); await tick();
ok('status filter works', /Beta GmbH/.test(text()) && !/Acme Sp z oo/.test(text()));
stSel.value = ''; stSel.dispatchEvent(new window.Event('change')); await tick(); [...root().querySelectorAll('tbody tr')][0].click(); ok('clicking a customer navigates to its detail', calls.some((x) => x[0] === 'go' && x[1] === 'customers/o1'), JSON.stringify(calls.at(-1)));
// customer detail: reason is demanded and audited
document.body.innerHTML = '<div id="root"></div>'; calls.length = 0; c = mkCtx('support'); const p = mods.customers.render(c, root(), ['o1']); await tick();
const noReason = await modalClick('Continue'); ok('opening a customer asks for a reason first', noReason && /Please give a reason/.test(document.querySelector('.modal')?.textContent || ''));
await modalClick('Continue', (m) => { m.querySelector('select').value = 'Support request'; }); await p; await tick(50);
ok('reason is sent to the audit endpoint', calls.some((x) => x[0] === 'viewas.start' && x[1].org_id === 'o1' && /Support request/.test(x[1].reason)), JSON.stringify(calls[0]));
ok('detail shows company, owner, plan, agreement', /Prosta 1/.test(text()) && /Anna Kowalska/.test(text()) && /14\.4 m² \+ fulfillment \(flat\), storefront/.test(text()) && /2026-10-v1/.test(text()), text().slice(0, 140));
ok('support cannot change customer status', !/Change status/.test(text()));
calls.length = 0; await mods.customers.render(c, root(), ['o1']); await tick(50); ok('reason asked only once per customer per session', !document.querySelector('.modal') && !calls.some((x) => x[0] === 'viewas.start'));
c = mkCtx('admin'); c.session['opened:o1'] = true; await mods.customers.render(c, root(), ['o1']); await tick(50); ok('admin sees Change status', /Change status/.test(text()));
[...root().querySelectorAll('button')].find((b) => b.textContent === 'Change status').click(); await tick();
await modalClick('Save', (m) => { m.querySelector('select').value = 'past_due'; m.querySelector('textarea').value = 'Payment failed twice'; });
ok('status change goes through the API with a reason', calls.some((x) => x[0] === 'org.setStatus' && x[1].status === 'past_due' && x[1].reason === 'Payment failed twice'));
// requests
c = await mount('requests', 'support'); ok('requests default view hides resolved', /Book an inbound delivery/.test(text()) && !/Message from the website/.test(text()));
const rsel = root().querySelector('select'); rsel.value = ''; rsel.dispatchEvent(new window.Event('change')); await tick(); ok('"All" shows resolved too', /Message from the website/.test(text()));
await mods.requests.render(c, root(), ['r1']); await tick(50);
ok('thread shows customer message, internal note labelled, customer details', /Pallets arrive Friday/.test(text()) && /Internal note/.test(text()) && /Check dock 2/.test(text()) && /sup@2ace.pl/.test(text()));
const body = root().querySelector('textarea'); body.value = 'Dock 2, Friday 10:00 is booked.'; calls.length = 0;
[...root().querySelectorAll('button')].find((b) => b.textContent === 'Send').click(); await tick(50);
ok('reply is sent by email via the API', calls.some((x) => x[0] === 'request.message' && x[1].kind === 'reply' && /Dock 2/.test(x[1].body) && x[1].request_id === 'r1'), JSON.stringify(calls.find((x) => x[0] === 'request.message')));
const selects = [...root().querySelectorAll('select')]; const status = selects[0]; status.value = 'resolved'; calls.length = 0; status.dispatchEvent(new window.Event('change')); await tick(); ok('status change calls request.update', calls.some((x) => x[0] === 'request.update' && x[1].status === 'resolved'));
const assign = selects[2]; assign.value = 'u-sup'; calls.length = 0; assign.dispatchEvent(new window.Event('change')); await tick(); ok('assign calls request.update with the assignee', calls.some((x) => x[0] === 'request.update' && x[1].assignee === 'u-sup'));
// domains
c = await mount('domains', 'support'); ok('domain queue defaults to pending only', /acme\.pl/.test(text()) && !/beta\.pl/.test(text()));
await mods.domains.render(c, root(), ['d1']); await tick(50);
ok('domain detail lists registrant data with copy buttons', /Marszalkowska|Prosta 1/.test(text()) && /Mazowieckie/.test(text()) && /5251234567/.test(text()) && root().querySelectorAll('button').length > 8);
calls.length = 0; [...root().querySelectorAll('button')].find((b) => b.textContent === 'Mark registered').click(); const asked = await modalClick('Mark registered'); await tick(50);
ok('marking registered asks to confirm, then calls the API', asked && calls.some((x) => x[0] === 'domain.update' && x[1].status === 'registered' && x[1].id === 'd1'));
calls.length = 0; [...root().querySelectorAll('button')].find((b) => /Retry automatic/.test(b.textContent))?.click(); await tick(50); ok('retry automatic registration calls the API', calls.some((x) => x[0] === 'domain.retry' && x[1].id === 'd1'));
// staff
c = await mount('staff', 'admin'); ok('staff screen lists staff and has an invite form', /admin@2ace.pl/.test(text()) && /Add a team member/.test(text()));
const rowSelf = [...root().querySelectorAll('tbody tr')].find((r) => /admin@2ace.pl/.test(r.textContent)); ok('you cannot deactivate yourself', !/Deactivate/.test(rowSelf.textContent) && /you/.test(rowSelf.textContent));
const mail = root().querySelector('input[type=email]'); mail.value = 'new@2ace.pl'; calls.length = 0; [...root().querySelectorAll('button')].find((b) => b.textContent === 'Invite').click(); await tick(50);
ok('invite sends email + role', calls.some((x) => x[0] === 'staff.invite' && x[1].email === 'new@2ace.pl' && x[1].role === 'support'));
calls.length = 0; [...root().querySelectorAll('button')].find((b) => b.textContent === 'Deactivate').click(); await modalClick('Deactivate'); await tick(50);
ok('deactivating asks to confirm then calls the API', calls.some((x) => x[0] === 'staff.update' && x[1].active === false && x[1].user_id === 'u-sup'));
// audit
c = await mount('audit', 'support'); ok('audit log shows who did what and why', /impersonate_view/.test(text()) && /sup@2ace.pl/.test(text()) && /Support request: call/.test(text()));
const aq = root().querySelector('input[type=search]'); aq.value = 'typo'; aq.dispatchEvent(new window.Event('input')); await tick(); ok('audit filter works', /org.set_status/.test(text()) && !/impersonate_view/.test(text()));
// XSS safety
DB.requests[0].subject = '<img src=x onerror=alert(1)>'; DB.request_messages[0].body = '<script>alert(2)</script>'; await mount('requests', 'support', ['r1']);
ok('customer-supplied text is never interpreted as HTML', !root().querySelector('img') && !root().querySelector('script') && /<script>alert\(2\)<\/script>/.test(text()));
// ---- shipping and fulfilment settings on a customer ----
DB.__rpc.my_fulfil_mode = 'payg'; DB.org_shipping_settings = []; DB.shipping_charges = [{ org_id: 'o1', net: 13, status: 'pending', env: 'production' }, { org_id: 'o1', net: 2.5, status: 'queued', env: 'production' }];
c = mkCtx('support'); c.session['opened:o1'] = true; await mods.customers.render(c, root(), ['o1']); await tick(50);
ok('the customer page shows the fulfilment mode in words, the default markup, and what is waiting to be invoiced', /Shipping and fulfilment/.test(text()) && /Fulfilment as you go \(they prepare labels\)/.test(text()) && /Default/.test(text()) && /15 zł net|16 zł net|15,5 zł net|zł net/.test(text()) && !/set by an admin/.test(text()), text().slice(text().indexOf('Shipping and fulfilment'), text().indexOf('Shipping and fulfilment') + 300));
ok('support can read the settings but not edit them', ![...root().querySelectorAll('button')].some((b) => b.textContent === 'Edit'));
DB.org_shipping_settings = [{ org_id: 'o1', markup_percent: 25, exposure_cap_net: 450, daily_label_cap: 6, label_buying_enabled: true, fulfil_mode_override: 'full' }];
c = mkCtx('admin'); c.session['opened:o1'] = true; await mods.customers.render(c, root(), ['o1']); await tick(50);
ok('an admin sees the real settings, and that the mode was set by hand', /25 %/.test(text()) && /May buy labels themselvesYes/.test(text()) && /450 zł net/.test(text()) && /set by an admin, not the plan/.test(text()) && !![...root().querySelectorAll('button')].find((b) => b.textContent === 'Edit'));
[...root().querySelectorAll('button')].find((b) => b.textContent === 'Edit').click(); await tick(40);
{ const m = document.querySelector('.modal'); const sel = m.querySelector('select'); ok('the form starts with the current values', sel.value === 'full' && m.querySelectorAll('input[type=number]')[0].value === '25' && m.querySelectorAll('input[type=number]')[1].value === '450' && m.querySelector('input[type=checkbox]').checked === true); }
calls.length = 0; await modalClick('Save', (m) => { m.querySelector('select').value = ''; const n = m.querySelectorAll('input[type=number]'); n[0].value = ''; n[1].value = '300'; n[2].value = '8'; m.querySelector('input[type=checkbox]').checked = false; }); await tick(80);
const sv = calls.find((x) => x[0] === 'org.setShipping');
ok('saving sends the whole patch: the mode override cleared, the markup back to default, the caps and the switch', sv && sv[1].org_id === 'o1' && sv[1].patch.fulfil_mode_override === '' && sv[1].patch.markup_percent === '' && sv[1].patch.exposure_cap_net === 300 && sv[1].patch.daily_label_cap === 8 && sv[1].patch.label_buying_enabled === false, JSON.stringify(sv));

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
