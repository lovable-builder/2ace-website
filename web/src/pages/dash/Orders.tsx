import { useState } from 'react';
import { useLang } from '../../i18n';
import { useAccount } from '../../state/account';
import { useWarehouse, type Order } from '../../state/warehouse';
import { errText, rest, rpc } from '../../lib/api';
import { changeRequest } from '../../lib/requests';
import { dateShort } from '../../lib/format';
import { ErrLine, Field, Note } from '../../ui';
import { LinePicker, type PickedLine } from './LinePicker';
import { PendingRequest } from './shared';
import { CsvImport } from './CsvImport';
import { OrderShipping } from './OrderShipping';

// i18n
const STATUS: Record<string, string> = { new: 'Received', held: 'On hold, not enough stock', allocated: 'Reserved, waiting to be picked', picking: 'Being picked', packed: 'Packed', shipped: 'Shipped', cancelled: 'Cancelled' };
const OPEN = ['new', 'held', 'allocated', 'picking', 'packed'];

// Asks the server to email the customer about orders that went on hold (it emails each order once).
export async function notifyHeld(ids: string[]) {
  if (!ids.length) return;
  try { await changeRequest({ action: 'order_notify', order_ids: ids }); } catch { /* the order exists either way */ }
}
export async function notifyAllHeld() {
  const ids = await rest<{ id: string }[]>('orders?select=id&status=eq.held&held_notified_at=is.null&limit=200').catch(() => []);
  await notifyHeld(ids.map((x) => x.id));
}

export function Orders() {
  const { t, lang } = useLang();
  const a = useAccount();
  const w = useWarehouse();
  const [form, setForm] = useState(false);
  const [csv, setCsv] = useState(false);
  const [ship, setShip] = useState('');

  const cancel = async (o: Order) => {
    if (!window.confirm(t('Ask us to cancel order {ref}? We review the request and email you the result.', { ref: o.ref }))) return;
    try { await changeRequest({ action: 'request', entity: 'order', id: o.id, kind: 'delete' }); w.setNote(t('Cancellation requested. The order stays as it is until we approve it.')); w.setErr(''); void w.reload(); }
    catch (e) { w.setNote(''); w.setErr(errText(e)); }
  };

  return (
    <div className="stack narrow">
      <div className="spread">
        <h1 className="h1">{t('Orders')}</h1>
        <div className="row">
          <button className="btn ghost" onClick={() => { setCsv(!csv); setForm(false); }}>{csv ? t('Close import') : t('Import CSV')}</button>
          <button className={'btn' + (form ? ' ghost' : '')} onClick={() => { setForm(!form); setCsv(false); }}>{form ? t('Cancel') : t('New order')}</button>
        </div>
      </div>
      <p className="small">{t('We reserve stock for an order only when all of it is on our shelves. If anything is short, the whole order waits on hold, nothing is reserved, and it is reserved automatically when the stock arrives.')}</p>
      <Note text={w.note} onClear={() => w.setNote('')} />
      {a.session && !a.activated ? <p className="small">{t('You can place orders once your plan is active.')}</p> : null}
      {form ? <NewOrder onDone={() => setForm(false)} /> : null}
      {csv ? <CsvImport /> : null}
      {!w.loaded ? <p className="small">{t('Loading…')}</p> : null}
      <ErrLine text={w.err} />
      {w.loaded && !w.err && !w.orders.length ? (
        <div className="card stack-sm">
          <span className="h3">{t('No orders yet')}</span>
          <p className="sub">{t('Place an order by hand, or import many at once from a CSV file. You need stock on our shelves first: add products, book a delivery, and wait until it is put away.')}</p>
        </div>
      ) : null}
      {w.orders.length ? (
        <div className="list">
          {w.orders.map((o) => {
            const ch = w.changes[o.id];
            const cancellable = ['new', 'held', 'allocated'].includes(o.status) && ch?.status !== 'pending';
            const canShip = OPEN.includes(o.status), open = ship === o.id;
            const color = o.status === 'held' ? 'text-warn' : o.status === 'cancelled' ? 'text-muted' : 'text-ok';
            return (
              <div className="item" key={o.id}>
                <div className="head"><strong>{o.ref}</strong><span className={'status ' + color}>{t(STATUS[o.status] ?? o.status)}</span></div>
                <span className="meta">{o.ship_name}, {o.ship_city} {o.ship_country} · {dateShort(o.created_at, lang)} {o.external_ref ? t('Your reference {ref}', { ref: o.external_ref }) : ''}</span>
                <span>{(o.order_lines || []).map((l) => l.products.sku + ' × ' + l.qty).join(', ')}</span>
                {o.status === 'held' && o.hold_reason ? <span className="text-warn">{o.hold_reason}</span> : null}
                {o.details_request_note && OPEN.includes(o.status) ? (
                  <span className="warnbox" style={{ fontSize: 14 }}>{t('We need a correction before we can ship this order:')} {o.details_request_note} {t('Please reply to our email, or write to hello@2ace.pl.')}</span>
                ) : null}
                <PendingRequest ch={ch} />
                {cancellable || canShip ? (
                  <div className="row">
                    {cancellable ? <button className="btn ghost small" onClick={() => cancel(o)}>{t('Request cancellation')}</button> : null}
                    {canShip ? <button className="btn ghost small" aria-expanded={open} onClick={() => setShip(open ? '' : o.id)}>
                      {open ? t('Hide shipping') : o.label_source === 'own' ? t('Shipping (own label added)') : o.label_source === '2ace' ? t('Shipping (label bought)') : t('Shipping')}
                    </button> : null}
                  </div>
                ) : null}
                {open ? <OrderShipping order={o} /> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function NewOrder({ onDone }: { onDone: () => void }) {
  const t = useLang().t;
  const { orgId } = useAccount();
  const w = useWarehouse();
  const [f, setF] = useState({ ref: '', name: '', email: '', phone: '', line1: '', postal: '', city: '', country: 'PL' });
  const [lines, setLines] = useState<PickedLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => { setF({ ...f, [k]: k === 'country' ? e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) : e.target.value }); setErr(''); };
  const active = w.inv.filter((p) => p.active);

  const save = async () => {
    if (busy) return;
    if (!lines.length) return setErr(t('Add at least one product to the order.'));
    setBusy(true); setErr('');
    try {
      const r = await rpc<{ id: string; ref: string; status: string; duplicate?: boolean }>('create_order', {
        p_org: orgId, p_external_ref: f.ref || null,
        p_ship: { name: f.name, email: f.email, phone: f.phone, line1: f.line1, postal: f.postal, city: f.city, country: f.country },
        p_notes: null, p_lines: lines.map((l) => ({ product_id: l.pid, qty: l.qty })), p_channel: 'manual',
      });
      if (r.status === 'held') await notifyHeld([r.id]);
      w.setNote(r.duplicate ? t('You already have an order with that reference: {ref}.', { ref: r.ref })
        : r.status === 'held' ? t('Order {ref} is on hold: not enough stock. Nothing was reserved, and we emailed you the details. It reserves itself when stock arrives.', { ref: r.ref })
          : t('Order {ref} received and stock reserved.', { ref: r.ref }));
      onDone(); void w.reload();
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="card stack-sm">
      <span className="h3">{t('New order')}</span>
      {!active.length ? <p className="errline">{t('Add your products first (Products tab), then place an order.')}</p> : null}
      <Field label={t('Your order number, optional')} value={f.ref} onChange={set('ref')} maxLength={60} placeholder="SHOP-1001" />
      <Field label={t('Recipient first name and surname')} value={f.name} onChange={set('name')} maxLength={120} placeholder="Jan Kowalski" />
      <Field label={t('Recipient email, optional')} type="email" value={f.email} onChange={set('email')} maxLength={120} />
      <Field label={t('Recipient phone, required')} inputMode="tel" value={f.phone} onChange={set('phone')} maxLength={40} placeholder="608 180 946" />
      <Field label={t('Street and number')} value={f.line1} onChange={set('line1')} maxLength={160} />
      <div className="grid-addr">
        <Field label={t('Postal code')} value={f.postal} onChange={set('postal')} maxLength={20} />
        <Field label={t('City')} value={f.city} onChange={set('city')} maxLength={100} />
        <Field label={t('Country')} value={f.country} onChange={set('country')} maxLength={2} placeholder="PL" />
      </div>
      <span className="label">{t('What to send')}</span>
      <LinePicker products={active} all={w.inv} lines={lines} setLines={setLines} setErr={setErr} dupMsg={t('That product is already on this order.')} showAvailable />
      <ErrLine text={err} />
      <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={save} disabled={busy}>{busy ? t('Sending…') : t('Place order')}</button>
    </div>
  );
}
