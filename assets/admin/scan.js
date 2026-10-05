import { el, clear } from './ui.js';
import { uploadPhotos } from './wms.js';

// Phone / handheld scanner app for the warehouse: receive deliveries and put goods away. A keyboard-wedge scanner types into the
// big input and presses Enter; on phones the camera button uses the browser's BarcodeDetector where it exists.
// Every write is a database function that checks the role and is safe to repeat (idempotency key).
const SUPABASE_URL = 'https://hvbcmilcjragrcezwzlo.supabase.co';
const ANON = window.__ANON__;
const sb = window.supabase.createClient(SUPABASE_URL, ANON);
const app = document.getElementById('app');
const key = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
let audio;
const beep = (good = true) => { try { navigator.vibrate && navigator.vibrate(good ? 40 : [80, 60, 80]); audio = audio || new AudioContext(); const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = good ? 880 : 220; g.gain.value = 0.08; o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + (good ? 0.08 : 0.25)); } catch { /* sound is optional */ } };
const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args); if (error) throw new Error(error.message); return data; };
let orgs = [];
const orgName = (id) => (orgs.find((o) => o.id === id) || {}).name || '';

const msg = el('div', { class: 'msg', role: 'status' });
const say = (text, bad) => { msg.textContent = text; msg.className = 'msg' + (bad ? ' bad' : text ? ' good' : ''); beep(!bad); };

function scanInput(onCode, placeholder) {
  const i = el('input', { class: 'scan', type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'off', placeholder: placeholder || 'Scan or type a code', 'aria-label': 'Scan a barcode' });
  const submit = () => { const v = i.value.trim(); i.value = ''; if (v) onCode(v); i.focus(); };
  i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  const cam = 'BarcodeDetector' in window && navigator.mediaDevices ? el('button', { class: 'btn ghost', text: 'Camera', onclick: () => camera(onCode) }) : null;
  setTimeout(() => i.focus(), 50);
  return el('div', { class: 'scanrow' }, i, el('button', { class: 'btn', text: 'OK', onclick: submit }), cam);
}
async function camera(onCode) {
  const v = el('video', { playsinline: 'true', autoplay: 'true', muted: 'true' }), wrap = el('div', { class: 'cam' }, v, el('button', { class: 'btn', text: 'Close' }));
  document.body.append(wrap); let stream, stop = false;
  const end = () => { stop = true; stream && stream.getTracks().forEach((t) => t.stop()); wrap.remove(); };
  wrap.querySelector('button').onclick = end;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); v.srcObject = stream; await v.play();
    const det = new BarcodeDetector();
    const loop = async () => { if (stop) return; try { const r = await det.detect(v); if (r[0]) { end(); onCode(r[0].rawValue); return; } } catch { /* try again */ } requestAnimationFrame(loop); };
    loop();
  } catch { end(); say('Camera not available. Use a scanner or type the code.', true); }
}

const shell = (title, back, ...kids) => clear(app).append(el('header', { class: 'bar' }, back ? el('button', { class: 'back', text: '‹', 'aria-label': 'Back', onclick: back }) : el('span', { class: 'logo', text: '2ACE' }), el('strong', { text: title }), el('a', { class: 'out', href: '/admin', text: 'Admin' })), el('main', {}, msg, ...kids));

// First photo of a product, so the person at the shelf can check they hold the right thing. Optional: no photo, no picture.
async function productPhoto(productId) {
  try {
    const { data } = await sb.from('products').select('photo_paths').eq('id', productId).maybeSingle();
    const path = data && (data.photo_paths || [])[0]; if (!path) return null;
    const { data: sg } = await sb.storage.from('products').createSignedUrl(path, 3600);
    return sg && sg.signedUrl ? el('img', { src: sg.signedUrl, alt: '', class: 'pimg' }) : null;
  } catch { return null; }
}

// Tell the customer (and our inbox) about the differences, once. A failure here never undoes the receiving.
async function notify(bookingId) {
  try {
    const { data } = await sb.auth.getSession();
    const r = await fetch(SUPABASE_URL + '/functions/v1/admin-api', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + data.session.access_token }, body: JSON.stringify({ action: 'discrepancy.notify', booking_id: bookingId }) });
    return r.ok ? ', customer emailed' : ', customer email failed';
  } catch { return ', customer email failed'; }
}

// ---------- home ----------
async function home() {
  say('');
  shell('Warehouse', null,
    el('div', { class: 'tiles' }, el('button', { class: 'tile', onclick: receiveList }, el('b', { text: 'Receive' }), el('span', { text: 'Book goods in against a delivery' })), el('button', { class: 'tile', onclick: moveStart }, el('b', { text: 'Put away' }), el('span', { text: 'Move goods from receiving to a bin' }))));
}

// ---------- receive ----------
async function receiveList() {
  shell('Receive', home, el('p', { class: 'muted', text: 'Loading deliveries…' }));
  const { data, error } = await sb.from('inbound_bookings').select('id, org_id, ref, status, expected_date, carrier, inbound_lines(expected_qty)').in('status', ['booked', 'receiving']).order('expected_date', { ascending: true, nullsFirst: false });
  if (error) return say(error.message, true);
  shell('Receive', home, data.length ? el('div', { class: 'list' }, data.map((b) => el('button', { class: 'row', onclick: () => receive(b.id) }, el('b', { text: b.ref }), el('span', { text: orgName(b.org_id) + (b.carrier ? ' · ' + b.carrier : '') }), el('small', { text: b.inbound_lines.reduce((s, l) => s + l.expected_qty, 0) + ' units · ' + b.status })))) : el('p', { class: 'muted', text: 'No deliveries are waiting.' }));
}
async function receive(id, current) {
  const b = (await sb.from('inbound_bookings').select('*').eq('id', id).maybeSingle()).data;
  if (!b) return receiveList();
  const [ln, rc] = await Promise.all([sb.from('inbound_lines').select('product_id, expected_qty, products(sku, name)').eq('booking_id', id), sb.from('receipt_lines').select('product_id, qty, condition').eq('booking_id', id)]);
  const got = (pid, c) => (rc.data || []).filter((r) => r.product_id === pid && r.condition === c).reduce((s, r) => s + r.qty, 0);
  const qty = el('input', { class: 'qty', type: 'number', inputmode: 'numeric', min: '1', value: '1', 'aria-label': 'Quantity' });
  const photos = el('input', { type: 'file', accept: 'image/*', capture: 'environment', multiple: true, 'aria-label': 'Photos of the damage' });
  const post = async (p, cond) => {
    try {
      const r = await rpc('receive_line', { p_booking: id, p_product: p.id, p_qty: Number(qty.value), p_condition: cond, p_lot: '', p_expiry: null, p_note: null, p_key: key() });
      let note = '';
      if (cond === 'damaged' && photos.files.length) { try { const paths = await uploadPhotos({ sb }, b.org_id, id, photos.files); await rpc('add_receipt_photos', { p_line: r.receipt_id, p_paths: paths }); note = ' with photos'; } catch (e) { note = ' (photos failed: ' + e.message + ')'; } }
      say(r.condition === 'unexpected' ? 'Received, but NOT on the booking' : cond === 'damaged' ? 'Damaged goods booked to quarantine' + note : 'Booked in', r.condition === 'unexpected'); receive(id);
    } catch (e) { say(e.message, true); }
  };
  const onCode = async (code) => {
    try {
      const r = await rpc('wms_lookup', { p_code: code, p_org: b.org_id });
      if (r.type !== 'product') return say('No product with that code for ' + orgName(b.org_id), true);
      receive(id, r);
    } catch (e) { say(e.message, true); }
  };
  const pic = current ? await productPhoto(current.id) : null;
  shell(b.ref, receiveList,
    el('p', { class: 'muted', text: orgName(b.org_id) + (b.tracking ? ' · ' + b.tracking : '') }),
    current ? el('div', { class: 'card' }, pic, el('b', { text: current.sku }), el('div', { text: current.name }), el('div', { class: 'row2' }, el('span', { text: 'Quantity' }), qty),
      el('label', { class: 'photo' }, el('small', { class: 'muted', text: 'Photos if damaged (optional)' }), photos),
      el('div', { class: 'row2' }, el('button', { class: 'btn big', text: 'Good', onclick: () => post(current, 'good') }), el('button', { class: 'btn big warn', text: 'Damaged', onclick: () => post(current, 'damaged') })),
      el('button', { class: 'btn ghost', text: 'Scan something else', onclick: () => receive(id) })) : scanInput(onCode, 'Scan a product'),
    el('div', { class: 'list' }, (ln.data || []).map((l) => { const g = got(l.product_id, 'good'); return el('div', { class: 'row static' + (g >= l.expected_qty ? ' done' : '') }, el('b', { text: l.products.sku }), el('span', { text: l.products.name }), el('small', { text: `${g} / ${l.expected_qty} good` + (got(l.product_id, 'damaged') ? ` · ${got(l.product_id, 'damaged')} damaged` : '') })); })),
    el('button', { class: 'btn ghost', text: 'Finish delivery', onclick: async () => { if (!confirm('Finish receiving? Differences become discrepancies and this cannot be undone.')) return; try { const r = await rpc('receive_close', { p_booking: id }); let told = ''; if (r.discrepancies) told = await notify(id); say(r.discrepancies ? r.discrepancies + ' differences recorded' + told : 'Delivery complete', !!r.discrepancies); receiveList(); } catch (e) { say(e.message, true); } } }));
}

// ---------- put away ----------
async function moveStart(product) {
  const onCode = async (code) => {
    try {
      const r = await rpc('wms_lookup', { p_code: code });
      if (r.type !== 'product') return say('Scan a product barcode first', true);
      if (r.ambiguous) return say('That code belongs to products of more than one customer. Scan the barcode instead.', true);
      moveStart(r);
    } catch (e) { say(e.message, true); }
  };
  if (!product || !product.id) return shell('Put away', home, scanInput(onCode, 'Scan the product'));
  const { data } = await sb.from('stock_levels').select('org_id, product_id, location_id, lot, on_hand, reserved, locations(code, kind)').eq('product_id', product.id).gt('on_hand', 0);
  const rows = (data || []).filter((r) => r.locations.kind === 'receiving' && r.on_hand - r.reserved > 0);
  if (!rows.length) { shell('Put away', home, el('div', { class: 'card' }, el('b', { text: product.sku }), el('div', { text: 'Nothing waiting in the receiving area.' })), scanInput(onCode, 'Scan another product')); return; }
  moveTo(product, rows[0], rows);
}
async function moveTo(product, row, rows) {
  const pic = await productPhoto(product.id);
  const free = row.on_hand - row.reserved;
  const qty = el('input', { class: 'qty', type: 'number', inputmode: 'numeric', min: '1', max: String(free), value: String(free), 'aria-label': 'Quantity' });
  const onCode = async (code) => {
    try {
      const r = await rpc('wms_lookup', { p_code: code });
      if (r.type !== 'location') return say('Scan the bin label', true);
      await rpc('putaway', { p_org: row.org_id, p_product: product.id, p_from: row.location_id, p_to: r.id, p_qty: Number(qty.value), p_lot: row.lot, p_key: key() });
      say(`Moved ${qty.value} × ${product.sku} to ${r.code}`); moveStart();
    } catch (e) { say(e.message, true); }
  };
  shell('Put away', () => moveStart(), el('div', { class: 'card' }, pic, el('b', { text: product.sku }), el('div', { text: product.name }), el('small', { class: 'muted', text: orgName(row.org_id) + ' · ' + free + ' waiting at ' + row.locations.code }), el('div', { class: 'row2' }, el('span', { text: 'Quantity' }), qty)),
    el('p', { class: 'hint', text: 'Now scan the bin label' }), scanInput(onCode, 'Scan the bin'));
}

// ---------- start ----------
(async () => {
  const { data } = await sb.auth.getSession();
  if (!data.session) { location.replace('/login?next=%2Fscan'); return; }
  const { data: st } = await sb.from('staff_users').select('role, active').eq('user_id', data.session.user.id).maybeSingle();
  if (!st || !st.active || !['warehouse', 'admin'].includes(st.role)) return shell('Warehouse', null, el('p', { class: 'err', text: 'This account is not set up for warehouse work. Ask an admin.' }));
  try { orgs = await rpc('wms_orgs'); } catch (e) { return shell('Warehouse', null, el('p', { class: 'err', text: st.role === 'admin' ? 'Admins need the two-step check. Sign in at /admin first, then come back here.' : e.message })); }
  home();
})().catch((e) => shell('Warehouse', null, el('p', { class: 'err', text: String(e.message || e) })));
