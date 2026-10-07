import { useT } from '../../i18n';
import { useWarehouse } from '../../state/warehouse';
import { ErrLine } from '../../ui';

export function Inventory({ go }: { go: (tab: string) => void }) {
  const t = useT();
  const w = useWarehouse();
  const rows = w.inv.filter((p) => p.on_hand > 0 || p.incoming > 0);
  return (
    <div className="stack">
      <h1 className="h1">{t('Inventory')}</h1>
      {!w.loaded ? <p className="small">{t('Loading…')}</p> : null}
      <ErrLine text={w.err} />
      {w.loaded && !w.err && !rows.length ? (
        <div className="card stack-sm">
          <span className="h3">{t('No stock yet')}</span>
          <p className="sub">{w.inv.length ? t('Stock appears here once your first delivery has been received and scanned in.') : t('Add your products first, then book a delivery. Stock appears here once it has been received and scanned in.')}</p>
          <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => go(w.inv.length ? 'inbound' : 'products')}>{w.inv.length ? t('Book a delivery') : t('Add products')}</button>
        </div>
      ) : null}
      {rows.length ? (
        <table className="table">
          <thead><tr><th>{t('Product')}</th><th className="num">{t('On hand')}</th><th className="num">{t('Available')}</th><th className="num">{t('Awaiting put-away')}</th><th className="num">{t('Incoming')}</th></tr></thead>
          <tbody>
            {rows.map((p) => {
              const thumb = w.photoUrls[(p.photo_paths || [])[0]];
              return (
                <tr key={p.product_id}>
                  <td><span className="prod">{thumb ? <img className="thumb" src={thumb} alt="" /> : null}<span><strong>{p.sku}</strong><br /><span className="small">{p.name}</span></span></span></td>
                  <td className="num" data-label={t('On hand')}>{p.on_hand}</td>
                  <td className="num" data-label={t('Available')}>{p.available}</td>
                  <td className="num" data-label={t('Awaiting put-away')}>{p.unplaced + p.quarantined}</td>
                  <td className="num" data-label={t('Incoming')}>{p.incoming}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
