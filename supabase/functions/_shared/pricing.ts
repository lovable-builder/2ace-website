// Server-side port of pricing() in platform.html. Amounts are whole PLN, net of VAT.
// Keep in sync with the browser version; the browser total is display only.

export const STORAGE = {
  shelf: { name: 'Shelf bins', unit: 'bins', price: 90, min: 10, max: 2000, m2: 0.3 },
  pallet: { name: 'Pallets', unit: 'pallets', price: 360, min: 1, max: 1000, m2: 1.2 },
  zone: { name: 'Private zone', unit: '× 50 m²', price: 15000, min: 1, max: 40, m2: 50 },
} as const;

export type PlanConfig = {
  storageType: keyof typeof STORAGE;
  qty: number;
  pkgs: { ful?: boolean; ret?: boolean; imp?: boolean };
  storeOn?: boolean;
  domain?: string;
  tt?: 'off' | 'setup' | 'managed';
  meta?: 'off' | 'setup' | 'managed';
  marketOn?: boolean;
};

export type Line = { label: string; monthly: number; once: number };

export function priceConfig(c: PlanConfig) {
  const st = STORAGE[c.storageType];
  if (!st) throw new Error('invalid storageType');
  const qty = Math.round(Number(c.qty));
  if (!Number.isFinite(qty) || qty < st.min || qty > st.max) throw new Error('invalid qty');

  const lines: Line[] = [{ label: `${st.name} (${qty} ${st.unit})`, monthly: qty * st.price, once: 0 }];
  const fp = qty * st.m2;
  if (c.pkgs?.ful) lines.push({ label: 'Fulfillment', monthly: Math.round(fp * 350), once: 0 });
  if (c.pkgs?.ret) lines.push({ label: 'Returns handling', monthly: Math.round(fp * 150), once: 0 });
  // Import & customs is quoted per shipment: not billed here.
  if (c.storeOn) lines.push({ label: 'Storefront hosting and care', monthly: 199, once: 2950 });
  const channels: [keyof PlanConfig, string, number, number][] = [
    ['tt', 'TikTok Shop', 1690, 1890],
    ['meta', 'Meta Business', 1190, 1690],
  ];
  for (const [k, name, setup, managed] of channels) {
    const v = c[k];
    if (v === 'setup') lines.push({ label: `${name} setup`, monthly: 0, once: setup });
    if (v === 'managed') lines.push({ label: `${name} managed`, monthly: managed, once: setup });
  }
  // 2ACE Market is a 15% commission on sales: nothing billed up front.
  const monthly = lines.reduce((a, l) => a + l.monthly, 0);
  const once = lines.reduce((a, l) => a + l.once, 0);
  return { lines, monthly, once };
}
