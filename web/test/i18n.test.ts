import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript helper shared with the command line
import { keys } from '../scripts/i18n-keys.mjs';
import { pl } from '../src/i18n/pl';
import { zh } from '../src/i18n/zh';

const ALL: string[] = keys();
const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

describe.each([['Polish', pl], ['Chinese', zh]] as const)('%s translation', (_name, cat) => {
  it('has every string the app shows', () => {
    expect(ALL.length).toBeGreaterThan(500);
    expect(ALL.filter((k) => !(k in cat))).toEqual([]);
  });
  it('has nothing the app no longer shows', () => {
    const known = new Set(ALL);
    expect(Object.keys(cat).filter((k) => !known.has(k))).toEqual([]);
  });
  it('keeps every {placeholder}, and leaves nothing empty', () => {
    expect(Object.entries(cat).filter(([k, v]) => holes(k) !== holes(v)).map(([k]) => k)).toEqual([]);
    expect(Object.entries(cat).filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
  });
});

describe('switching language', async () => {
  const { screen } = await import('@testing-library/react');
  const { baseRoutes, mockFetch, renderApp } = await import('./harness');
  it('changes the screen at once and is remembered', async () => {
    mockFetch(baseRoutes());
    const { user, unmount } = renderApp('/plan');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('How many square metres do you need?');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'pl');
    expect(await screen.findByRole('heading', { level: 2, name: 'Ilu metrów kwadratowych potrzebujesz?' })).toBeInTheDocument();
    expect(localStorage.getItem('ace_lang')).toBe('pl');
    unmount();
    renderApp('/plan');
    expect(await screen.findByRole('heading', { level: 2, name: 'Ilu metrów kwadratowych potrzebujesz?' })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Język' }), 'zh');
    expect(await screen.findByRole('heading', { level: 2, name: '您需要多少平方米？' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('zh-Hans');
  });
});
