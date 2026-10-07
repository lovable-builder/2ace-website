import { el, clear, kv, pill, toast, field } from './ui.js';
import { guarded, rpc } from './wms.js';

const balanceText = (b) => { const n = b && typeof b.balance === 'number' ? b.balance : null; return n === null ? 'Not shown by Furgonetka' : n.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + (b.currency || 'PLN'); };

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
      el('section', { class: 'card' }, el('h2', { text: 'Balance' }),
        el('p', { style: 'font-size:28px;margin:0;font-weight:600' }, balanceText(r.balance)),
        el('p', { class: 'muted', text: r.env === 'production' ? 'Labels are charged from this balance, one per parcel.' : 'Test money in the sandbox. Nothing here is real.' }),
        el('details', {}, el('summary', { text: 'Show the raw answer' }), el('pre', { style: 'white-space:pre-wrap;max-height:320px;overflow:auto', text: JSON.stringify(r.balance, null, 2) }))),
      el('section', { class: 'card' }, el('h2', { text: svc.length ? `Carrier services (${svc.length})` : 'Carrier services' }),
        svc.length ? el('ul', {}, svc.map((s) => el('li', {}, id(s) !== '' ? el('code', { text: String(id(s)) }) : null, ' ', label(s)))) : el('p', { class: 'muted', text: 'The account returned no services in a list form. Raw answer below.' }),
        el('details', {}, el('summary', { text: 'Show the raw answer' }), el('pre', { style: 'white-space:pre-wrap;max-height:320px;overflow:auto', text: JSON.stringify(r.services, null, 2) }))));
    toast('Connection works');
  }) });
  // The handling fee tariff: what packing one order costs, by the size of the parcel (like Allegro). Everyone on staff reads it, only admins change it.
  const tariff = el('section', { class: 'card' }), isAdmin = ctx.me.role === 'admin';
  const drawTariff = async () => {
    clear(tariff).append(el('h2', { text: 'Handling fee tariff' }), el('p', { class: 'muted', text: 'Loading…' }));
    const [t, r] = await Promise.all([ctx.sb.from('handling_tiers').select('*').order('sort'), ctx.sb.from('billing_rates').select('*')]);
    if (t.error) return clear(tariff).append(el('h2', { text: 'Handling fee tariff' }), el('p', { class: 'err', text: t.error.message }));
    const rates = Object.fromEntries((r.data || []).map((x) => [x.key, Number(x.value)]));
    const rows = (t.data || []).map((x) => ({ ...x }));
    const inp = (v, w = '84px', step = 'any') => el('input', { type: 'number', min: '0', step, value: String(v), style: 'width:' + w });
    const body = el('tbody');
    const draw = () => { clear(body); rows.forEach((x, i) => { const cls = el('input', { value: x.size_class, style: 'width:80px', maxlength: '12', disabled: !isAdmin }), w = inp(x.max_weight_g), sd = inp(x.max_side_cm), h = inp(x.handling_net), ret = inp(x.return_net);
      [[cls, 'size_class'], [w, 'max_weight_g'], [sd, 'max_side_cm'], [h, 'handling_net'], [ret, 'return_net']].forEach(([n, k]) => { n.disabled = !isAdmin; n.addEventListener('input', () => { x[k] = n.value; }); });
      body.append(el('tr', {}, el('td', { 'data-label': 'Class' }, cls), el('td', { 'data-label': 'Up to (g)' }, w), el('td', { 'data-label': 'Longest side up to (cm)' }, sd), el('td', { 'data-label': 'Packing one order (zł net)' }, h), el('td', { 'data-label': 'Handling one return (zł net)' }, ret),
        isAdmin && el('td', {}, el('button', { class: 'btn ghost tiny', text: 'Remove', onclick: () => { rows.splice(i, 1); draw(); } })))); }); };
    const extra = inp(rates.handling_extra_parcel ?? 0, '84px', '0.01'), rextra = inp(rates.return_extra_parcel ?? 0, '84px', '0.01'), err = el('p', { class: 'err' });
    extra.disabled = rextra.disabled = !isAdmin; draw();
    const save = el('button', { class: 'btn', text: 'Save the tariff', onclick: () => guarded(save, err, async () => {
      await rpc(ctx, 'set_handling_tiers', { p_tiers: rows.map((x) => ({ size_class: String(x.size_class).trim(), max_weight_g: Number(x.max_weight_g), max_side_cm: Number(x.max_side_cm), handling_net: Number(x.handling_net), return_net: Number(x.return_net) })), p_rates: { handling_extra_parcel: Number(extra.value), return_extra_parcel: Number(rextra.value) } });
      toast('Tariff saved'); drawTariff(); }) });
    clear(tariff).append(el('h2', { text: 'Handling fee tariff' }),
      el('p', { class: 'muted', text: 'Customers on Fulfilment as you go pay one handling fee per order, set by the size of the packed parcel (its heaviest or longest parcel decides the class). Classes must grow in weight and length. Returns use the second price. A parcel above the biggest class has no tariff: the order is recorded with 0 and you add the charge by hand.' }),
      el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl' }, el('thead', {}, el('tr', {}, ['Class', 'Up to (g)', 'Longest side up to (cm)', 'Packing one order (zł net)', 'Handling one return (zł net)', ''].map((h) => el('th', { text: h })))), body)),
      isAdmin && el('div', { class: 'row' }, el('button', { class: 'btn ghost tiny', text: '+ Add a class', onclick: () => { const l = rows[rows.length - 1] || { max_weight_g: 0, max_side_cm: 0 }; rows.push({ size_class: '', max_weight_g: Number(l.max_weight_g) + 1000, max_side_cm: Number(l.max_side_cm), handling_net: 0, return_net: 0 }); draw(); } })),
      el('div', { class: 'row' }, field('Each further parcel in an order (zł net)', extra), field('Each further parcel in a return (zł net)', rextra)), err, isAdmin && el('div', { class: 'row' }, save),
      el('p', { class: 'muted small', text: 'Prices exclude VAT. A new tariff applies to orders that ship after you save it. The monthly ceiling per m² is set per customer under Customers.' }));
  };
  drawTariff();
  clear(root).append(el('h1', { text: 'Shipping' }),
    el('p', { class: 'muted', text: 'The connection to Furgonetka, which buys shipping labels from InPost, DPD, DHL, GLS and more. This test only logs in and reads your balance and the available carrier services. It never buys a label.' }),
    el('div', { class: 'row' }, test), err, out, tariff);
}
