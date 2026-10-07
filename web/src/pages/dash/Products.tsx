import { useRef, useState } from 'react';
import { useT } from '../../i18n';
import { useAccount } from '../../state/account';
import { useWarehouse, type InvRow } from '../../state/warehouse';
import { errText, rpc } from '../../lib/api';
import { changeRequest, MAX_PHOTOS, setPhotos, uploadPhotos } from '../../lib/requests';
import { ErrLine, Field, Note, scrollTop } from '../../ui';
import { PendingRequest } from './shared';

export function Products() {
  const t = useT();
  const { orgId } = useAccount();
  const w = useWarehouse();
  const [open, setOpen] = useState(false);
  const [sku, setSku] = useState(''); const [name, setName] = useState(''); const [ean, setEan] = useState('');
  const files = useRef<FileList | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState<InvRow | null>(null);

  const add = async () => {
    if (busy) return;
    if (!sku.trim() || !name.trim()) return setErr(t('Enter a SKU and a product name.'));
    setBusy(true); setErr('');
    try {
      const id = await rpc<string>('create_product', { p_org: orgId, p_sku: sku, p_name: name, p_ean: ean || null });
      let note = t('Product added.');
      if (files.current?.length) {
        try { await setPhotos(id, await uploadPhotos(orgId, id, files.current, MAX_PHOTOS)); }
        catch (e) { note = t('Product added, but the photos did not upload: {why}', { why: errText(e) }); }
      }
      files.current = null;
      setOpen(false); setSku(''); setName(''); setEan('');
      w.setNote(note); void w.reload();
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack narrow">
      <div className="spread">
        <h1 className="h1">{t('Products')}</h1>
        <button className={'btn' + (open ? ' ghost' : '')} onClick={() => { setOpen(!open); setErr(''); }}>{open ? t('Cancel') : t('Add a product')}</button>
      </div>
      <Note text={w.note} onClear={() => w.setNote('')} />
      {edit ? <EditProduct p={w.inv.find((x) => x.product_id === edit.product_id) ?? edit} onDone={() => setEdit(null)} /> : null}
      {open ? (
        <div className="card stack-sm">
          <Field label={t('SKU')} value={sku} maxLength={60} placeholder="MUG-BLUE" onChange={(e) => { setSku(e.target.value); setErr(''); }} />
          <Field label={t('Product name')} value={name} maxLength={200} placeholder={t('Blue ceramic mug')} onChange={(e) => { setName(e.target.value); setErr(''); }} />
          <Field label={t('Barcode (EAN), optional')} value={ean} maxLength={40} placeholder="5901234123457" onChange={(e) => { setEan(e.target.value); setErr(''); }} />
          <Field label={t('Photos, optional (up to 4)')} type="file" accept="image/*" multiple onChange={(e) => { files.current = e.target.files; }} />
          {!edit ? <ErrLine text={err} /> : null}
          <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={add} disabled={busy}>{busy ? t('Saving…') : t('Save product')}</button>
        </div>
      ) : null}
      {!w.loaded ? <p className="small">{t('Loading…')}</p> : null}
      <ErrLine text={w.err} />
      {w.loaded && !w.err && !w.inv.length ? (
        <div className="card stack-sm">
          <span className="h3">{t('Your product catalogue')}</span>
          <p className="sub">{t('Add each product you will store with us: a SKU, a name and its barcode. You need them before you can book a delivery.')}</p>
        </div>
      ) : null}
      {w.inv.length ? (
        <div className="list">
          {w.inv.map((p) => {
            const ch = w.changes[p.product_id];
            const thumb = w.photoUrls[(p.photo_paths || [])[0]];
            return (
              <div className="item" key={p.product_id}>
                <div className="head">
                  <span className="prod">{thumb ? <img className="thumb" src={thumb} alt="" /> : null}<span><strong>{p.sku}</strong>{p.active ? '' : ' ' + t('(switched off)')}<br /><span className="meta">{p.name}</span></span></span>
                  <span style={{ textAlign: 'right' }}>
                    <span className="mono small">{(w.codes[p.product_id] || []).join(', ') || t('No barcode')}</span><br />
                    <span className="meta">{t('{n} in stock', { n: p.on_hand })}</span><br />
                    {ch?.status !== 'pending' ? <button className="linkbtn" onClick={() => { setEdit(p); setOpen(false); setErr(''); w.setNote(''); scrollTop(); }}>{t('Request edit')}</button> : null}
                  </span>
                </div>
                <PendingRequest ch={ch} />
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function EditProduct({ p, onDone }: { p: InvRow; onDone: () => void }) {
  const t = useT();
  const { orgId } = useAccount();
  const w = useWarehouse();
  const [name, setName] = useState(p.name);
  const [ean, setEan] = useState('');
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [err, setErr] = useState('');
  const current = p.photo_paths || [];

  const ask = async (body: Parameters<typeof changeRequest>[0], done: string) => {
    if (busy) return;
    setBusy(true); setErr('');
    try { await changeRequest(body); w.setNote(done); onDone(); void w.reload(); }
    catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };
  const save = () => {
    if (!name.trim()) return setErr(t('The name cannot be empty.'));
    const payload: Record<string, unknown> = { name };
    if (ean.trim()) payload.ean = ean.trim();
    void ask({ action: 'request', entity: 'product', id: p.product_id, kind: 'update', payload }, t('Sent for approval. Your product stays as it is until we approve the change. We email you the result.'));
  };
  const addPhotos = async (files: FileList | null) => {
    if (photoBusy || !files?.length) return;
    const room = MAX_PHOTOS - current.length;
    if (room <= 0) return setErr(t('At most 4 photos. Remove one first.'));
    setPhotoBusy(true); setErr('');
    try { await setPhotos(p.product_id, current.concat(await uploadPhotos(orgId, p.product_id, files, room))); await w.reload(); }
    catch (e) { setErr(errText(e)); }
    finally { setPhotoBusy(false); }
  };
  const removePhoto = async (path: string) => {
    if (photoBusy) return;
    setPhotoBusy(true); setErr('');
    try { await setPhotos(p.product_id, current.filter((x) => x !== path)); await w.reload(); }
    catch (e) { setErr(errText(e)); }
    finally { setPhotoBusy(false); }
  };

  return (
    <div className="card stack-sm">
      <span className="h3">{t('Request a change to {sku}', { sku: p.sku })}</span>
      <p className="small">{t('We review changes to products before they apply. Until then your product stays as it is.')}</p>
      <Field label={t('Product name')} value={name} maxLength={200} onChange={(e) => { setName(e.target.value); setErr(''); }} />
      <div className="stack-sm">
        <span className="label">{t('Photos (applied at once, no approval needed)')}</span>
        <div className="photos">
          {current.filter((x) => w.photoUrls[x]).map((x, i) => (
            <figure key={x}><img src={w.photoUrls[x]} alt="" />{i === 0 ? <span className="mono small">{t('Thumbnail')}</span> : null}<button className="linkbtn" onClick={() => removePhoto(x)}>{t('Remove')}</button></figure>
          ))}
        </div>
        <Field label={photoBusy ? t('Uploading…') : t('Add photos (up to 4)')} type="file" accept="image/*" multiple onChange={(e) => { void addPhotos(e.target.files); try { e.target.value = ''; } catch { /* ignore */ } }} />
      </div>
      <Field label={t('Add another barcode, optional')} value={ean} maxLength={40} placeholder="5901234123457" onChange={(e) => { setEan(e.target.value); setErr(''); }} />
      <ErrLine text={err} />
      <div className="row">
        <button className="btn" onClick={save} disabled={busy}>{busy ? t('Sending…') : t('Send for approval')}</button>
        <button className="btn ghost" onClick={onDone}>{t('Cancel')}</button>
        <button className="btn ghost" onClick={() => ask({ action: 'request', entity: 'product', id: p.product_id, kind: 'update', payload: { active: !p.active } }, t('Sent for approval. We email you the result.'))} disabled={busy}>{p.active ? t('Request switch off') : t('Request switch on')}</button>
        <button className="btn ghost" onClick={() => { if (window.confirm(t('Ask us to delete this product? We review the request and email you the result.'))) void ask({ action: 'request', entity: 'product', id: p.product_id, kind: 'delete' }, t('Deletion requested. The product stays until we approve it.')); }} disabled={busy}>{t('Request delete')}</button>
      </div>
      <p className="small">{t('A product that was already on a delivery or in stock cannot be deleted. Switch it off instead and it is kept in your history.')}</p>
    </div>
  );
}
