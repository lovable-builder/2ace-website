import { useState } from 'react';
import { useT } from '../../i18n';
import { useAccount } from '../../state/account';
import { useWarehouse } from '../../state/warehouse';
import { errText, rpc } from '../../lib/api';
import { CSV_MAX_BYTES, CSV_MAX_ORDERS, CSV_TEMPLATE, CsvError, csvToOrders, type CsvOrder } from '../../lib/csv';
import { ErrLine } from '../../ui';
import { notifyAllHeld } from './Orders';

type Result = { ok: boolean; external_ref?: string; ref?: string; status?: string; duplicate?: boolean; error?: string };

// Many orders at once. Importing the same file again creates nothing new: each order_ref is used once.
export function CsvImport() {
  const t = useT();
  const { orgId } = useAccount();
  const w = useWarehouse();
  const [orders, setOrders] = useState<CsvOrder[] | null>(null);
  const [info, setInfo] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result[] | null>(null);

  const pick = async (file: File | undefined) => {
    setResult(null);
    if (!file) { setOrders(null); setInfo(''); setErr(''); return; }
    if (file.size > CSV_MAX_BYTES) { setOrders(null); setInfo(''); setErr(t('That file is too big. Keep it under 2 MB (about 200 orders).')); return; }
    try {
      const o = csvToOrders(await file.text());
      if (o.length > CSV_MAX_ORDERS) throw new CsvError('Import at most 200 orders at a time. This file has {n}.', { n: o.length });
      setOrders(o); setErr('');
      const lines = o.reduce((s, x) => s + x.lines.length, 0);
      setInfo(o.length === 1 ? t('1 order with {lines} lines ready to import.', { lines }) : t('{orders} orders with {lines} lines ready to import.', { orders: o.length, lines }));
    } catch (e) { setOrders(null); setInfo(''); setErr(e instanceof CsvError ? t(e.key, e.vars) : errText(e)); }
  };
  const go = async () => {
    if (busy || !orders) return;
    setBusy(true); setErr('');
    try {
      const res = await rpc<Result[]>('import_orders', { p_org: orgId, p_orders: orders });
      await notifyAllHeld();
      setResult(res || []); setOrders(null); setInfo(''); void w.reload();
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };
  const word = (s?: string) => (s === 'allocated' ? t('reserved') : s === 'held' ? t('on hold, not enough stock') : s === 'new' ? t('received') : s ?? '');

  return (
    <div className="card stack-sm">
      <span className="h3">{t('Import orders from a CSV file')}</span>
      <p className="small">{t('One row per product on an order. Rows with the same order_ref become one order. Products are matched by sku. Importing the same file again never creates duplicates, because each order_ref is only used once. Up to 200 orders per file.')}</p>
      <a className="linkbtn" href={'data:text/csv;charset=utf-8,' + encodeURIComponent(CSV_TEMPLATE)} download="2ace-orders-template.csv">{t('Download the template')}</a>
      <label className="field">{t('Choose your CSV file')}<input type="file" accept=".csv,text/csv" onChange={(e) => void pick(e.target.files?.[0])} /></label>
      {info ? <p className="small">{info}</p> : null}
      <ErrLine text={err} />
      <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={go} disabled={!orders || busy}>{busy ? t('Importing…') : t('Import orders')}</button>
      {result ? (
        <div className="stack-sm">
          <span className="label">{t('Result for every order')}</span>
          {result.map((r, i) => (
            <div className="kv" key={i}>
              <strong>{r.external_ref || '-'}</strong>
              <span className={!r.ok ? 'text-bad' : r.status === 'held' ? 'text-warn' : 'text-ok'} style={{ fontFamily: 'var(--sans)' }}>
                {r.ok ? (r.duplicate ? t('Already imported as {ref}', { ref: r.ref ?? '' }) : r.ref + ': ' + word(r.status)) : r.error}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
