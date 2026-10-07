import { useEffect, useState } from 'react';
import { publicRpc } from './api';
import { money } from './format';
import type { T } from '../i18n';

// The public handling tariff (a fee per order and per return, by parcel size). Shown before sign-up, so anyone can read it.
export type Tariff = { tiers: { handling_net: number; return_net: number }[] };

let cache: Promise<Tariff | null> | null = null;
export const resetTariffCache = () => { cache = null; };

export function useTariff(): Tariff | null {
  const [t, setT] = useState<Tariff | null>(null);
  useEffect(() => {
    let live = true;
    cache ??= publicRpc<Tariff>('handling_tariff').then((x) => (x && Array.isArray(x.tiers) && x.tiers.length ? x : null)).catch(() => null);
    cache.then((x) => { if (live) setT(x); });
    return () => { live = false; };
  }, []);
  return t;
}

// "12,00 zł to 30,00 zł per order, by the size of the parcel". Without the tariff: the same words, no numbers.
export function tariffText(tariff: Tariff | null, kind: 'order' | 'return', t: T) {
  if (!tariff) return kind === 'return' ? t('a fee per return, by the size of the parcel') : t('a fee per order, by the size of the parcel');
  const first = tariff.tiers[0], last = tariff.tiers[tariff.tiers.length - 1];
  return kind === 'return'
    ? t('{from} to {to} per return, by the size of the parcel', { from: money(first.return_net), to: money(last.return_net) })
    : t('{from} to {to} per order, by the size of the parcel', { from: money(first.handling_net), to: money(last.handling_net) });
}
