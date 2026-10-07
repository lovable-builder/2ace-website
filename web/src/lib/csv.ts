// Orders from a CSV file: one row per product on an order, rows with the same order_ref become one order.
// A minimal reader: quoted fields, commas or semicolons (Excel in Poland saves with semicolons).
export function parseCsv(text: string): string[][] {
  const first = text.split(/\r?\n/)[0] || '';
  const d = first.split(';').length > first.split(',').length ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === d) { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export type CsvShip = { name: string; company: string; email: string; phone: string; line1: string; line2: string; postal: string; city: string; country: string };
export type CsvOrder = { external_ref: string; notes: string | null; ship: CsvShip; lines: { sku: string; qty: number }[] };

// Errors carry a key (for translation) and values.
export class CsvError extends Error {
  constructor(public key: string, public vars: Record<string, string | number> = {}) { super(key.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))); }
}

const ALIAS: Record<string, string[]> = {
  order_ref: ['order_ref', 'order', 'reference', 'order_number', 'order_no'], name: ['name', 'recipient', 'recipient_name', 'ship_name'], company: ['company'],
  email: ['email', 'e_mail'], phone: ['phone', 'telephone', 'tel'], line1: ['address', 'street', 'line1', 'address1', 'address_line_1'], line2: ['address2', 'line2', 'address_line_2'],
  postal: ['postal', 'postal_code', 'postcode', 'zip', 'zip_code'], city: ['city', 'town'], country: ['country', 'country_code'], sku: ['sku', 'product', 'product_sku'],
  qty: ['qty', 'quantity', 'units'], notes: ['notes', 'note', 'comment'],
};
const REQUIRED = ['order_ref', 'name', 'phone', 'line1', 'postal', 'city', 'country', 'sku', 'qty'];

export function csvToOrders(text: string): CsvOrder[] {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length < 2) throw new CsvError('The file has no rows. The first row must be the column names.');
  const norm = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const head = rows[0].map(norm), at: Record<string, number> = {};
  for (const k of Object.keys(ALIAS)) at[k] = head.findIndex((h) => ALIAS[k].includes(h));
  const need = REQUIRED.filter((k) => at[k] < 0);
  if (need.length) throw new CsvError('Missing columns: {cols}. Download the template to see the expected columns.', { cols: need.map((k) => (k === 'line1' ? 'address' : k)).join(', ') });
  const by = new Map<string, CsvOrder>();
  rows.slice(1).forEach((r, i) => {
    const g = (k: string) => (at[k] >= 0 ? (r[at[k]] || '').trim() : '');
    const ref = g('order_ref');
    if (!ref) throw new CsvError('Row {row} has no order_ref. Every row needs your order number, so a re-import never creates duplicates.', { row: i + 2 });
    if (!by.has(ref)) by.set(ref, { external_ref: ref, notes: g('notes') || null, ship: { name: g('name'), company: g('company'), email: g('email'), phone: g('phone'), line1: g('line1'), line2: g('line2'), postal: g('postal'), city: g('city'), country: g('country') }, lines: [] });
    const o = by.get(ref)!, sku = g('sku'), qty = parseInt(g('qty'), 10);
    const ex = o.lines.find((l) => l.sku === sku);
    if (ex) ex.qty += qty || 0; else o.lines.push({ sku, qty });
  });
  return Array.from(by.values());
}

export const CSV_MAX_ORDERS = 200;
export const CSV_MAX_BYTES = 2000000;
export const CSV_TEMPLATE = 'order_ref,name,company,email,phone,address,address2,postal,city,country,sku,qty,notes\n'
  + 'SHOP-1001,Jan Nowak,,jan@example.pl,+48600100200,Prosta 1,,00-001,Warszawa,PL,MUG-BLUE,2,\n'
  + 'SHOP-1001,Jan Nowak,,jan@example.pl,+48600100200,Prosta 1,,00-001,Warszawa,PL,MUG-RED,1,\n'
  + 'SHOP-1002,Anna Schmidt,,,,Hauptstr. 5,,10115,Berlin,DE,MUG-BLUE,4,Gift\n';
