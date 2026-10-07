import { useT } from '../../i18n';
import { useWarehouse, type Change } from '../../state/warehouse';
import { changeRequest } from '../../lib/requests';
import { errText } from '../../lib/api';
import { carrierBrand } from '../../lib/carriers';
import { money } from '../../lib/format';

// A change request waiting for staff (with a way to withdraw it), or the reason the last one was declined.
export function PendingRequest({ ch }: { ch: Change | undefined }) {
  const t = useT();
  const w = useWarehouse();
  if (!ch || ch.status === 'done') return null;
  const cancel = async () => {
    try { await changeRequest({ action: 'cancel', id: ch.id! }); w.setNote(t('Request cancelled.')); w.setErr(''); void w.reload(); }
    catch (e) { w.setNote(''); w.setErr(errText(e)); }
  };
  if (ch.status === 'pending') return <span className="small text-warn">{t('Waiting for approval:')} {ch.summary} <button className="linkbtn" onClick={cancel}>{t('Cancel request')}</button></span>;
  return <span className="small text-bad">{t('Last request declined:')} {ch.decision_note || t('Declined')}</span>;
}

// A carrier's offer for a parcel: badge, service name, price before VAT and a Buy button.
export type Offer = { service_id: string | number; carrier: string; name: string; available: boolean; reason?: string; bill_net: number; bill_gross: number };
export function OfferRow({ q, onBuy, busy }: { q: Offer; onBuy: () => void; busy: boolean }) {
  const t = useT();
  const b = carrierBrand(q.carrier);
  return (
    <div className="offer">
      <span className="row"><span className="carrier" style={{ background: b.bg, color: b.fg }}>{b.label}</span><span>{q.name}</span></span>
      <span className="row"><span className="mono">{t('{price} + VAT', { price: money(q.bill_net) })}</span><button className="btn small" onClick={onBuy} disabled={busy}>{t('Buy')}</button></span>
    </div>
  );
}

// Splits the carriers' answer into what can be bought and a sentence about the rest.
export function offersNote(r: { offers?: Offer[]; enabled?: boolean }, t: (k: string, v?: Record<string, string | number>) => string) {
  const all = r.offers || [], ok = all.filter((q) => q.available), bad = all.filter((q) => !q.available);
  const off = r.enabled === false ? t('Buying labels is switched off right now, so prices are for comparison only.') + ' ' : '';
  const no = bad.length ? t('Not available: {list}.', { list: bad.map((q) => (q.name || q.carrier) + ' (' + q.reason + ')').join('; ') }) : '';
  return { ok, note: (off + (ok.length ? no : t('No carrier can take this parcel.') + ' ' + no)).trim() };
}

// The parcel the customer typed, in the shape the shipping function expects. Commas are fine as decimal points.
export type ParcelInput = { kg: string; l: string; w: string; h: string };
export const parcelComplete = (p: ParcelInput) => [p.kg, p.l, p.w, p.h].every((v) => String(v).trim() !== '');
export const parcelBody = (p: ParcelInput) => [{ weight_kg: p.kg, length_cm: p.l, width_cm: p.w, height_cm: p.h }];

export function ParcelFields({ p, set }: { p: ParcelInput; set: (x: Partial<ParcelInput>) => void }) {
  const t = useT();
  const f = (k: keyof ParcelInput, label: string) => (
    <label className="field" key={k}>{label}<input type="text" inputMode="decimal" value={p[k]} onChange={(e) => set({ [k]: e.target.value })} /></label>
  );
  return <div className="grid-4">{f('kg', t('Weight (kg)'))}{f('l', t('Length (cm)'))}{f('w', t('Width (cm)'))}{f('h', t('Height (cm)'))}</div>;
}

// What a bought label says: carrier or service, tracking, price.
export function boughtText(l: { state?: string; service?: string | null; carrier?: string | null; tracking_numbers?: string[] | null; bill_net: number }, t: (k: string, v?: Record<string, string | number>) => string, returnLabel = false) {
  if (l.state === 'buying') return t('We are confirming this label with the carrier. Please do not buy it again.');
  const parts = [l.service || l.carrier, (l.tracking_numbers || []).length ? t('tracking {n}', { n: (l.tracking_numbers || []).join(', ') }) : '', t('{price} + VAT', { price: money(l.bill_net) })].filter(Boolean);
  return (returnLabel ? t('Return label bought:') : t('Label bought:')) + ' ' + parts.join(' · ');
}
