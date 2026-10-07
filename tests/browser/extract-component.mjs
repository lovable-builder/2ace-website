// The home page keeps its logic inside an inline <script>. The browser-level tests need that class on its own.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib/root.mjs';
const out = path.join(ROOT, 'tests', '.cache'); fs.mkdirSync(out, { recursive: true });
for (const [page, file] of [['index.html', 'index_comp.js']]) {
  const s = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const a = s.indexOf('class Component extends DCLogic'), b = s.indexOf('</script>', a);
  if (a < 0 || b < 0) throw new Error('Could not find the component class in ' + page);
  fs.writeFileSync(path.join(out, file), s.slice(a, b));
}
console.log('component code extracted to tests/.cache');
