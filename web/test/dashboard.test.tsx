import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { baseRoutes, callsTo, mockFetch, ORG, renderApp, signIn, status, text, until, where, type Handler } from './harness';

const INV = [
  { product_id: 'p1', sku: 'MUG-BLUE', name: 'Blue mug', active: true, on_hand: 10, available: 8, unplaced: 1, quarantined: 1, incoming: 0, photo_paths: ['o1/p1/a.jpg'] },
  { product_id: 'p2', sku: 'MUG-RED', name: 'Red mug', active: true, on_hand: 0, available: 0, unplaced: 0, quarantined: 0, incoming: 0, photo_paths: null },
  { product_id: 'p3', sku: 'OLD', name: 'Old thing', active: false, on_hand: 0, available: 0, unplaced: 0, quarantined: 0, incoming: 5, photo_paths: null },
];
const line = (pid: string, sku: string, name: string) => ({ product_id: pid, products: { sku, name } });
const ORDER = (o: object) => ({ id: 'or1', ref: 'O-0001', external_ref: 'SHOP-1', status: 'allocated', label_source: null, hold_reason: null, details_request_note: null, ship_name: 'Jan Kowalski', ship_line1: 'Prosta 1', ship_line2: 'm. 4', ship_postal: '00-001', ship_city: 'Warszawa', ship_country: 'PL', ship_phone: '600100200', ship_email: 'jan@x.pl', created_at: '2026-10-01T10:00:00Z', shipped_at: null, order_lines: [{ ...line('p1', 'MUG-BLUE', 'Blue mug'), qty: 2 }], ...o });

function app(path: string, extra: Record<string, Handler> = {}) {
  signIn();
  const calls = mockFetch({ ...baseRoutes(), 'GET /rest/v1/v_inventory_by_product': () => INV, ...extra });
  return { calls, ...renderApp(path) };
}

describe('overview', () => {
  it('greets the company, shows the live plan, the journey of the goods and the checklist', async () => {
    app('/dashboard', {
      'GET /rest/v1/inbound_bookings': () => [{ id: 'b1', ref: 'IN-1', status: 'booked', inbound_lines: [] }],
      'GET /rest/v1/orders': () => [ORDER({}), ORDER({ id: 'or2', status: 'held' }), ORDER({ id: 'or3', status: 'shipped', shipped_at: new Date().toISOString() })],
    });
    await until(() => expect(text()).toContain('Acme'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^Good (morning|afternoon|evening), Acme$/);
    expect(text()).toContain('Your plan is live.');
    await until(() => expect(screen.getByRole('button', { name: /^Booked: 1\./ })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^On your shelf: 8\./ })).toHaveClass('on');
    expect(screen.getByRole('button', { name: /^Picking: 0\./ })).not.toHaveClass('on');
    expect(screen.getByRole('button', { name: /^Shipped: 1\./ })).toBeInTheDocument();
    expect(text()).toContain('1 on hold');
    expect(text()).toContain('1 order is on hold because some stock is missing.');
    const steps = document.querySelectorAll('.checklist .step.done');
    expect(steps).toHaveLength(3);   // plan active, products added, delivery booked
    expect(text()).toContain('3 000 zł');
  });

  it('before anything loads the journey shows dashes, not made-up zeros; tapping a step opens its tab', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { user } = app('/dashboard', { 'GET /rest/v1/inbound_bookings': async () => { await gate; return []; } });
    await until(() => expect(screen.getByRole('button', { name: /^Booked: loading/ })).toBeInTheDocument());
    release();
    await until(() => expect(screen.getByRole('button', { name: /^Booked: 0\./ })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /^On your shelf/ }));
    expect(where).toBe('/dashboard/inventory');
  });

  it('a company without a domain is offered one', async () => {
    const { user } = app('/dashboard');
    await until(() => expect(text()).toContain('Get your own .pl domain.'));
    expect(screen.getByRole('link', { name: /Domain\s*New/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choose a domain' }));
    expect(where).toBe('/dashboard/domain');
  });
});

describe('inventory and products', () => {
  it('inventory lists only products with stock or incoming, with thumbnails from signed links', async () => {
    app('/dashboard/inventory', { 'POST /storage/v1/object/sign/products': (c) => c.body.paths.map((p: string) => ({ path: p, signedURL: '/object/sign/products/' + p + '?token=t' })) });
    await until(() => expect(text()).toContain('MUG-BLUE'));
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3);   // header + MUG-BLUE + OLD (incoming)
    expect(text()).not.toContain('MUG-RED');
    expect(within(rows[1]).getAllByRole('cell').map((c) => c.textContent)).toEqual(['MUG-BLUEBlue mug', '10', '8', '2', '0']);
    expect(rows[1].querySelector('img')?.getAttribute('src')).toBe('https://proj.supabase.co/storage/v1/object/sign/products/o1/p1/a.jpg?token=t');
  });

  it('reads are made with the customer\'s own token', async () => {
    const { calls } = app('/dashboard/inventory');
    await until(() => expect(text()).toContain('MUG-BLUE'));
    const r = callsTo(calls, 'GET /rest/v1/v_inventory_by_product')[0];
    expect(r.headers.Authorization).toBe('Bearer tok'); expect(r.headers.apikey).toBe('anon-key');
  });

  it('adds a product, refuses an empty one without asking the server, and shows a database refusal', async () => {
    let fail = true;
    const { calls, user } = app('/dashboard/products', { 'POST /rest/v1/rpc/create_product': () => (fail ? status(400, { message: 'That SKU already exists' }) : 'p9') });
    await until(() => expect(text()).toContain('MUG-BLUE'));
    await user.click(screen.getByRole('button', { name: 'Add a product' }));
    await user.click(screen.getByRole('button', { name: 'Save product' }));
    expect(text()).toContain('Enter a SKU and a product name.');
    expect(callsTo(calls, 'POST /rest/v1/rpc/create_product')).toHaveLength(0);
    await user.type(screen.getByRole('textbox', { name: 'SKU' }), 'CUP-1');
    await user.type(screen.getByRole('textbox', { name: 'Product name' }), 'Cup');
    await user.type(screen.getByRole('textbox', { name: 'Barcode (EAN), optional' }), '5901234123457');
    await user.click(screen.getByRole('button', { name: 'Save product' }));
    await until(() => expect(text()).toContain('That SKU already exists'));
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Save product' }));
    await until(() => expect(text()).toContain('Product added.'));
    expect(callsTo(calls, 'POST /rest/v1/rpc/create_product').at(-1)!.body).toEqual({ p_org: 'o1', p_sku: 'CUP-1', p_name: 'Cup', p_ean: '5901234123457' });
  });

  it('editing a product is a request for approval; nothing is written directly', async () => {
    const { calls, user } = app('/dashboard/products', { 'POST /functions/v1/change-request': () => ({ ok: true }) });
    await until(() => expect(text()).toContain('MUG-BLUE'));
    await user.click(screen.getAllByRole('button', { name: 'Request edit' })[0]);
    const name = screen.getByRole('textbox', { name: 'Product name' });
    await user.clear(name); await user.type(name, 'Big blue mug');
    await user.click(screen.getByRole('button', { name: 'Send for approval' }));
    await until(() => expect(text()).toContain('Sent for approval.'));
    expect(callsTo(calls, 'POST /functions/v1/change-request')[0].body).toEqual({ action: 'request', entity: 'product', id: 'p1', kind: 'update', payload: { name: 'Big blue mug' } });
    expect(calls.some((c) => c.method !== 'GET' && /products/.test(c.path) && !/sign/.test(c.path))).toBe(false);
  });

  it('a product with a pending request shows it, hides Request edit, and the request can be withdrawn', async () => {
    const { calls, user } = app('/dashboard/products', {
      'GET /rest/v1/change_requests': () => [{ id: 'cr1', entity_id: 'p1', summary: 'Rename to Big mug', status: 'pending', decision_note: null }, { id: 'cr0', entity_id: 'p2', summary: 'x', status: 'rejected', decision_note: 'Barcode belongs to another product' }],
      'POST /functions/v1/change-request': () => ({ ok: true }),
    });
    await until(() => expect(text()).toContain('Waiting for approval: Rename to Big mug'));
    expect(text()).toContain('Last request declined: Barcode belongs to another product');
    expect(screen.getAllByRole('button', { name: 'Request edit' })).toHaveLength(2);   // p2 and p3, not p1
    await user.click(screen.getByRole('button', { name: 'Cancel request' }));
    await until(() => expect(callsTo(calls, 'POST /functions/v1/change-request')[0].body).toEqual({ action: 'cancel', id: 'cr1' }));
  });
});

describe('inbound', () => {
  it('books a delivery with every line; refuses empty, duplicate and zero lines in the browser', async () => {
    const { calls, user } = app('/dashboard/inbound', { 'POST /rest/v1/rpc/book_inbound': () => 'b1' });
    await until(() => expect(text()).toContain('No deliveries yet'));
    await user.click(screen.getByRole('button', { name: 'Book a delivery' }));
    expect(within(screen.getByRole('combobox', { name: 'Product' })).queryByText(/OLD/)).toBeNull();   // switched-off products are not offered
    await user.click(screen.getByRole('button', { name: 'Book delivery' }));
    expect(text()).toContain('Add at least one product to the delivery.');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(text()).toContain('Choose a product first.');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Product' }), 'p1');
    await user.clear(screen.getByRole('spinbutton', { name: 'Quantity' })); await user.type(screen.getByRole('spinbutton', { name: 'Quantity' }), '0');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(text()).toContain('Enter a quantity of at least 1.');
    await user.clear(screen.getByRole('spinbutton', { name: 'Quantity' })); await user.type(screen.getByRole('spinbutton', { name: 'Quantity' }), '40');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Product' }), 'p1');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(text()).toContain('That product is already on this delivery.');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Product' }), 'p2');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText('Expected arrival date'), { target: { value: '2026-10-20' } });
    await user.type(screen.getByRole('textbox', { name: 'Carrier' }), 'DSV');
    await user.click(screen.getByRole('button', { name: 'Book delivery' }));
    await until(() => expect(text()).toContain('Delivery booked.'));
    expect(callsTo(calls, 'POST /rest/v1/rpc/book_inbound')[0].body).toEqual({ p_org: 'o1', p_carrier: 'DSV', p_tracking: null, p_expected: '2026-10-20', p_notes: null, p_lines: [{ product_id: 'p1', qty: 40 }, { product_id: 'p2', qty: 1 }] });
  });

  it('lists deliveries with status, units, differences and photos; edits and deletes are requests', async () => {
    const B = (o: object) => ({ id: 'b1', ref: 'IN-0001', status: 'booked', expected_date: '2026-10-20', carrier: 'DSV', tracking: 'T1', notes: null, created_at: '2026-10-01', inbound_lines: [{ ...line('p1', 'MUG-BLUE', 'Blue mug'), expected_qty: 40 }], ...o });
    const { calls, user } = app('/dashboard/inbound', {
      'GET /rest/v1/inbound_bookings': () => [B({}), B({ id: 'b2', ref: 'IN-0002', status: 'received' }), B({ id: 'b3', ref: 'IN-0003', status: 'cancelled' })],
      'GET /rest/v1/discrepancies': () => [{ booking_id: 'b2', kind: 'short', expected_qty: 40, received_qty: 38, products: { sku: 'MUG-BLUE' } }],
      'GET /rest/v1/receipt_lines': () => [{ booking_id: 'b2', photo_paths: ['o1/b2/d.jpg'] }],
      'POST /storage/v1/object/sign/receiving': (c) => c.body.paths.map((p: string) => ({ path: p, signedURL: '/object/sign/receiving/' + p })),
      'POST /functions/v1/change-request': () => ({ ok: true }),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await until(() => expect(text()).toContain('IN-0001'));
    expect(text()).toContain('40 units');
    expect(text()).toContain('Differences found: MUG-BLUE: 38 of 40 arrived');
    expect(screen.getByRole('link', { name: 'Photo 1' })).toHaveAttribute('href', 'https://proj.supabase.co/storage/v1/object/sign/receiving/o1/b2/d.jpg');
    expect(screen.getAllByRole('button', { name: 'Request edit' })).toHaveLength(1);     // booked only
    expect(screen.getAllByRole('button', { name: 'Request delete' })).toHaveLength(2);   // booked and cancelled
    await user.click(screen.getByRole('button', { name: 'Request edit' }));
    expect(text()).toContain('Request a change to this delivery');
    expect(text()).toContain('MUG-BLUE - Blue mug × 40');
    await user.click(screen.getByRole('button', { name: 'Send for approval' }));
    await until(() => expect(text()).toContain('Sent for approval. Your delivery stays as booked'));
    expect(callsTo(calls, 'POST /functions/v1/change-request')[0].body).toEqual({ action: 'request', entity: 'inbound', id: 'b1', kind: 'update', payload: { carrier: 'DSV', tracking: 'T1', expected: '2026-10-20', notes: null, lines: [{ product_id: 'p1', qty: 40 }] } });
    expect(callsTo(calls, 'POST /rest/v1/rpc/book_inbound')).toHaveLength(0);
    await user.click(screen.getAllByRole('button', { name: 'Request delete' })[0]);
    await until(() => expect(callsTo(calls, 'POST /functions/v1/change-request')[1].body).toEqual({ action: 'request', entity: 'inbound', id: 'b1', kind: 'delete' }));
  });
});

describe('orders', () => {
  it('places an order with the recipient and lines; a reserved order sends no email', async () => {
    const { calls, user } = app('/dashboard/orders', { 'POST /rest/v1/rpc/create_order': () => ({ id: 'or9', ref: 'O-0009', status: 'allocated' }) });
    await until(() => expect(text()).toContain('No orders yet'));
    await user.click(screen.getByRole('button', { name: 'New order' }));
    expect(within(screen.getByRole('combobox', { name: 'Product' })).getByText(/MUG-BLUE - Blue mug \(8 available\)/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    expect(text()).toContain('Add at least one product to the order.');
    await user.type(screen.getByRole('textbox', { name: 'Your order number, optional' }), 'SHOP-9');
    await user.type(screen.getByRole('textbox', { name: 'Recipient first name and surname' }), 'Jan Kowalski');
    await user.type(screen.getByRole('textbox', { name: 'Recipient phone, required' }), '600100200');
    await user.type(screen.getByRole('textbox', { name: 'Street and number' }), 'Prosta 1');
    await user.type(screen.getByRole('textbox', { name: 'Postal code' }), '00-001');
    await user.type(screen.getByRole('textbox', { name: 'City' }), 'Warszawa');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Product' }), 'p1');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await until(() => expect(text()).toContain('Order O-0009 received and stock reserved.'));
    expect(callsTo(calls, 'POST /rest/v1/rpc/create_order')[0].body).toEqual({ p_org: 'o1', p_external_ref: 'SHOP-9', p_ship: { name: 'Jan Kowalski', email: '', phone: '600100200', line1: 'Prosta 1', postal: '00-001', city: 'Warszawa', country: 'PL' }, p_notes: null, p_lines: [{ product_id: 'p1', qty: 1 }], p_channel: 'manual' });
    expect(callsTo(calls, 'POST /functions/v1/change-request')).toHaveLength(0);
  });

  it('a held order tells the customer and asks the server to email; a repeated reference says so', async () => {
    let held = true;
    const { calls, user } = app('/dashboard/orders', {
      'POST /rest/v1/rpc/create_order': () => (held ? { id: 'or9', ref: 'O-0009', status: 'held' } : { id: 'or1', ref: 'O-0001', status: 'allocated', duplicate: true }),
      'POST /functions/v1/change-request': () => ({ ok: true }),
    });
    await user.click(screen.getByRole('button', { name: 'New order' }));
    await until(() => expect(screen.getByRole('combobox', { name: 'Product' }).querySelectorAll('option').length).toBeGreaterThan(1));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Product' }), 'p1');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await until(() => expect(text()).toContain('Order O-0009 is on hold: not enough stock.'));
    expect(callsTo(calls, 'POST /functions/v1/change-request')[0].body).toEqual({ action: 'order_notify', order_ids: ['or9'] });
    held = false;
    await user.click(screen.getByRole('button', { name: 'New order' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Product' }), 'p1');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await until(() => expect(text()).toContain('You already have an order with that reference: O-0001.'));
  });

  it('lists orders with plain statuses, the shortage of a held order and a correction request', async () => {
    app('/dashboard/orders', {
      'GET /rest/v1/orders': () => [
        ORDER({}), ORDER({ id: 'or2', ref: 'O-0002', status: 'held', hold_reason: 'MUG-BLUE: 2 needed, 0 available' }),
        ORDER({ id: 'or3', ref: 'O-0003', status: 'packed', details_request_note: 'The house number is missing.' }),
        ORDER({ id: 'or4', ref: 'O-0004', status: 'shipped', details_request_note: 'old note' }),
      ],
    });
    await until(() => expect(text()).toContain('O-0001'));
    expect(text()).toContain('Reserved, waiting to be picked');
    expect(text()).toContain('Your reference SHOP-1');
    expect(text()).toContain('MUG-BLUE: 2 needed, 0 available');
    expect(text()).toContain('We need a correction before we can ship this order: The house number is missing.');
    expect(text()).not.toContain('old note');
    expect(screen.getAllByRole('button', { name: 'Request cancellation' })).toHaveLength(2);   // allocated and held, not packed or shipped
    expect(screen.getAllByRole('button', { name: 'Shipping' })).toHaveLength(3);               // not the shipped one
  });

  it('cancelling asks first, then sends a cancellation request', async () => {
    const { calls, user } = app('/dashboard/orders', { 'GET /rest/v1/orders': () => [ORDER({})], 'POST /functions/v1/change-request': () => ({ ok: true }) });
    const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    await until(() => expect(text()).toContain('O-0001'));
    await user.click(screen.getByRole('button', { name: 'Request cancellation' }));
    expect(callsTo(calls, 'POST /functions/v1/change-request')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Request cancellation' }));
    await until(() => expect(text()).toContain('Cancellation requested.'));
    expect(ask).toHaveBeenCalledTimes(2);
    expect(callsTo(calls, 'POST /functions/v1/change-request')[0].body).toEqual({ action: 'request', entity: 'order', id: 'or1', kind: 'delete' });
  });

  it('imports a CSV: grouped orders, a result per order, one email request for held ones', async () => {
    const { calls, user } = app('/dashboard/orders', {
      'GET /rest/v1/orders': (c) => (c.query.includes('status=eq.held') ? [{ id: 'or11' }] : []),
      'POST /rest/v1/rpc/import_orders': () => [{ ok: true, external_ref: 'A', ref: 'O-0010', status: 'allocated' }, { ok: true, external_ref: 'B', ref: 'O-0011', status: 'held' }, { ok: false, external_ref: 'C', error: 'Unknown SKU: NOPE' }],
      'POST /functions/v1/change-request': () => ({ ok: true }),
    });
    await user.click(screen.getByRole('button', { name: 'Import CSV' }));
    const csv = 'order_ref,name,phone,address,postal,city,country,sku,qty\nA,Jan,1,S 1,00-001,W,PL,MUG-BLUE,1\nA,Jan,1,S 1,00-001,W,PL,MUG-RED,2\nB,Ola,2,S 2,00-002,W,PL,MUG-BLUE,9\nC,Ewa,3,S 3,00-003,W,PL,NOPE,1\n';
    await user.upload(screen.getByLabelText('Choose your CSV file'), new File([csv], 'orders.csv', { type: 'text/csv' }));
    await until(() => expect(text()).toContain('3 orders with 4 lines ready to import.'));
    await user.click(screen.getByRole('button', { name: 'Import orders' }));
    await until(() => expect(text()).toContain('Result for every order'));
    const sent = callsTo(calls, 'POST /rest/v1/rpc/import_orders')[0].body;
    expect(sent.p_org).toBe('o1'); expect(sent.p_orders).toHaveLength(3); expect(sent.p_orders[0].lines).toEqual([{ sku: 'MUG-BLUE', qty: 1 }, { sku: 'MUG-RED', qty: 2 }]);
    expect(text()).toContain('O-0010: reserved'); expect(text()).toContain('O-0011: on hold, not enough stock'); expect(text()).toContain('Unknown SKU: NOPE');
    expect(callsTo(calls, 'POST /functions/v1/change-request')[0].body).toEqual({ action: 'order_notify', order_ids: ['or11'] });
  });

  it('a bad or too big file is explained and nothing can be imported', async () => {
    const { user } = app('/dashboard/orders');
    await user.click(screen.getByRole('button', { name: 'Import CSV' }));
    await user.upload(screen.getByLabelText('Choose your CSV file'), new File(['order_ref,name\nA,B\n'], 'x.csv', { type: 'text/csv' }));
    await until(() => expect(text()).toContain('Missing columns: phone, address'));
    expect(screen.getByRole('button', { name: 'Import orders' })).toBeDisabled();
    const big = new File(['x'], 'big.csv', { type: 'text/csv' }); Object.defineProperty(big, 'size', { value: 3_000_000 });
    await user.upload(screen.getByLabelText('Choose your CSV file'), big);
    await until(() => expect(text()).toContain('That file is too big.'));
  });
});

describe('shipping an order', () => {
  const OFFERS = { enabled: true, offers: [
    { service_id: 11, carrier: 'inpost', name: 'InPost Kurier', available: true, bill_net: 14.5, bill_gross: 17.84 },
    { service_id: 12, carrier: 'dhl', name: 'DHL Parcel', available: true, bill_net: 19, bill_gross: 23.37 },
    { service_id: 13, carrier: 'ups', name: 'UPS Standard', available: false, reason: 'too heavy', bill_net: 30, bill_gross: 36.9 },
  ] };
  const ship = (over: Record<string, (b: any) => unknown>) => app('/dashboard/orders', {
    'GET /rest/v1/orders': () => [ORDER({})],
    'POST /storage/v1/object/labels/*': () => ({ Key: 'x' }),
    'POST /functions/v1/customer-shipping': (c) => { const f = over[c.body.action]; return f ? f(c.body) : status(400, { error: 'unexpected ' + c.body.action }); },
  });

  it('buy with 2ACE: parcel from the product sizes, prices per carrier, asks first, then buys at the agreed price', async () => {
    let bought = false;
    const { calls, user, left } = ship({
      capabilities: () => ({ mode: 'payg', own_label: true, buy_label: true }),
      status: () => ({ own_label: null, bought_label: bought ? { state: 'purchased', service: 'InPost Kurier', tracking_numbers: ['TRK1'], bill_net: 14.5 } : null }),
      suggest: () => ({ parcel: { weight_kg: 1.2, length_cm: 30, width_cm: 20, height_cm: 10 }, note: 'From the product sizes: only an estimate.' }),
      quote: () => OFFERS,
      buy: () => { bought = true; return { ok: true }; },
      label: () => ({ url: 'https://files/label.pdf' }),
    });
    await until(() => expect(text()).toContain('O-0001'));
    await user.click(screen.getByRole('button', { name: 'Shipping' }));
    await until(() => expect(screen.getByRole('textbox', { name: 'Weight (kg)' })).toHaveValue('1,2'));
    expect(text()).toContain('From the product sizes: only an estimate.');
    expect(text()).toContain('Ship with 2ACE.');
    expect(text()).toContain('I provide my own label.');
    await user.clear(screen.getByRole('textbox', { name: 'Height (cm)' }));
    await user.click(screen.getByRole('button', { name: 'Get prices' }));
    expect(text()).toContain('Enter the weight and the three sizes of the parcel.');
    await user.type(screen.getByRole('textbox', { name: 'Height (cm)' }), '12');
    await user.click(screen.getByRole('button', { name: 'Get prices' }));
    await until(() => expect(text()).toContain('InPost Kurier'));
    expect(callsTo(calls, 'POST /functions/v1/customer-shipping').find((c) => c.body.action === 'quote')!.body).toEqual({ action: 'quote', order_id: 'or1', parcels: [{ weight_kg: '1,2', length_cm: '30', width_cm: '20', height_cm: '12' }] });
    expect(text()).toContain('14,50 zł + VAT');
    expect(text()).toContain('Not available: UPS Standard (too heavy).');
    expect(screen.getAllByRole('button', { name: 'Buy' })).toHaveLength(2);
    const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    await user.click(screen.getAllByRole('button', { name: 'Buy' })[0]);
    expect(ask.mock.calls[0][0]).toBe('Buy the InPost Kurier label for 14,50 zł + VAT (17,84 zł with VAT)? It is added to your next invoice and cannot be undone here.');
    expect(callsTo(calls, 'POST /functions/v1/customer-shipping').some((c) => c.body.action === 'buy')).toBe(false);
    await user.click(screen.getAllByRole('button', { name: 'Buy' })[0]);
    await until(() => expect(text()).toContain('Label bought. We will pack your order'));
    expect(callsTo(calls, 'POST /functions/v1/customer-shipping').find((c) => c.body.action === 'buy')!.body).toEqual({ action: 'buy', order_id: 'or1', service_id: 11, parcels: [{ weight_kg: '1,2', length_cm: '30', width_cm: '20', height_cm: '12' }], expected_bill_net: 14.5 });
    expect(text()).toContain('Label bought: InPost Kurier · tracking TRK1 · 14,50 zł + VAT');
    expect(screen.queryByRole('button', { name: 'Get prices' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Hide shipping' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide shipping' }));
    expect(screen.getByRole('button', { name: 'Shipping (label bought)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Shipping (label bought)' }));
    await until(() => expect(screen.getByRole('button', { name: 'Download the label' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Download the label' }));
    await until(() => expect(left.open).toHaveBeenCalledWith('https://files/label.pdf'));
  });

  it('changing the parcel clears the prices; a changed price is shown and nothing is bought', async () => {
    const { user } = ship({
      capabilities: () => ({ mode: 'payg', own_label: true, buy_label: true }), status: () => ({}), suggest: () => ({ parcel: {} }),
      quote: () => OFFERS, buy: () => status(409, { error: 'The price changed to 16,00 zł. Nothing was bought.' }),
    });
    await until(() => expect(text()).toContain('O-0001'));
    await user.click(screen.getByRole('button', { name: 'Shipping' }));
    for (const [k, v] of [['Weight (kg)', '2'], ['Length (cm)', '30'], ['Width (cm)', '20'], ['Height (cm)', '10']]) await user.type(await screen.findByRole('textbox', { name: k }), v);
    await user.click(screen.getByRole('button', { name: 'Get prices' }));
    await until(() => expect(text()).toContain('DHL Parcel'));
    await user.type(screen.getByRole('textbox', { name: 'Weight (kg)' }), '5');
    expect(text()).not.toContain('DHL Parcel');
    await user.click(screen.getByRole('button', { name: 'Get prices' }));
    await until(() => expect(text()).toContain('DHL Parcel'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getAllByRole('button', { name: 'Buy' })[1]);
    await until(() => expect(text()).toContain('The price changed to 16,00 zł. Nothing was bought.'));
  });

  it('an own label: PDF only, 2 MB at most, uploaded to the company\'s folder, then attached', async () => {
    let own: unknown = null;
    const { calls, user } = ship({
      capabilities: () => ({ mode: 'payg', own_label: true, buy_label: false }), status: () => ({ own_label: own }),
      'own_label.attach': (b) => { own = { filename: b.filename, carrier: b.carrier, tracking_numbers: [b.tracking] }; return { ok: true }; },
      'own_label.remove': () => { own = null; return { ok: true }; },
    });
    await until(() => expect(text()).toContain('O-0001'));
    await user.click(screen.getByRole('button', { name: 'Shipping' }));
    await until(() => expect(text()).toContain('Buying a label with 2ACE is coming soon'));
    expect(screen.queryByText('Ship with 2ACE.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save the label' }));
    expect(text()).toContain('Add the label file, or at least a tracking number.');
    await userEvent.setup({ applyAccept: false }).upload(screen.getByLabelText('Label PDF'), new File(['x'], 'label.png', { type: 'image/png' }));   // past the picker's own filter
    await user.click(screen.getByRole('button', { name: 'Save the label' }));
    expect(text()).toContain('The label must be a PDF file.');
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' }); Object.defineProperty(big, 'size', { value: 3 * 1024 * 1024 });
    await user.upload(screen.getByLabelText('Label PDF'), big);
    await user.click(screen.getByRole('button', { name: 'Save the label' }));
    expect(text()).toContain('The label file must be at most 2 MB.');
    await user.upload(screen.getByLabelText('Label PDF'), new File(['%PDF'], 'allegro.pdf', { type: 'application/pdf' }));
    await user.type(screen.getByRole('textbox', { name: 'Carrier' }), 'InPost');
    await user.type(screen.getByRole('textbox', { name: 'Tracking numbers' }), '6200');
    await user.click(screen.getByRole('button', { name: 'Save the label' }));
    await until(() => expect(text()).toContain('Saved. We will print this label'));
    expect(calls.filter((c) => c.path.startsWith('/storage/v1/object/labels/o1/or1/'))).toHaveLength(1);
    const attach = callsTo(calls, 'POST /functions/v1/customer-shipping').find((c) => c.body.action === 'own_label.attach')!.body;
    expect(attach).toMatchObject({ order_id: 'or1', filename: 'allegro.pdf', tracking: '6200', carrier: 'InPost' });
    expect(attach.path).toMatch(/^o1\/or1\/.+\.pdf$/);
    expect(text()).toContain('Current label: allegro.pdf · InPost · 6200');
    expect(screen.getByRole('button', { name: 'Replace the label' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await until(() => expect(text()).toContain('Label removed.'));
  });

  it('a plan without fulfilment gets no forms; if the function is missing the message is plain', async () => {
    let missing = false;
    const { user } = app('/dashboard/orders', {
      'GET /rest/v1/orders': () => [ORDER({})],
      'POST /functions/v1/customer-shipping': (c) => (missing ? status(404) : c.body.action === 'capabilities' ? { mode: 'flat', own_label: false, buy_label: false } : {}),
    });
    await until(() => expect(text()).toContain('O-0001'));
    await user.click(screen.getByRole('button', { name: 'Shipping' }));
    await until(() => expect(text()).toContain('Your plan does not include fulfilment'));
    expect(screen.queryByLabelText('Label PDF')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Hide shipping' }));
    missing = true;
    await user.click(screen.getByRole('button', { name: 'Shipping' }));
    await until(() => expect(text()).toContain('Shipping tools are not available yet. Please try again later.'));
  });
});

describe('returns', () => {
  const RET = (o: object) => ({ id: 'r1', ref: 'R-0001', status: 'announced', fee_mode: 'payg', reason: null, order_id: 'or4', created_at: '2026-10-02T10:00:00Z', buyer_name: 'Jan Kowalski', buyer_city: 'Warszawa', return_lines: [{ qty: 1, received_qty: null, grade: null, note: null, products: { sku: 'MUG-BLUE', name: 'Blue mug' } }], ...o });

  it('announces a return from a shipped order with the buyer and only the lines coming back', async () => {
    const { calls, user } = app('/dashboard/returns', {
      'GET /rest/v1/orders': () => [ORDER({}), ORDER({ id: 'or4', ref: 'O-0004', status: 'shipped', order_lines: [{ ...line('p1', 'MUG-BLUE', 'Blue mug'), qty: 2 }, { ...line('p2', 'MUG-RED', 'Red mug'), qty: 1 }] })],
      'POST /rest/v1/rpc/create_return': () => ({ id: 'r9', ref: 'R-0009' }),
    });
    await until(() => expect(text()).toContain('No returns yet'));
    expect(text()).toContain('9,00 zł to 22,50 zł per return');
    await user.click(screen.getByRole('button', { name: 'New return' }));
    const pick = screen.getByRole('combobox', { name: 'The order the goods came from' });
    expect(within(pick).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a shipped order', 'O-0004 · Jan Kowalski, Warszawa']);
    await user.click(screen.getByRole('button', { name: 'Announce the return' }));
    expect(text()).toContain('Choose the order the goods are coming back from.');
    await user.selectOptions(pick, 'or4');
    expect(screen.getByRole('textbox', { name: 'Street and number' })).toHaveValue('Prosta 1 m. 4');
    await user.click(screen.getByRole('button', { name: 'Announce the return' }));
    expect(text()).toContain('Enter how many of each product are coming back.');
    await user.type(screen.getAllByRole('spinbutton', { name: 'Units coming back' })[0], '1');
    await user.type(screen.getByRole('textbox', { name: 'Why is it coming back? Optional' }), 'Too small');
    await user.click(screen.getByRole('button', { name: 'Announce the return' }));
    await until(() => expect(text()).toContain('Return R-0009 announced.'));
    expect(callsTo(calls, 'POST /rest/v1/rpc/create_return')[0].body).toEqual({ p_org: 'o1', p_order: 'or4', p_buyer: { name: 'Jan Kowalski', phone: '600100200', email: 'jan@x.pl', line1: 'Prosta 1 m. 4', postal: '00-001', city: 'Warszawa', country: 'PL' }, p_reason: 'Too small', p_lines: [{ product_id: 'p1', qty: 1 }] });
  });

  it('issues the return label: asks with the price, then buys; download opens the file', async () => {
    let label: unknown = null;
    const { calls, user, left } = app('/dashboard/returns', {
      'GET /rest/v1/returns': () => [RET({})],
      'POST /functions/v1/customer-shipping': (c) => ({
        capabilities: () => ({ mode: 'payg', buy_return_label: true }), 'return.status': () => ({ label }),
        'return.quote': () => ({ offers: [{ service_id: 21, carrier: 'inpost', name: 'InPost Zwrot', available: true, bill_net: 12, bill_gross: 14.76 }] }),
        'return.buy': () => { label = { state: 'purchased', carrier: 'inpost', tracking_numbers: ['Z1'], bill_net: 12 }; return { ok: true }; },
        'return.label': () => ({ url: 'https://files/ret.pdf' }),
      } as Record<string, () => unknown>)[c.body.action](),
    });
    await until(() => expect(text()).toContain('R-0001'));
    expect(text()).toContain('Announced. Issue the label, or wait for the parcel.');
    await user.click(screen.getByRole('button', { name: 'Issue the return label' }));
    for (const [k, v] of [['Weight (kg)', '1'], ['Length (cm)', '20'], ['Width (cm)', '20'], ['Height (cm)', '10']]) await user.type(await screen.findByRole('textbox', { name: k }), v);
    await user.click(screen.getByRole('button', { name: 'Get prices' }));
    await until(() => expect(text()).toContain('InPost Zwrot'));
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Buy' }));
    expect(ask.mock.calls[0][0]).toBe('Buy the InPost Zwrot return label for 12,00 zł + VAT (14,76 zł with VAT)? It is added to your next invoice and cannot be undone here.');
    await until(() => expect(text()).toContain('Return label bought. Download it and send it to your buyer.'));
    expect(callsTo(calls, 'POST /functions/v1/customer-shipping').find((c) => c.body.action === 'return.buy')!.body).toEqual({ action: 'return.buy', return_id: 'r1', service_id: 21, parcels: [{ weight_kg: '1', length_cm: '20', width_cm: '20', height_cm: '10' }], expected_bill_net: 12 });
    await user.click(screen.getByRole('button', { name: 'Download the label' }));
    await until(() => expect(left.open).toHaveBeenCalledWith('https://files/ret.pdf'));
  });

  it('a graded return says what came back and mentions the fee; charges are listed before VAT with their status', async () => {
    app('/dashboard/returns', {
      'GET /rest/v1/returns': () => [RET({ status: 'graded', return_lines: [{ qty: 2, received_qty: 1, grade: 'A', note: null, products: { sku: 'MUG-BLUE', name: 'Blue mug' } }, { qty: 1, received_qty: 1, grade: 'C', note: 'cracked', products: { sku: 'MUG-RED', name: 'Red mug' } }] })],
      'POST /rest/v1/rpc/my_charges': () => [{ at: '2026-10-03T10:00:00Z', kind: 'return_handling', size_class: 'S', note: null, return_ref: 'R-0001', net: 9, status: 'pending' }, { at: '2026-10-01T10:00:00Z', kind: 'label', size_class: null, note: null, order_ref: 'O-0001', net: 14.5, status: 'paid' }],
    });
    await until(() => expect(text()).toContain('R-0001'));
    expect(text()).toContain('MUG-BLUE: 1 back on your shelf. MUG-RED: 1 set aside (damaged, not sellable): cracked. A handling fee for this return is on your next invoice.');
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(text()).toContain('Return handling fee (class S) · R-0001');
    expect(text()).toContain('9,00 zł + VAT · On your next invoice');
    expect(text()).toContain('Shipping label · O-0001');
    expect(text()).toMatch(/14,50 zł \+ VAT · Paid/);
    expect(text().toLowerCase()).not.toMatch(/markup|margin|cost price/);
  });
});

describe('domain', () => {
  it('checks a name, needs the agreement ticked, then pays through Stripe', async () => {
    const { calls, user, left } = app('/dashboard/domain', {
      'POST /functions/v1/domain-checkout': (c) => (c.body.action === 'info' ? { eligible: true, free: false, fee: 99 } : { url: 'https://checkout.stripe.com/d' }),
      'POST /functions/v1/domain-check': () => ({ status: 'free' }),
    });
    await until(() => expect(text()).toContain('Get a .pl domain for 99 zł one-time'));
    await user.click(screen.getByRole('button', { name: 'Pay 99 zł and request' }));
    expect(text()).toContain('Enter a name first.');
    await user.type(screen.getByRole('textbox', { name: 'Domain' }), 'Acme Shop!');
    expect(screen.getByRole('textbox', { name: 'Domain' })).toHaveValue('acmeshop');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await until(() => expect(text()).toContain('acmeshop.pl looks available.'));
    await user.click(screen.getByRole('button', { name: 'Pay 99 zł and request' }));
    expect(text()).toContain('Please tick the box to accept Hostinger\'s agreement.');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Pay 99 zł and request' }));
    await until(() => expect(left.to).toHaveBeenCalledWith('https://checkout.stripe.com/d'));
    expect(callsTo(calls, 'POST /functions/v1/domain-checkout').at(-1)!.body).toEqual({ name: 'acmeshop', accept: true });
  });

  it('an existing domain is shown with its status', async () => {
    app('/dashboard/domain', { 'POST /functions/v1/domain-checkout': () => ({ eligible: false, reason: 'has_domain', domains: [{ domain: 'acme.pl', status: 'pending' }] }) });
    await until(() => expect(text()).toContain('acme.pl'));
    expect(text()).toContain('We are registering it.');
  });
});

describe('contact and navigation', () => {
  it('sends a request with the topic and the customer\'s own words, not the bare template', async () => {
    const { calls, user } = app('/dashboard', { 'POST /functions/v1/request-help': () => ({ ok: true }) });
    await user.click(screen.getByRole('button', { name: 'Contact us' }));
    const dialog = screen.getByRole('dialog', { name: 'Contact us' });
    await user.selectOptions(within(dialog).getByRole('combobox'), 'inbound');
    expect((within(dialog).getByRole('textbox') as HTMLTextAreaElement).value).toContain('I would like to book an inbound delivery.');
    await user.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(text()).toContain('Please fill in a few details');
    await user.type(within(dialog).getByRole('textbox'), ' 3 pallets of mugs');
    await user.click(within(dialog).getByRole('button', { name: 'Send request' }));
    await until(() => expect(text()).toContain('Request sent.'));
    const b = callsTo(calls, 'POST /functions/v1/request-help')[0].body;
    expect(b.subject).toBe('inbound'); expect(b.message).toContain('3 pallets of mugs');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the team tab explains and offers to ask for access; every tab has a link', async () => {
    const { user } = app('/dashboard/team');
    await until(() => expect(text()).toContain('You are the account owner (owner@acme.pl).'));
    await user.click(screen.getByRole('button', { name: 'Ask for team access' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Dashboard' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent?.replace('New', ''))).toEqual(['Overview', 'Imports', 'Shipment tracking', 'Inbound', 'Products', 'Inventory', 'Orders', 'Returns', 'Storefront', 'Domain', 'Team', 'Help and user guide']);
  });

  it('signed out, the dashboard sends to login and comes back to the same tab', async () => {
    mockFetch({ ...baseRoutes() });
    const { left } = renderApp('/dashboard/orders');
    expect(left.to).toHaveBeenCalledWith('/login?next=%2Fapp%2Fdashboard%2Forders');
  });

  it('someone signed in without a company sees the empty screens, not an endless Loading', async () => {
    signIn();
    mockFetch(baseRoutes({ org: null, plan: null }));
    renderApp('/dashboard/products');
    await until(() => expect(text()).toContain('Your product catalogue'));
    expect(text()).not.toContain('Loading…');
  });

  it('a company that is not active yet cannot book or order, and is told why', async () => {
    signIn();
    mockFetch({ ...baseRoutes({ org: { ...ORG, organizations: { ...ORG.organizations, status: 'pending' } }, plan: null }) });
    renderApp('/dashboard/orders');
    await until(() => expect(text()).toContain('You can place orders once your plan is active.'));
  });
});
