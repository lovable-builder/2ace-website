import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { useAccount } from '../../state/account';
import { useWarehouse, type Order } from '../../state/warehouse';
import { errText, upload, uuid } from '../../lib/api';
import { shipping, type Caps, type OrderShipInfo, type Pending } from '../../lib/shipping';
import { money } from '../../lib/format';
import { boughtText, OfferRow, offersNote, parcelBody, parcelComplete, ParcelFields, type Offer, type ParcelInput } from './shared';
import { leave } from '../../lib/nav';

const NO_PARCEL: ParcelInput = { kg: '', l: '', w: '', h: '' };

// How one order is shipped: buy the label with 2ACE (carrier price plus our fee, on the monthly invoice) or attach your own.
export function OrderShipping({ order }: { order: Order }) {
  const t = useT();
  const { orgId } = useAccount();
  const w = useWarehouse();
  const id = order.id;
  const [caps, setCaps] = useState<Caps | null>(null);
  const [info, setInfo] = useState<OrderShipInfo | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [parcel, setParcelState] = useState<ParcelInput>(NO_PARCEL);
  const [suggestNote, setSuggestNote] = useState('');
  const [offers, setOffers] = useState<Offer[]>([]);
  const [offersMsg, setOffersMsg] = useState('');
  const [quoting, setQuoting] = useState(false);
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const file = useRef<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const parcelRef = useRef(parcel); parcelRef.current = parcel;
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  // Changing the parcel clears the prices: a price is never shown for another parcel.
  const setParcel = (x: Partial<ParcelInput>) => { setParcelState((p) => ({ ...p, ...x })); setOffers([]); setOffersMsg(''); setErr(''); };

  const refresh = async () => {
    const [c, i] = await Promise.all([shipping<Caps>({ action: 'capabilities' }), shipping<OrderShipInfo>({ action: 'status', order_id: id })]);
    if (!live.current) return;
    setCaps(c); setInfo(i); setBusy(false);
    const own = i.own_label;
    if (!i.bought_label && !own && i.last_failed) setErr(t('The last attempt failed and nothing was charged: {why}', { why: i.last_failed }));
    if (own) { setCarrier(own.carrier || ''); setTracking((own.tracking_numbers || []).join(', ')); }
    // When buying is open, start the parcel from the sizes of the products on the order. Only a suggestion.
    if (c.buy_label && !i.bought_label && !own && parcelRef.current.kg === '') {
      try {
        const sg = await shipping<{ parcel?: { weight_kg?: number | null; length_cm?: number | null; width_cm?: number | null; height_cm?: number | null }; note?: string }>({ action: 'suggest', order_id: id });
        if (!live.current || parcelRef.current.kg !== '') return;
        const p = sg.parcel || {}, s = (v: number | null | undefined) => (v == null ? '' : String(v));
        setParcelState({ kg: p.weight_kg == null ? '' : String(p.weight_kg).replace('.', ','), l: s(p.length_cm), w: s(p.width_cm), h: s(p.height_cm) });
        setSuggestNote(sg.note || '');
      } catch { /* the customer can type the parcel */ }
    }
  };
  useEffect(() => { refresh().catch((e) => { if (live.current) { setBusy(false); setErr(t(errText(e))); } }); }, [id]); // once per order

  const quote = async () => {
    if (quoting || busy) return;
    if (!parcelComplete(parcel)) { setErr(t('Enter the weight and the three sizes of the parcel.')); setNote(''); return; }
    setQuoting(true); setErr(''); setNote(''); setOffers([]); setOffersMsg('');
    try { const r = await shipping<{ offers?: Offer[]; enabled?: boolean }>({ action: 'quote', order_id: id, parcels: parcelBody(parcel) }); const o = offersNote(r, t); setOffers(o.ok); setOffersMsg(o.note); }
    catch (e) { setErr(t(errText(e))); }
    finally { setQuoting(false); }
  };
  const buy = async (q: Offer) => {
    if (busy) return;
    if (!window.confirm(t('Buy the {name} label for {net} + VAT ({gross} with VAT)? It is added to your next invoice and cannot be undone here.', { name: q.name, net: money(q.bill_net), gross: money(q.bill_gross) }))) return;
    setBusy(true); setErr(''); setNote('');
    try {
      const r = await shipping<Pending>({ action: 'buy', order_id: id, service_id: q.service_id, parcels: parcelBody(parcel), expected_bill_net: q.bill_net });
      if (r.pending) { setBusy(false); setNote(r.message || ''); return; }
      await refresh();
      setOffers([]); setNote(t('Label bought. We will pack your order and send it with this label.'));
      w.patchOrder(id, { label_source: '2ace' });
    } catch (e) { setErr(t(errText(e))); }
    finally { setBusy(false); }
  };
  const download = async () => {
    if (busy) return;
    setBusy(true); setErr(''); setNote('');
    try {
      const r = await shipping<Pending & { url?: string }>({ action: 'label', order_id: id });
      if (r.pending) setNote(r.message || '');
      else if (r.url) leave.open(r.url);
    } catch (e) { setErr(t(errText(e))); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (busy) return;
    const f = file.current, tr = tracking.trim();
    if (!f && !tr) { setErr(t('Add the label file, or at least a tracking number.')); setNote(''); return; }
    if (f && !(f.type === 'application/pdf' || /\.pdf$/i.test(f.name))) { setErr(t('The label must be a PDF file.')); setNote(''); return; }
    if (f && f.size > 2 * 1024 * 1024) { setErr(t('The label file must be at most 2 MB.')); setNote(''); return; }
    setBusy(true); setErr(''); setNote('');
    try {
      let path: string | null = null;
      if (f) {
        path = orgId + '/' + id + '/' + uuid() + '.pdf';
        if (!(await upload('labels', path, f, 'application/pdf'))) throw new Error(t('The label could not be uploaded. Use a PDF under 2 MB.'));
      }
      await shipping({ action: 'own_label.attach', order_id: id, path, filename: f ? f.name : null, tracking: tr, carrier: carrier.trim() || null });
      file.current = null; if (fileInput.current) fileInput.current.value = '';
      await refresh();
      setNote(t('Saved. We will print this label and use it when we pack your order.'));
      w.patchOrder(id, { label_source: 'own' });
    } catch (e) { setErr(t(errText(e))); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (busy) return;
    setBusy(true); setErr(''); setNote('');
    try {
      await shipping({ action: 'own_label.remove', order_id: id });
      await refresh();
      setNote(t('Label removed.')); setCarrier(''); setTracking('');
      w.patchOrder(id, { label_source: null });
    } catch (e) { setErr(t(errText(e))); }
    finally { setBusy(false); }
  };

  const own = info?.own_label ?? null, bl = info?.bought_label ?? null;
  const canBuy = !!caps?.buy_label;
  const intro = busy && !caps ? t('Checking…') : !caps ? '' : caps.mode === 'payg'
    ? (caps.buy_label ? t('You prepare the label yourself: buy it here with 2ACE, or add your own.') : t('You prepare the label yourself. Buying a label with 2ACE is coming soon; for now, add your own label here.'))
    : t('Your plan does not include fulfilment, so we do not ship orders for you. Add Fulfilment to your plan to use this.');

  return (
    <div className="panel" aria-label={t('How is this order shipped?')}>
      <strong>{t('How is this order shipped?')}</strong>
      {intro ? <span className="small">{intro}</span> : null}
      {err ? <span className="errline" role="alert">{err}</span> : null}
      {note ? <span className="okbox" role="status">{note}</span> : null}
      {canBuy && !(own && !bl) ? (
        <div className="stack-sm">
          <span className="small"><strong>{t('Ship with 2ACE.')}</strong> {t('We buy the label from the carrier you choose. You pay the carrier price plus our fee, on your monthly invoice (VAT is added).')}</span>
          {bl ? (
            <div className="stack-sm">
              <span>{boughtText(bl, t)}</span>
              <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={download} disabled={busy}>{t('Download the label')}</button>
            </div>
          ) : (
            <div className="stack-sm">
              {suggestNote ? <span className="small">{suggestNote}</span> : null}
              <ParcelFields p={parcel} set={setParcel} />
              <span className="small">{t('Enter the packed parcel. If the real parcel is larger or heavier when we pack it, the carrier may charge extra and we add it to your invoice.')}</span>
              <button className="btn dark small" style={{ alignSelf: 'flex-start' }} onClick={quote} disabled={quoting || busy}>{quoting ? t('Asking the carriers…') : t('Get prices')}</button>
              {offers.length || offersMsg ? (
                <div className="stack-sm">
                  {offers.map((q) => <OfferRow key={String(q.service_id)} q={q} busy={busy} onBuy={() => void buy(q)} />)}
                  {offersMsg ? <span className="small">{offersMsg}</span> : null}
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
      {caps?.own_label && !bl ? (
        <div className="stack-sm">
          <span className="small"><strong>{t('I provide my own label.')}</strong> {t('Upload the PDF from Allegro, InPost, your carrier or marketplace. We print it and put it on the parcel. There is no shipping charge from us.')}</span>
          {own ? <span className="small">{t('Current label:')} {[own.filename || t('tracking only'), own.carrier, (own.tracking_numbers || []).join(', ')].filter(Boolean).join(' · ')} <button className="linkbtn" onClick={remove} disabled={busy}>{t('Remove')}</button></span> : null}
          <input ref={fileInput} type="file" accept="application/pdf,.pdf" aria-label={t('Label PDF')} onChange={(e) => { file.current = e.target.files?.[0] ?? null; setErr(''); }} />
          <input className="input" placeholder={t('Carrier (optional), e.g. InPost')} aria-label={t('Carrier')} value={carrier} onChange={(e) => setCarrier(e.target.value)} />
          <input className="input" placeholder={t('Tracking number(s), separated by commas')} aria-label={t('Tracking numbers')} value={tracking} onChange={(e) => setTracking(e.target.value)} />
          <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={save} disabled={busy}>{busy ? t('Please wait…') : own ? t('Replace the label') : t('Save the label')}</button>
        </div>
      ) : null}
    </div>
  );
}
