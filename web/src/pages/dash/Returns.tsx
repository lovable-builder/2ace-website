import { useEffect, useRef, useState } from 'react';
import { useLang } from '../../i18n';
import { useAccount } from '../../state/account';
import { useWarehouse, type Return } from '../../state/warehouse';
import { errText, rpc } from '../../lib/api';
import { shipping, type Bought, type Caps, type Pending } from '../../lib/shipping';
import { dayMonth, money } from '../../lib/format';
import { tariffText, useTariff } from '../../lib/tariff';
import { ErrLine, Field, Note } from '../../ui';
import { boughtText, OfferRow, offersNote, parcelBody, parcelComplete, ParcelFields, type Offer, type ParcelInput } from './shared';
import { leave } from '../../lib/nav';

// i18n
const STATUS: Record<string, [string, string]> = {
  announced: ['Announced. Issue the label, or wait for the parcel.', 'text-warn'], label_issued: ['Label issued, on its way to us', 'text-warn'],
  received: ['Received, being inspected', 'text-warn'], graded: ['Done', 'text-ok'], cancelled: ['Cancelled', 'text-muted'],
};
// i18n
const KIND: Record<string, string> = { label: 'Shipping label', adjustment: 'Shipping adjustment', handling: 'Handling fee', return_handling: 'Return handling fee', return_label: 'Return label', credit: 'Credit' };
// i18n
const CHARGE_STATUS: Record<string, string> = { pending: 'On your next invoice', queued: 'On your invoice', invoiced: 'On your invoice', paid: 'Paid', test: 'Test, not billed', void: 'Cancelled' };
const EMPTY_FORM = { order: '', name: '', phone: '', email: '', line1: '', postal: '', city: '', country: 'PL', reason: '' };

// Buyers send goods back to our warehouse. The customer announces the return, issues the label (carrier price plus a small fee, on
// their invoice), and follows it until it is inspected and back on the shelf.
export function Returns() {
  const { t, lang } = useLang();
  const { orgId } = useAccount();
  const w = useWarehouse();
  const tariff = useTariff();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(EMPTY_FORM);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState('');

  const shipped = w.orders.filter((o) => o.status === 'shipped');
  const chosen = w.orders.find((o) => o.id === f.order);
  const reset = () => { setF(EMPTY_FORM); setQty({}); setErr(''); };
  const pickOrder = (id: string) => {
    const o = w.orders.find((x) => x.id === id);
    setQty({}); setErr('');
    if (!o) return setF(EMPTY_FORM);
    setF({ order: id, name: o.ship_name || '', phone: o.ship_phone || '', email: o.ship_email || '', line1: [o.ship_line1, o.ship_line2].filter(Boolean).join(' '), postal: o.ship_postal || '', city: o.ship_city || '', country: o.ship_country || 'PL', reason: '' });
  };
  const set = (k: keyof typeof f, upper = false) => (e: React.ChangeEvent<HTMLInputElement>) => { setF({ ...f, [k]: upper ? e.target.value.toUpperCase().slice(0, 2) : e.target.value }); setErr(''); };

  const announce = async () => {
    if (busy) return;
    if (!chosen) return setErr(t('Choose the order the goods are coming back from.'));
    const lines = (chosen.order_lines || []).map((l) => ({ product_id: l.product_id, qty: parseInt(qty[l.product_id], 10) || 0 })).filter((l) => l.qty > 0);
    if (!lines.length) return setErr(t('Enter how many of each product are coming back.'));
    setBusy(true); setErr('');
    try {
      const r = await rpc<{ ref: string }>('create_return', { p_org: orgId, p_order: f.order, p_buyer: { name: f.name, phone: f.phone, email: f.email, line1: f.line1, postal: f.postal, city: f.city, country: f.country }, p_reason: f.reason, p_lines: lines });
      setOpen(false); reset();
      w.setNote(t('Return {ref} announced. Issue its label below, or wait for the parcel to arrive.', { ref: r.ref })); void w.reload();
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };
  const cancel = async (r: Return) => {
    if (!window.confirm(t('Cancel return {ref}?', { ref: r.ref }))) return;
    try { await rpc('cancel_return', { p_return: r.id }); w.setNote(t('Return {ref} cancelled.', { ref: r.ref })); w.setErr(''); void w.reload(); }
    catch (e) { w.setNote(''); w.setErr(errText(e)); }
  };
  const grade = (l: NonNullable<Return['return_lines']>[number]) => l.received_qty == null ? '' : Number(l.received_qty) === 0 ? t('nothing came back')
    : l.grade === 'A' ? t('{n} back on your shelf', { n: Number(l.received_qty) }) : t('{n} set aside (damaged, not sellable)', { n: Number(l.received_qty) }) + (l.note ? ': ' + l.note : '');

  return (
    <div className="stack narrow">
      <div className="spread">
        <h1 className="h1">{t('Returns')}</h1>
        <button className={'btn' + (open ? ' ghost' : '')} onClick={() => { setOpen(!open); reset(); }}>{open ? t('Cancel') : t('New return')}</button>
      </div>
      <p className="small">{t('Your buyer sends goods back to our warehouse. You announce the return here, issue the return label yourself (the carrier price plus a small fee, on your invoice), and we inspect, grade and restock within 48 hours. Returns are pay as you go: {fee}, on your monthly invoice.', { fee: tariffText(tariff, 'return', t) })}</p>
      <Note text={w.note} onClear={() => w.setNote('')} />
      <ErrLine text={w.err} />
      {open ? (
        <div className="card stack-sm">
          <span className="h3">{t('New return')}</span>
          <Field label={t('The order the goods came from')}>
            <select value={f.order} onChange={(e) => pickOrder(e.target.value)}>
              <option value="">{shipped.length ? t('Choose a shipped order') : t('No shipped orders yet')}</option>
              {shipped.map((o) => <option key={o.id} value={o.id}>{o.ref + ' · ' + o.ship_name + ', ' + o.ship_city}</option>)}
            </select>
          </Field>
          {chosen ? (
            <div className="stack-sm">
              <span className="label">{t('How many of each are coming back')}</span>
              {(chosen.order_lines || []).map((l) => (
                <div className="spread" key={l.product_id}>
                  <span>{t('{sku} · {name} (ordered {qty})', { sku: l.products.sku, name: l.products.name, qty: l.qty })}</span>
                  <input className="input" style={{ width: 90 }} type="number" min={0} aria-label={t('Units coming back')} value={qty[l.product_id] || ''} onChange={(e) => { setQty({ ...qty, [l.product_id]: e.target.value }); setErr(''); }} />
                </div>
              ))}
              <span className="label">{t('Who sends it (the label is made for this address)')}</span>
              <Field label={t('First name and surname')} value={f.name} onChange={set('name')} />
              <div className="grid-2">
                <Field label={t('Phone, required')} inputMode="tel" value={f.phone} onChange={set('phone')} />
                <Field label={t('Email, optional')} type="email" value={f.email} onChange={set('email')} />
              </div>
              <Field label={t('Street and number')} value={f.line1} onChange={set('line1')} />
              <div className="grid-addr">
                <Field label={t('Postal code')} value={f.postal} onChange={set('postal')} />
                <Field label={t('City')} value={f.city} onChange={set('city')} />
                <Field label={t('Country')} maxLength={2} value={f.country} onChange={set('country', true)} />
              </div>
              <Field label={t('Why is it coming back? Optional')} value={f.reason} onChange={set('reason')} />
            </div>
          ) : null}
          <ErrLine text={err} />
          <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={announce} disabled={busy}>{busy ? t('Saving…') : t('Announce the return')}</button>
        </div>
      ) : null}
      {!w.returns.length && !open && w.loaded ? (
        <div className="card stack-sm">
          <span className="h3">{t('No returns yet')}</span>
          <p className="sub">{t('When a buyer sends something back, announce it here, issue the label, and follow it until it is inspected and back on your shelf.')}</p>
        </div>
      ) : null}
      {w.returns.length ? (
        <div className="list">
          {w.returns.map((r) => {
            const st = STATUS[r.status] ?? [r.status, ''];
            return (
              <div className="item" key={r.id}>
                <div className="head"><strong>{r.ref}</strong><span className={'status ' + st[1]}>{t(st[0])}</span></div>
                <span className="meta">{r.buyer_name}, {r.buyer_city} · {dayMonth(r.created_at, lang)}</span>
                <span>{(r.return_lines || []).map((l) => l.products.sku + ' × ' + l.qty).join(', ')}</span>
                {r.status === 'graded' ? <span>{(r.return_lines || []).map((l) => l.products.sku + ': ' + grade(l)).join('. ') + '.' + (r.fee_mode === 'payg' ? ' ' + t('A handling fee for this return is on your next invoice.') : '')}</span> : null}
                <div className="row">
                  {['announced', 'label_issued'].includes(r.status) ? <button className="btn ghost small" aria-expanded={sel === r.id} onClick={() => setSel(sel === r.id ? '' : r.id)}>{sel === r.id ? t('Hide label') : r.status === 'label_issued' ? t('Return label') : t('Issue the return label')}</button> : null}
                  {r.status === 'announced' ? <button className="btn ghost small" onClick={() => cancel(r)}>{t('Cancel')}</button> : null}
                </div>
                {sel === r.id ? <ReturnLabel r={r} /> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {w.charges.length ? (
        <div className="card stack-sm">
          <span className="h3">{t('Usage charges on your account')}</span>
          <p className="small">{t('Shipping labels, handling fees and return fees are added to your monthly invoice. Amounts exclude VAT.')}</p>
          {w.charges.slice(0, 30).map((c, i) => (
            <div className="kv" key={i} style={{ fontFamily: 'var(--sans)' }}>
              <span>{dayMonth(c.at, lang)} · {t(KIND[c.kind] ?? c.kind)}{c.size_class && c.size_class !== 'oversize' ? ' ' + t('(class {c})', { c: c.size_class }) : ''}{c.note ? ': ' + c.note : ''}{c.order_ref || c.return_ref ? ' · ' + (c.order_ref || c.return_ref) : ''}</span>
              <span><strong>{t('{price} + VAT', { price: money(c.net) })}</strong> · {t(CHARGE_STATUS[c.status] ?? c.status)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const NO_PARCEL: ParcelInput = { kg: '', l: '', w: '', h: '' };

function ReturnLabel({ r }: { r: Return }) {
  const t = useLang().t;
  const w = useWarehouse();
  const [caps, setCaps] = useState<Caps | null>(null);
  const [label, setLabel] = useState<Bought | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [parcel, setParcelState] = useState<ParcelInput>(NO_PARCEL);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [offersMsg, setOffersMsg] = useState('');
  const [quoting, setQuoting] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const setParcel = (x: Partial<ParcelInput>) => { setParcelState((p) => ({ ...p, ...x })); setOffers([]); setOffersMsg(''); setErr(''); };
  const status = () => shipping<{ label?: Bought | null }>({ action: 'return.status', return_id: r.id });

  useEffect(() => {
    Promise.all([shipping<Caps>({ action: 'capabilities' }), status()])
      .then(([c, i]) => { if (live.current) { setCaps(c); setLabel(i.label ?? null); setBusy(false); } })
      .catch((e) => { if (live.current) { setBusy(false); setErr(t(errText(e))); } });
  }, [r.id]); // once per return

  const quote = async () => {
    if (quoting || busy) return;
    if (!parcelComplete(parcel)) { setErr(t('Enter the weight and the three sizes of the parcel.')); setNote(''); return; }
    setQuoting(true); setErr(''); setNote(''); setOffers([]); setOffersMsg('');
    try { const x = await shipping<{ offers?: Offer[]; enabled?: boolean }>({ action: 'return.quote', return_id: r.id, parcels: parcelBody(parcel) }); const o = offersNote(x, t); setOffers(o.ok); setOffersMsg(o.note); }
    catch (e) { setErr(t(errText(e))); }
    finally { setQuoting(false); }
  };
  const buy = async (q: Offer) => {
    if (busy) return;
    if (!window.confirm(t('Buy the {name} return label for {net} + VAT ({gross} with VAT)? It is added to your next invoice and cannot be undone here.', { name: q.name, net: money(q.bill_net), gross: money(q.bill_gross) }))) return;
    setBusy(true); setErr(''); setNote('');
    try {
      const x = await shipping<Pending>({ action: 'return.buy', return_id: r.id, service_id: q.service_id, parcels: parcelBody(parcel), expected_bill_net: q.bill_net });
      if (x.pending) { setNote(x.message || ''); return; }
      const i = await status();
      setOffers([]); setLabel(i.label ?? null); setNote(t('Return label bought. Download it and send it to your buyer.')); void w.reload();
    } catch (e) { setErr(t(errText(e))); }
    finally { setBusy(false); }
  };
  const download = async () => {
    if (busy) return;
    setBusy(true); setErr(''); setNote('');
    try { const x = await shipping<Pending & { url?: string }>({ action: 'return.label', return_id: r.id }); if (x.pending) setNote(x.message || ''); else if (x.url) leave.open(x.url); }
    catch (e) { setErr(t(errText(e))); }
    finally { setBusy(false); }
  };

  const canBuy = !!caps?.buy_return_label && r.status === 'announced' && !label;
  return (
    <div className="panel">
      {err ? <span className="errline" role="alert">{err}</span> : null}
      {note ? <span className="okbox" role="status">{note}</span> : null}
      {caps && !caps.buy_return_label && r.status === 'announced' ? <span className="small">{t('Return labels are not open for your account yet. Ask us, or send the goods back yourself.')}</span> : null}
      {label ? (
        <div className="stack-sm">
          <span>{boughtText(label, t, true)}</span>
          <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={download} disabled={busy}>{t('Download the label')}</button>
        </div>
      ) : null}
      {canBuy ? (
        <div className="stack-sm">
          <span className="small"><strong>{t('Issue the return label.')}</strong> {t('The carrier collects from your buyer\'s address and delivers to our warehouse. Enter the packed parcel.')}</span>
          <ParcelFields p={parcel} set={setParcel} />
          <button className="btn dark small" style={{ alignSelf: 'flex-start' }} onClick={quote} disabled={quoting || busy}>{quoting ? t('Asking the carriers…') : t('Get prices')}</button>
          {offers.length || offersMsg ? (
            <div className="stack-sm">
              {offers.map((q) => <OfferRow key={String(q.service_id)} q={q} busy={busy} onBuy={() => void buy(q)} />)}
              {offersMsg ? <span className="small">{offersMsg}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
