// deno test supabase/functions/_shared/shipping.test.ts
import { buildPackage, parseQuotes, customerNet, customerGross, spendCheck, settingNum, carriersFrom, warsawDayStart, extractTracking, SENDER, DEFAULT_CARRIERS } from './shipping.ts';
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const order = { ref: 'ORD-000007', ship_name: 'Jan Nowak', ship_company: null, ship_line1: 'Prosta 1', ship_line2: '4', ship_postal: '00-001', ship_city: 'Warszawa', ship_country: 'pl', ship_email: 'jan@example.pl', ship_phone: ' +48600100200 ' };

Deno.test('the sender is the Box 17 warehouse in Puchały, with the company contact details', () => {
  eq([SENDER.street, SENDER.postcode, SENDER.city, SENDER.country_code, SENDER.email, SENDER.phone], ['Żwirowa 66', '05-090', 'Puchały', 'PL', 'hello@2ace.pl', '608180946'], 'sender');
  ok(SENDER.company.includes('Box 17'), 'the box is on the label');
});
Deno.test('buildPackage: Furgonetka field names, sizes rounded up, weight in kg, country upper-cased, empty fields left out', () => {
  const p = buildPackage(order, [{ weight_g: 1800, length_cm: 30, width_cm: 20.2, height_cm: '15' }, { weight_g: 5, length_cm: 0.2, width_cm: 1, height_cm: 1 }], 12056165) as Record<string, any>;
  eq(p.service_id, 12056165, 'service'); eq(p.pickup, SENDER, 'pickup'); eq(p.user_reference_number, 'ORD-000007', 'reference');
  eq(p.receiver, { name: 'Jan Nowak', street: 'Prosta 1 4', postcode: '00-001', city: 'Warszawa', country_code: 'PL', email: 'jan@example.pl', phone: '+48600100200' }, 'receiver (no company key when empty)');
  eq(p.parcels[0], { type: 'package', width: 21, depth: 30, height: 15, weight: 1.8, description: 'E-commerce goods' }, 'parcel 1: width 20.2 → 21, length is "depth"');
  eq([p.parcels[1].depth, p.parcels[1].weight], [1, 0.01], 'tiny parcel is raised to the minimums');
});
Deno.test('buildPackage without a service id leaves it out (used for price comparison), and refuses an order without parcels', () => {
  ok(!('service_id' in (buildPackage(order, [{ weight_g: 1000, length_cm: 10, width_cm: 10, height_cm: 10 }]) as object)), 'no service_id');
  try { buildPackage(order, []); throw new Error('should fail'); } catch (e) { ok(/no parcels/.test((e as Error).message), 'refused'); }
});
const raw = { services_prices: [
  { service_id: 3, service: 'ups', available: true, pricing: { price_net: 20, price_gross: 24.6, tax: 23 }, shipment_type: 'package', delivery_type: 'door' },
  { service_id: 1, service: 'inpost', available: false, errors: [{ message: 'Parcel too heavy' }], pricing: { price_net: 0, price_gross: 0 } },
  { service_id: 2, service: 'dpd', available: true, pricing: { price_net: 12.5, price_gross: 15.38 } },
  { service_id: 4, service: 'dhl', available: true, pricing: { price_net: 0, price_gross: 0 } } ] };
Deno.test('parseQuotes: cheapest available first, unavailable last with the reason, a zero price is not offered', () => {
  const q = parseQuotes(raw);
  eq(q.map((x) => x.service_id), [2, 3, 1, 4], 'order'); eq(q.map((x) => x.available), [true, true, false, false], 'availability');
  eq(q[2].reason, 'Parcel too heavy', 'reason'); eq(q[3].reason, 'Not available for this parcel', 'zero price has a reason');
  eq([q[0].cost_net, q[0].cost_gross, q[0].tax], [12.5, 15.38, 23], 'tax worked out when Furgonetka omits it');
  eq(q[1].name, 'UPS · package, door', 'name'); eq(parseQuotes(null), [], 'garbage in, nothing out'); eq(parseQuotes({ services_prices: 'x' }), [], 'not a list');
});
Deno.test('the 30% markup applies to the net cost, VAT is added after', () => {
  eq(customerNet(10, 30), 13, 'net'); eq(customerGross(10, 30, 23), 15.99, 'gross'); eq(customerNet(12.5, 30), 16.25, '12.50 → 16.25'); eq(customerNet(9.99, 30), 12.99, 'rounded to grosze'); eq(customerNet(10, 0), 10, 'zero markup');
});
const base = { enabled: true, role: 'warehouse', costGross: 20, balance: 100, maxLabel: 80, dailyCap: 500, spentToday: 0, overLimitConfirmed: false };
Deno.test('spendCheck: the happy path goes ahead', () => { eq(spendCheck(base), null, 'ok'); });
Deno.test('spendCheck: the kill switch, unreadable balance and an invalid price refuse', () => {
  ok(/switched off/.test(spendCheck({ ...base, enabled: false })!), 'switch'); ok(/Could not read the Furgonetka balance/.test(spendCheck({ ...base, balance: null })!), 'balance unknown'); ok(/Could not read/.test(spendCheck({ ...base, balance: NaN })!), 'NaN balance');
  ok(/not valid/.test(spendCheck({ ...base, costGross: 0 })!), 'zero'); ok(/not valid/.test(spendCheck({ ...base, costGross: -5 })!), 'negative');
});
Deno.test('spendCheck: not enough balance names both amounts; exactly enough is fine', () => {
  const m = spendCheck({ ...base, costGross: 20, balance: 15.5 })!; ok(/20,00 zł/.test(m) && /15,50 zł/.test(m) && /Top up/.test(m), m); eq(spendCheck({ ...base, costGross: 20, balance: 20 }), null, 'exact');
});
Deno.test('spendCheck: the daily cap cannot be overridden, even by an admin', () => {
  ok(/daily limit/.test(spendCheck({ ...base, spentToday: 490, costGross: 20 })!), 'warehouse'); ok(/daily limit/.test(spendCheck({ ...base, role: 'admin', overLimitConfirmed: true, spentToday: 490, costGross: 20 })!), 'admin with confirm');
  eq(spendCheck({ ...base, spentToday: 480, costGross: 20 }), null, 'exactly at the cap is allowed');
});
Deno.test('spendCheck: over the per-label limit needs an admin AND an explicit confirmation', () => {
  const big = { ...base, costGross: 120, balance: 500 };
  ok(/An admin has to confirm/.test(spendCheck(big)!), 'warehouse'); ok(/An admin has to confirm/.test(spendCheck({ ...big, overLimitConfirmed: true })!), 'warehouse cannot self-confirm');
  ok(/Confirm to buy it anyway/.test(spendCheck({ ...big, role: 'admin' })!), 'admin must confirm'); eq(spendCheck({ ...big, role: 'admin', overLimitConfirmed: true }), null, 'admin confirmed');
});
Deno.test('settings fall back to defaults for missing, empty or silly values', () => {
  const g = (m: Record<string, string>) => (k: string) => m[k];
  eq(settingNum(g({}), 'X', 30), 30, 'missing'); eq(settingNum(g({ X: '' }), 'X', 30), 30, 'empty'); eq(settingNum(g({ X: 'abc' }), 'X', 30), 30, 'text'); eq(settingNum(g({ X: '-5' }), 'X', 30), 30, 'negative'); eq(settingNum(g({ X: '45.5' }), 'X', 30), 45.5, 'valid'); eq(settingNum(g({ X: '0' }), 'X', 30), 0, 'zero is allowed'); eq(settingNum(g({ X: '9999' }), 'X', 30, 0, 500), 30, 'above max');
  eq(carriersFrom(g({})), DEFAULT_CARRIERS, 'default carriers'); eq(carriersFrom(g({ SHIPPING_CARRIERS: ' DPD, inpost ,,bad carrier!' })), ['dpd', 'inpost'], 'cleaned list'); eq(carriersFrom(g({ SHIPPING_CARRIERS: '!!' })), DEFAULT_CARRIERS, 'nothing valid → default');
});
Deno.test('the Polish day starts at midnight local time in summer and in winter', () => {
  eq(warsawDayStart(new Date('2026-07-15T10:00:00Z')).toISOString(), '2026-07-14T22:00:00.000Z', 'summer (UTC+2)'); eq(warsawDayStart(new Date('2026-12-15T10:00:00Z')).toISOString(), '2026-12-14T23:00:00.000Z', 'winter (UTC+1)');
  eq(warsawDayStart(new Date('2026-07-15T21:59:00Z')).toISOString(), '2026-07-14T22:00:00.000Z', 'still the same Polish day just before midnight'); eq(warsawDayStart(new Date('2026-07-15T22:01:00Z')).toISOString(), '2026-07-15T22:00:00.000Z', 'the next Polish day just after');
});
Deno.test('extractTracking collects waybill numbers once', () => {
  eq(extractTracking({ package_no: 'A1', parcels: [{ package_no: 'A1' }, { package_no: 'B2' }, { waybill_number: 'C3' }, {}] }), ['A1', 'B2', 'C3'], 'unique'); eq(extractTracking({}), [], 'none');
});
