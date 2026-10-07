// Money and numbers are written the Polish way in every language (4 500 zł, 12,50 zł): prices are in złoty.
const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export const num = (n: number) => group(String(Math.round(n)));
export const fmt = (n: number) => num(n) + ' zł';
// Two decimals with a comma: 12,50 zł.
export const money = (n: number | string) => Number(n).toFixed(2).replace('.', ',') + ' zł';
// Square metres to one decimal, without a trailing ",0": 12 or 14.4.
export const m2fmt = (n: number | string) => group(String(Math.round(Number(n) * 10) / 10).replace(/\.0$/, ''));

export type Lang = 'en' | 'pl' | 'zh';
export const LOCALE: Record<Lang, string> = { en: 'en-GB', pl: 'pl-PL', zh: 'zh-CN' };

export const dateLong = (d: Date, lang: Lang) => d.toLocaleDateString(LOCALE[lang], { weekday: 'long', day: 'numeric', month: 'long' });
export const dateShort = (d: string | Date, lang: Lang) => new Date(d).toLocaleDateString(LOCALE[lang], { day: 'numeric', month: 'short', year: 'numeric' });
export const dayMonth = (d: string | Date, lang: Lang) => new Date(d).toLocaleDateString(LOCALE[lang], { day: 'numeric', month: 'short' });
