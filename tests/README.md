# Tests

Local suites for the site and the warehouse system. This folder is **not deployed**: `.htaccess` blocks `/tests` on the server.

```
cd tests && npm install      # once
bash run.sh                  # everything
bash run.sh phaseD           # only suites whose path contains "phaseD"
```

| Folder | What | How |
|---|---|---|
| `sql/` | The whole database (every migration, in order) in an in-memory Postgres (PGlite): permissions, stock ledger, orders, picking, shipments. | `@electric-sql/pglite` |
| `ui/` | The admin screens, the scan page, the guides, SEO, scrolling, and the real customer dashboard in a simulated browser. | `jsdom`, local dev server |
| `browser/` | The plan builder and home page logic run without a browser (pricing, plan change, journey). | plain Node |

The server-side TypeScript has its own tests next to the code (`supabase/functions/_shared/*.test.ts`), run with `deno test supabase/functions/_shared/` (Deno 2).

Run the suites before every deploy. A suite fails if its last line says `N failed`, if it printed no summary, or if the page suite reports errors.
