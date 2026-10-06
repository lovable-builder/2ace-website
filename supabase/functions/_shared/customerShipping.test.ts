// deno test supabase/functions/_shared/customerShipping.test.ts
import { CsError, attachOwnLabel, capabilities, removeOwnLabel, status, isPdf, type CsDeps } from './customerShipping.ts';
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const ORG = '11111111-1111-1111-1111-111111111111', OTHER = '22222222-2222-2222-2222-222222222222', ORD = '33333333-3333-3333-3333-333333333333', USER = '44444444-4444-4444-4444-444444444444';
const FILE = `${ORG}/${ORD}/55555555-5555-5555-5555-555555555555.pdf`;
const pdfBytes = (n = 100) => { const b = new Uint8Array(n); b.set([0x25, 0x50, 0x44, 0x46, 0x2d]); return b; };

function rig(over: Partial<CsDeps> & { order?: { org_id: string } | null; bytes?: Uint8Array | null; rpcError?: string; replaced?: string | null; modeIs?: string } = {}) {
  const log: string[] = []; const calls: Record<string, unknown[]> = {};
  const rec = (k: string, v?: unknown) => { log.push(k); (calls[k] ??= []).push(v); };
  const deps: CsDeps = {
    orgId: ORG, role: 'owner', userId: USER,
    getOrder: async () => (over.order === null ? null : { id: ORD, org_id: over.order?.org_id ?? ORG, ref: 'ORD-000001', status: 'allocated', label_source: null }),
    mode: async () => over.modeIs ?? 'payg',
    download: async (p) => { rec('download', p); return over.bytes === undefined ? pdfBytes() : over.bytes; },
    removeFile: async (p) => { rec('remove', p); },
    rpc: async (n, a) => { rec('rpc:' + n, a); return over.rpcError ? { data: null, error: { message: over.rpcError } } : { data: { id: 'l1', replaced_path: over.replaced ?? null }, error: null }; },
    ownLabel: async () => null, ...over,
  };
  return { deps, log, calls };
}
const refuse = async (f: () => Promise<unknown>, status: number, re: RegExp, m: string) => { try { await f(); } catch (e) { ok(e instanceof CsError && e.status === status && re.test(e.message), `${m}: got ${(e as Error).message} (${(e as CsError).status})`); return; } throw new Error(m + ': should have been refused'); };

Deno.test('the PDF check looks at the file itself', () => {
  ok(isPdf(pdfBytes()), 'a real PDF'); ok(!isPdf(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d])), 'a PNG renamed .pdf'); ok(!isPdf(new Uint8Array([])), 'empty'); ok(!isPdf(new TextEncoder().encode('%PD')), 'too short'); ok(!isPdf(new TextEncoder().encode('<html>%PDF-')), 'PDF text later in the file does not count');
});
Deno.test('a PDF label is registered with the customer\'s own identity and the cleaned inputs', async () => {
  const r = rig(); const out = await attachOwnLabel(r.deps, { order_id: ORD, path: FILE, filename: 'Allegro label.pdf', tracking: 'AAA111, BBB222\nCCC333', carrier: 'InPost' });
  eq(out, { ok: true }, 'result'); const a = r.calls['rpc:attach_own_label'][0] as Record<string, unknown>;
  eq([a.p_org, a.p_order, a.p_path, a.p_filename, a.p_size, a.p_carrier, a.p_actor], [ORG, ORD, FILE, 'Allegro label.pdf', 100, 'InPost', USER], 'arguments'); eq(a.p_tracking, ['AAA111', ' BBB222', 'CCC333'], 'tracking split on commas and new lines (the database trims)');
  ok(!r.log.includes('remove'), 'nothing deleted');
});
Deno.test('tracking numbers alone are accepted, as an array too', async () => {
  const r = rig(); await attachOwnLabel(r.deps, { order_id: ORD, tracking: ['AAA111'] }); const a = r.calls['rpc:attach_own_label'][0] as Record<string, unknown>; eq([a.p_path, a.p_size, a.p_tracking], [null, null, ['AAA111']], 'no file');
  ok(!r.log.includes('download'), 'no file to check');
});
Deno.test('a file that is not a PDF is refused and deleted, whatever its name says', async () => {
  const r = rig({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) }); await refuse(() => attachOwnLabel(r.deps, { order_id: ORD, path: FILE }), 400, /not a PDF/, 'png');
  ok(r.log.includes('remove') && !r.log.includes('rpc:attach_own_label'), 'deleted, database never asked');
});
Deno.test('a file over 2 MB is refused and deleted', async () => {
  const r = rig({ bytes: pdfBytes(2 * 1024 * 1024 + 1) }); await refuse(() => attachOwnLabel(r.deps, { order_id: ORD, path: FILE }), 400, /at most 2 MB/, 'big'); ok(r.log.includes('remove'), 'deleted');
  const exact = rig({ bytes: pdfBytes(2 * 1024 * 1024) }); ok((await attachOwnLabel(exact.deps, { order_id: ORD, path: FILE })).ok, 'exactly 2 MB is fine');
});
Deno.test('a file that was never uploaded is refused', async () => { const r = rig({ bytes: null }); await refuse(() => attachOwnLabel(r.deps, { order_id: ORD, path: FILE }), 400, /was not uploaded/, 'missing'); });
Deno.test('a path outside this customer\'s own order folder is refused before anything is downloaded', async () => {
  for (const path of [`${OTHER}/${ORD}/55555555-5555-5555-5555-555555555555.pdf`, `${ORG}/${OTHER}/55555555-5555-5555-5555-555555555555.pdf`, `${ORG}/${ORD}/../x.pdf`.replace('../x', 'x'), `${ORG}/${ORD}/photo.png`]) {
    const r = rig(); await refuse(() => attachOwnLabel(r.deps, { order_id: ORD, path }), 400, /Invalid label file/, path); ok(!r.log.includes('download'), 'no download for ' + path);
  }
});
Deno.test('another customer\'s order looks exactly like a missing one', async () => {
  for (const o of [{ org_id: OTHER }, null] as const) { const r = rig({ order: o }); await refuse(() => attachOwnLabel(r.deps, { order_id: ORD, tracking: 'AAA111' }), 404, /Order not found/, 'attach'); await refuse(() => status(r.deps, ORD), 404, /Order not found/, 'status'); await refuse(() => removeOwnLabel(r.deps, { order_id: ORD }), 404, /Order not found/, 'remove'); ok(!r.log.some((x) => x.startsWith('rpc')), 'the database is never asked'); }
});
Deno.test('only owner, operations and staff members can prepare shipping; finance and marketing cannot', async () => {
  for (const role of ['finance', 'marketing', 'viewer', '']) { const r = rig({ role }); await refuse(() => attachOwnLabel(r.deps, { order_id: ORD, tracking: 'AAA111' }), 403, /cannot prepare shipping/, role); await refuse(() => removeOwnLabel(r.deps, { order_id: ORD }), 403, /cannot prepare/, role); }
  for (const role of ['owner', 'operations', 'staff']) ok((await attachOwnLabel(rig({ role }).deps, { order_id: ORD, tracking: 'AAA111' })).ok, role + ' may');
});
Deno.test('an invalid order id is refused at once', async () => { for (const id of [undefined, null, '', 'abc', 5, '../x']) await refuse(() => attachOwnLabel(rig().deps, { order_id: id, tracking: 'AAA111' }), 400, /Invalid order/, String(id)); });
Deno.test('a database refusal is passed on and the new file is cleaned up', async () => {
  const r = rig({ rpcError: 'This order is shipped, so a label can no longer be added' }); await refuse(() => attachOwnLabel(r.deps, { order_id: ORD, path: FILE }), 400, /can no longer be added/, 'refused');
  eq(r.calls.remove, [FILE], 'the orphan file is deleted');
});
Deno.test('replacing a label deletes the old file, but never the one just added', async () => {
  const old = `${ORG}/${ORD}/66666666-6666-6666-6666-666666666666.pdf`; let r = rig({ replaced: old }); await attachOwnLabel(r.deps, { order_id: ORD, path: FILE }); eq(r.calls.remove, [old], 'old file removed');
  r = rig({ replaced: FILE }); await attachOwnLabel(r.deps, { order_id: ORD, path: FILE }); ok(!r.log.includes('remove'), 'same path is kept');
});
Deno.test('removing a label deletes its file', async () => {
  const r = rig({ rpc: async (n) => { return { data: FILE, error: null }; } }); eq(await removeOwnLabel(r.deps, { order_id: ORD }), { ok: true }, 'ok'); eq(r.calls.remove, [FILE], 'file deleted');
  const none = rig({ rpc: async () => ({ data: null, error: null }) }); await removeOwnLabel(none.deps, { order_id: ORD }); ok(!none.log.includes('remove'), 'nothing to delete');
});
Deno.test('capabilities say what this customer can do: own labels on full and payg only, buying is off', async () => {
  eq(await capabilities(rig({ modeIs: 'payg' }).deps), { mode: 'payg', can_prepare: true, own_label: true, buy_label: false }, 'payg');
  eq((await capabilities(rig({ modeIs: 'full' }).deps)).own_label, true, 'full'); eq((await capabilities(rig({ modeIs: 'storage' }).deps)).own_label, false, 'storage only');
  eq((await capabilities(rig({ modeIs: 'payg', role: 'finance' }).deps)).own_label, false, 'finance role');
});
Deno.test('status returns the label without internals', async () => {
  const r = rig({ ownLabel: async () => ({ filename: 'a.pdf', storage_path: FILE, tracking_numbers: ['AAA111'], carrier_name: 'DPD', created_at: '2026-10-06T10:00:00Z' }) });
  const s = await status(r.deps, ORD); eq([s.order.ref, s.own_label?.filename, s.own_label?.has_file, s.own_label?.tracking_numbers, s.own_label?.carrier], ['ORD-000001', 'a.pdf', true, ['AAA111'], 'DPD'], 'fields');
  eq((await status(rig().deps, ORD)).own_label, null, 'none yet');
});
