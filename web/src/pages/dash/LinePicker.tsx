import { useState } from 'react';
import { useT } from '../../i18n';
import type { InvRow } from '../../state/warehouse';

export type PickedLine = { pid: string; qty: number };

// Products and quantities for a delivery or an order: choose, type a quantity, Add; each line can be removed.
export function LinePicker({ products, all, lines, setLines, setErr, dupMsg, showAvailable }: {
  products: InvRow[]; all?: InvRow[]; lines: PickedLine[]; setLines: (l: PickedLine[]) => void; setErr: (s: string) => void; dupMsg: string; showAvailable?: boolean;
}) {
  const t = useT();
  const [pick, setPick] = useState('');
  const [qty, setQty] = useState('1');
  const add = () => {
    const q = parseInt(qty, 10);
    if (!pick) return setErr(t('Choose a product first.'));
    if (!(q >= 1)) return setErr(t('Enter a quantity of at least 1.'));
    if (lines.some((l) => l.pid === pick)) return setErr(dupMsg);
    setLines(lines.concat([{ pid: pick, qty: q }])); setPick(''); setQty('1'); setErr('');
  };
  const label = (pid: string) => { const p = (all ?? products).find((x) => x.product_id === pid); return (p?.sku || '') + ' - ' + (p?.name || ''); };
  return (
    <div className="stack-sm">
      {lines.map((l, i) => (
        <div className="spread" key={l.pid} style={{ padding: '8px 12px', background: '#F5F4F1', borderRadius: 3 }}>
          <span>{label(l.pid)} <strong>× {l.qty}</strong></span>
          <button className="xbtn" aria-label={t('Remove')} onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <select className="input" aria-label={t('Product')} value={pick} onChange={(e) => { setPick(e.target.value); setErr(''); }} style={{ flex: 1 }}>
          <option value="">{t('Choose a product')}</option>
          {products.map((p) => <option key={p.product_id} value={p.product_id}>{p.sku + ' - ' + p.name + (showAvailable ? ' ' + t('({n} available)', { n: p.available }) : '')}</option>)}
        </select>
        <input className="input" type="number" min={1} value={qty} aria-label={t('Quantity')} onChange={(e) => { setQty(e.target.value); setErr(''); }} style={{ width: 90 }} />
        <button className="btn dark" onClick={add}>{t('Add')}</button>
      </div>
    </div>
  );
}
