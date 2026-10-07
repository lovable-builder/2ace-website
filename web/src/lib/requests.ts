import { fn, removeObjects, rpc, upload, uuid } from './api';
import { MSG } from './messages';

// Edits and deletes of things already with us are requests: staff approve or decline them, nothing changes until then.
export type ChangeBody =
  | { action: 'request'; entity: 'product' | 'inbound' | 'order'; id: string; kind: 'update' | 'delete'; payload?: Record<string, unknown> }
  | { action: 'cancel'; id: string }
  | { action: 'order_notify'; order_ids: string[] };
export const changeRequest = (body: ChangeBody) => fn('change-request', body, MSG.notSent);

// ---- product photos: up to 4 per product, the first is the thumbnail. They only describe a product, so they apply at once. ----
export const MAX_PHOTOS = 4;

// Large photos are scaled down to 1600 px and saved as JPEG before upload; anything the browser cannot read goes as it is.
export async function shrink(file: File, max = 1600): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    cv.getContext('2d')!.drawImage(bmp, 0, 0, cv.width, cv.height);
    return (await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/jpeg', 0.82))) || file;
  } catch { return file; }
}

export async function uploadPhotos(orgId: string, productId: string, files: FileList | File[], room: number): Promise<string[]> {
  const paths: string[] = [];
  for (const f of Array.from(files).slice(0, room)) {
    const blob = await shrink(f);
    const type = /^image\/(jpeg|png|webp)$/.test(blob.type) ? blob.type : 'image/jpeg';
    const path = orgId + '/' + productId + '/' + uuid() + '.' + (type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg');
    if (!(await upload('products', path, blob, type))) throw new Error(MSG.photo);
    paths.push(path);
  }
  return paths;
}

// Saves the photo list; the database answers with the files that dropped out, which are then deleted.
export async function setPhotos(productId: string, paths: string[]) {
  const removed = await rpc<string[]>('set_product_photos', { p_product: productId, p_paths: paths });
  if (removed && removed.length) await removeObjects('products', removed);
}
