import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Lang } from '../lib/format';

// English text is the key: t('Book a delivery'). A missing translation falls back to English, never to a blank.
// {name} placeholders are filled from vars. Messages that come from the server stay in English.
export type Vars = Record<string, string | number>;
export type T = (key: string, vars?: Vars) => string;

// Polish and Chinese are loaded only when chosen, so English visitors never download them.
const CATALOGS: Record<Lang, Record<string, string> | undefined> = { en: {}, pl: undefined, zh: undefined };
const LOADERS: Record<Exclude<Lang, 'en'>, () => Promise<Record<string, string>>> = {
  pl: () => import('./pl').then((m) => m.pl),
  zh: () => import('./zh').then((m) => m.zh),
};
export async function loadCatalog(lang: Lang) {
  if (lang !== 'en' && !CATALOGS[lang]) CATALOGS[lang] = await LOADERS[lang]();
}
export const LANGS: { k: Lang; label: string }[] = [{ k: 'en', label: 'English' }, { k: 'pl', label: 'Polski' }, { k: 'zh', label: '中文' }];
const STORE = 'ace_lang';

export const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : s);
export const translate = (lang: Lang, key: string, vars?: Vars) => fill(CATALOGS[lang]?.[key] ?? key, vars);

export function initialLang(): Lang {
  try { const s = localStorage.getItem(STORE); if (s === 'en' || s === 'pl' || s === 'zh') return s; } catch { /* ignore */ }
  const n = (typeof navigator !== 'undefined' ? navigator.language : 'en').toLowerCase();
  return n.startsWith('pl') ? 'pl' : n.startsWith('zh') ? 'zh' : 'en';
}

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: T };
const LangContext = createContext<Ctx>({ lang: 'en', setLang: () => {}, t: (k, v) => fill(k, v) });

export function LangProvider({ children, initial }: { children: ReactNode; initial?: Lang }) {
  const [wanted] = useState<Lang>(() => initial ?? initialLang());
  // The language on screen: English until the chosen catalogue has arrived (a fraction of a second).
  const [lang, setLangState] = useState<Lang>(() => (CATALOGS[wanted] ? wanted : 'en'));
  const show = useCallback((l: Lang) => {
    loadCatalog(l).then(() => { setLangState(l); document.documentElement.lang = l === 'zh' ? 'zh-Hans' : l; }).catch(() => { /* stay in the current language */ });
  }, []);
  useEffect(() => { if (wanted !== 'en') show(wanted); }, [wanted, show]);
  const setLang = useCallback((l: Lang) => {
    try { localStorage.setItem(STORE, l); } catch { /* ignore */ }
    show(l);
  }, [show]);
  const value = useMemo<Ctx>(() => ({ lang, setLang, t: (k, v) => translate(lang, k, v) }), [lang, setLang]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export const useLang = () => useContext(LangContext);
export const useT = () => useContext(LangContext).t;
