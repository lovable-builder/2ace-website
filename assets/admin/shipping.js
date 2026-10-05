import { el, clear, kv, pill, toast } from './ui.js';
import { guarded } from './wms.js';

// Shipping connection (Furgonetka). Admin only. "Test connection" logs in, reads the balance and the carrier services. It buys nothing.
export async function render(ctx, root) {
  const out = el('div'), err = el('p', { class: 'err' });
  const test = el('button', { class: 'btn', text: 'Test connection', onclick: () => guarded(test, err, async () => {
    clear(out).append(el('p', { class: 'muted', text: 'Connecting…' }));
    const r = await ctx.api('shipping.test');
    clear(out);
    if (!r.ok) {
      out.append(el('div', { class: 'rule' }, el('b', { text: r.step === 'settings' ? 'Not set up yet' : 'The connection failed' }), el('p', { text: r.error }),
        r.env && el('p', { class: 'muted', text: 'Environment: ' + r.env + (r.status ? ' · HTTP ' + r.status : '') })));
      return;
    }
    const svc = Array.isArray(r.services) ? r.services : [];
    const label = (s) => [s.name || s.service_name || s.label, s.carrier || s.courier || s.service || s.carrier_name].filter(Boolean).join(' · ') || JSON.stringify(s).slice(0, 80);
    const id = (s) => s.id ?? s.service_id ?? s.code ?? '';
    out.append(
      el('div', { class: 'ex' }, el('b', { text: 'Connected' }), el('p', {}, 'Logged in to Furgonetka ', pill(r.env, r.env === 'production' ? 'bad' : 'ok'), r.env === 'production' ? ' This is the LIVE account: real labels cost real money.' : ' This is the test environment: nothing is charged.')),
      el('section', { class: 'card' }, el('h2', { text: 'Balance' }), el('pre', { style: 'margin:0;white-space:pre-wrap', text: JSON.stringify(r.balance, null, 2) })),
      el('section', { class: 'card' }, el('h2', { text: svc.length ? `Carrier services (${svc.length})` : 'Carrier services' }),
        svc.length ? el('ul', {}, svc.map((s) => el('li', {}, id(s) !== '' ? el('code', { text: String(id(s)) }) : null, ' ', label(s)))) : el('p', { class: 'muted', text: 'The account returned no services in a list form. Raw answer below.' }),
        el('details', {}, el('summary', { text: 'Show the raw answer' }), el('pre', { style: 'white-space:pre-wrap;max-height:320px;overflow:auto', text: JSON.stringify(r.services, null, 2) }))));
    toast('Connection works');
  }) });
  clear(root).append(el('h1', { text: 'Shipping' }),
    el('p', { class: 'muted', text: 'The connection to Furgonetka, which buys shipping labels from InPost, DPD, DHL, GLS and more. This test only logs in and reads your balance and the available carrier services. It never buys a label.' }),
    el('div', { class: 'row' }, test), err, out);
}
