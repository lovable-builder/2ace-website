// A carrier's badge: short name and its brand colours (background, text).
const BRANDS: Record<string, [string, string, string]> = {
  dhl: ['DHL', '#FFCC00', '#D40511'], dpd: ['DPD', '#DC0032', '#FFFFFF'], ups: ['UPS', '#351C15', '#FFB500'], fedex: ['FedEx', '#4D148C', '#FFFFFF'],
  inpost: ['InPost', '#FFCD00', '#1A1A1A'], gls: ['GLS', '#061AB1', '#FFFFFF'], poczta: ['Poczta', '#D6001C', '#FFFFFF'], orlen: ['Orlen', '#E30613', '#FFFFFF'],
};

export function carrierBrand(carrier: string | null | undefined): { label: string; bg: string; fg: string } {
  const c = String(carrier || '').toLowerCase();
  const k = Object.keys(BRANDS).find((x) => c.includes(x));
  const [label, bg, fg] = k ? BRANDS[k] : [String(carrier || '?').slice(0, 3).toUpperCase(), '#E5E3DE', '#0B0C0E'];
  return { label, bg, fg };
}
