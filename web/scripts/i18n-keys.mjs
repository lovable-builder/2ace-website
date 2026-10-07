// Lists every English string the app translates: literals passed to t()/translate(), and the text tables marked
// `// i18n` (status names, menu entries, messages chosen by key). `node scripts/i18n-keys.mjs` prints them, one per line,
// and the i18n test checks each one has a Polish and a Chinese translation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const unquote = (q, s) => s.replace(new RegExp('\\\\' + q, 'g'), q).replace(/\\n/g, '\n');

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) && !e.name.startsWith('i18n') ? [path.join(dir, e.name)] : []));
}

export function keys() {
  const out = new Set();
  for (const f of files(SRC)) {
    if (f.includes(path.sep + 'i18n' + path.sep)) continue;
    const src = fs.readFileSync(f, 'utf8');
    // t('...'), t("..."), translate(lang, '...'), new CsvError('...'), and string arms of a ternary inside t(...)
    for (const m of src.matchAll(/\b(?:t|translate\(\s*\w+\s*,|new CsvError\()\s*\(?\s*(['"])((?:\\.|(?!\1).)*)\1/g)) out.add(unquote(m[1], m[2]));
    for (const m of src.matchAll(/\bt\(([^()]*\?[^()]*)\)/g)) for (const s of m[1].matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)) if (/[A-Z ]/.test(s[2])) out.add(unquote(s[1], s[2]));
    // tables marked with an `// i18n` comment on the line before: every quoted value with a capital letter or a space
    for (const m of src.matchAll(/\/\/ i18n[^\n]*\n([\s\S]*?)(?:\n\];|\n\};|\n\] as const;|\n\}\)\);|;\n)/g)) {
      for (const s of m[1].matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)) {
        const v = unquote(s[1], s[2]);
        if (/[A-Z]/.test(v[0] ?? '') || / /.test(v)) if (!/^(https?:|\/|#|rgba?\(|[A-Z0-9]{2,}[-_0-9]*$)/.test(v)) out.add(v);
      }
    }
  }
  return [...out].filter((k) => k.trim() !== '').sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) console.log(keys().join('\n---\n'));
