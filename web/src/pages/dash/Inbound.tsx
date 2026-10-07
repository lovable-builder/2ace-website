import { useState } from 'react';
import { useLang } from '../../i18n';
import { useAccount } from '../../state/account';
import { useWarehouse, type Booking } from '../../state/warehouse';
import { errText, rpc } from '../../lib/api';
import { changeRequest } from '../../lib/requests';
import { dateShort } from '../../lib/format';
import { ErrLine, Field, Note, scrollTop } from '../../ui';
import { LinePicker, type PickedLine } from './LinePicker';
import { PendingRequest } from './shared';

// i18n
const STATUS: Record<string, string> = { booked: 'Booked', receiving: 'Being received', received: 'Received', cancelled: 'Cancelled' };

export function Inbound() {
  const { t, lang } = useLang();
  const a = useAccount();
  const w = useWarehouse();
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState('');
  const [date, setDate] = useState(''); const [carrier, setCarrier] = useState(''); const [tracking, setTracking] = useState(''); const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<PickedLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const active = w.inv.filter((p) => p.active);

  const reset = () => { setOpen(false); setEditId(''); setLines([]); setErr(''); setDate(''); setCarrier(''); setTracking(''); setNotes(''); };
  const edit = (b: Booking) => {
    setOpen(true); setEditId(b.id); setDate(b.expected_date || ''); setCarrier(b.carrier || ''); setTracking(b.tracking || ''); setNotes(b.notes || '');
    setLines((b.inbound_lines || []).map((l) => ({ pid: l.product_id, qty: l.expected_qty }))); setErr(''); w.setNote(''); scrollTop();
  };
  const del = async (b: Booking) => {
    if (!window.confirm(t('Ask us to delete delivery {ref}? We review the request and email you the result.', { ref: b.ref }))) return;
    try { await changeRequest({ action: 'request', entity: 'inbound', id: b.id, kind: 'delete' }); w.setNote(t('Deletion requested. The delivery stays booked until we approve it.')); w.setErr(''); setOpen(false); setEditId(''); void w.reload(); }
    catch (e) { w.setNote(''); w.setErr(errText(e)); }
  };
  const save = async () => {
    if (busy) return;
    if (!lines.length) return setErr(t('Add at least one product to the delivery.'));
    setBusy(true); setErr('');
    try {
      const l = lines.map((x) => ({ product_id: x.pid, qty: x.qty }));
      if (editId) await changeRequest({ action: 'request', entity: 'inbound', id: editId, kind: 'update', payload: { carrier: carrier || null, tracking: tracking || null, expected: date || null, notes: notes || null, lines: l } });
      else await rpc('book_inbound', { p_org: a.orgId, p_carrier: carrier || null, p_tracking: tracking || null, p_expected: date || null, p_notes: null, p_lines: l });
      const msg = editId ? t('Sent for approval. Your delivery stays as booked until we approve the change. We email you the result.') : t('Delivery booked. We will receive it when it arrives.');
      reset(); w.setNote(msg); void w.reload();
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack narrow">
      <div className="spread">
        <h1 className="h1">{t('Inbound')}</h1>
        <button className={'btn' + (open ? ' ghost' : '')} onClick={() => (open ? reset() : (setOpen(true), setErr('')))}>{open ? t('Cancel') : t('Book a delivery')}</button>
      </div>
      <Note text={w.note} onClear={() => w.setNote('')} />
      {a.session && !a.activated ? <p className="small">{t('You can book deliveries once your plan is active.')}</p> : null}
      {open ? (
        <div className="card stack-sm">
          <span className="h3">{editId ? t('Request a change to this delivery') : t('New delivery')}</span>
          {editId ? <p className="small">{t('We review changes to deliveries before they apply. Your delivery stays as booked until we approve it.')}</p> : null}
          {!active.length ? <p className="errline">{t('Add your products first (Products tab), then book a delivery.')}</p> : null}
          <Field label={t('Expected arrival date')} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Field label={t('Carrier')} value={carrier} maxLength={80} placeholder={t('DHL, DSV, a freight forwarder…')} onChange={(e) => setCarrier(e.target.value)} />
          <Field label={t('Tracking number, optional')} value={tracking} maxLength={120} onChange={(e) => setTracking(e.target.value)} />
          <span className="label">{t('What is arriving')}</span>
          <LinePicker products={active} all={w.inv} lines={lines} setLines={setLines} setErr={setErr} dupMsg={t('That product is already on this delivery.')} />
          <ErrLine text={err} />
          <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={save} disabled={busy}>{busy ? t('Sending…') : editId ? t('Send for approval') : t('Book delivery')}</button>
        </div>
      ) : null}
      {!w.loaded ? <p className="small">{t('Loading…')}</p> : null}
      <ErrLine text={w.err} />
      {w.loaded && !w.err && !w.book.length ? (
        <div className="card stack-sm">
          <span className="h3">{t('No deliveries yet')}</span>
          <p className="sub">{t('Book a delivery to tell us what is arriving and when. We receive it, scan it in and put it in your bin. Stock then shows under Inventory.')}</p>
        </div>
      ) : null}
      {w.book.length ? (
        <div className="list">
          {w.book.map((b) => {
            const ch = w.changes[b.id], pending = ch?.status === 'pending';
            const lines = b.inbound_lines || [];
            const issues = w.issues[b.id] || [], photos = w.photos[b.id] || [];
            return (
              <div className="item" key={b.id}>
                <div className="head"><strong>{b.ref}</strong><span className="status">{t(STATUS[b.status] ?? b.status)}</span></div>
                <span className="meta">{b.expected_date ? dateShort(b.expected_date, lang) : t('No date')} · {t('{n} units', { n: lines.reduce((s, l) => s + l.expected_qty, 0) })} {[b.carrier, b.tracking].filter(Boolean).join(' · ')}</span>
                <span>{lines.map((l) => l.products.sku + ' × ' + l.expected_qty).join(', ')}</span>
                {issues.length ? <span className="text-warn">{t('Differences found:')} {issues.join(' · ')}</span> : null}
                {photos.length ? <span className="row">{photos.map((u, i) => <a key={u} className="linkbtn" href={u} target="_blank" rel="noopener">{t('Photo {n}', { n: i + 1 })}</a>)}</span> : null}
                <PendingRequest ch={ch} />
                <div className="row">
                  {b.status === 'booked' && !pending ? <button className="btn ghost small" onClick={() => edit(b)}>{t('Request edit')}</button> : null}
                  {(b.status === 'booked' || b.status === 'cancelled') && !pending ? <button className="btn ghost small" onClick={() => del(b)}>{t('Request delete')}</button> : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
