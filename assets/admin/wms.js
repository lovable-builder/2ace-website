import { el } from './ui.js';

// Shared bits for the warehouse screens. All writes are database functions (RPCs): they check the caller's role, validate and audit.
export async function rpc(ctx, fn, args) {
  const { data, error } = await ctx.sb.rpc(fn, args || {});
  if (error) throw new Error(error.message);
  return data;
}
export const canAct = (ctx) => ctx.me.role === 'admin' || ctx.me.role === 'warehouse';
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
export const KINDS = ['receiving', 'bin', 'pallet', 'pack', 'returns', 'quarantine', 'shipping'];

export async function loadOrgs(ctx) {
  if (!ctx.session.orgs) { const { data, error } = await ctx.sb.rpc('wms_orgs'); if (error) throw new Error(error.message); ctx.session.orgs = data || []; }
  return ctx.session.orgs;
}
export const orgName = (orgs, id) => (orgs.find((o) => o.id === id) || {}).name || '-';
export const orgSelect = (orgs, value, allLabel) => el('select', {}, allLabel != null && el('option', { value: '', text: allLabel }),
  orgs.map((o) => el('option', { value: o.id, text: o.name, ...(o.id === value ? { selected: true } : {}) })));

// Run an async action from a button: disable it while it works, show errors in `err`.
export async function guarded(btn, err, fn) {
  btn.disabled = true; if (err) err.textContent = '';
  try { return await fn(); } catch (e) { if (err) err.textContent = e.message; else throw e; } finally { btn.disabled = false; }
}

// ---- photos of damaged goods ----
// Phone photos are big: shrink to at most 1600px and re-encode as JPEG before upload. If the browser cannot, upload the original.
export async function resizeImage(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
    return blob || file;
  } catch { return file; }
}
const ext = (t) => (t === 'image/png' ? 'png' : t === 'image/webp' ? 'webp' : 'jpg');
async function uploadTo(ctx, bucket, orgId, folderId, files, max) {
  const paths = [];
  for (const f of [...files].slice(0, max)) {
    const blob = await resizeImage(f);
    const type = blob.type && /^image\/(jpeg|png|webp)$/.test(blob.type) ? blob.type : 'image/jpeg';
    const path = `${orgId}/${folderId}/${newKey()}.${ext(type)}`;
    const { error } = await ctx.sb.storage.from(bucket).upload(path, blob, { contentType: type });
    if (error) throw new Error(error.message);
    paths.push(path);
  }
  return paths;
}
export const uploadPhotos = (ctx, orgId, bookingId, files) => uploadTo(ctx, 'receiving', orgId, bookingId, files, 8);
export const uploadProductPhotos = (ctx, orgId, productId, files) => uploadTo(ctx, 'products', orgId, productId, files, 4);
export async function signedUrls(ctx, paths, bucket = 'receiving') {
  const out = {}; if (!paths.length) return out;
  const { data } = await ctx.sb.storage.from(bucket).createSignedUrls([...new Set(paths)], 3600);
  for (const x of data || []) if (x.signedUrl && x.path) out[x.path] = x.signedUrl;
  return out;
}
// Replace a product's photo list. The database returns the files that dropped out; delete them from storage.
export async function setProductPhotos(ctx, productId, paths) {
  const removed = await rpc(ctx, 'set_product_photos', { p_product: productId, p_paths: paths });
  if (removed && removed.length) await ctx.sb.storage.from('products').remove(removed);
}
export const thumb = (url, size = 44) => (url ? el('img', { src: url, alt: '', style: `width:${size}px;height:${size}px;object-fit:cover;border-radius:3px;display:block` }) : el('span', { style: `width:${size}px;height:${size}px;border-radius:3px;background:rgba(11,12,14,.08);display:inline-block` }));
