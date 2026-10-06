import fs from 'node:fs';
import { ROOT } from '../lib/root.mjs';
// Guards against a bug that unit tests with a fake database cannot see: `allocations` links to `locations` twice (the bin the goods
// come from, and the packing station they move to), so any embedded `locations(...)` on allocations is ambiguous and the real
// database refuses it. Every such query must name the bin: locations!location_id(...).
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !x ? '' : ' -> ' + x)); };
const files = [...fs.readdirSync(ROOT + '/assets/admin').filter((f) => f.endsWith('.js')).map((f) => 'assets/admin/' + f), 'platform.html', 'scan.html'];
const bad = [], good = [];
for (const f of files) {
  const src = fs.readFileSync(ROOT + '/' + f, 'utf8');
  for (const m of src.matchAll(/from\('allocations'\)\.select\(('[^']*'|`[^`]*`)/g)) (/locations!/.test(m[1]) || !/locations\(/.test(m[1]) ? good : bad).push(f + ': ' + m[1].slice(0, 90));
  for (const m of src.matchAll(/allocations\?select=([^'`\s]*)/g)) (/locations!/.test(m[1]) || !/locations\(/.test(m[1]) ? good : bad).push(f + ': ' + m[1].slice(0, 90));
}
ok('there are allocation queries to check', good.length + bad.length >= 2, String(good.length + bad.length));
ok('every query that embeds locations on allocations names the bin (locations!location_id)', bad.length === 0, bad.join(' | '));
// and the database really does have two links, which is why the hint is needed
const mig = fs.readFileSync(ROOT + '/supabase/migrations/20261009000000_pick_pack.sql', 'utf8') + fs.readFileSync(ROOT + '/supabase/migrations/20261007000000_orders.sql', 'utf8');
ok('allocations still has two foreign keys to locations (location_id and pack_location_id)', /location_id uuid not null references public\.locations/.test(mig) && /pack_location_id uuid references public\.locations/.test(mig));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
