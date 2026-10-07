# Customer app (`web/`)

The plan builder, checkout and customer dashboard as a React + TypeScript app built with Vite. It replaces `platform.html`
(a design-tool export that compiled JSX in the visitor's browser) and talks to the same Supabase tables, database functions
and Edge Functions, with no backend changes.

The build is written to `../app/` and **committed**, because the server only runs `git pull`. CI rebuilds it and fails if
`app/` is not exactly what this folder produces, so always commit both together.

```
cd web
npm ci
npm run dev        # http://localhost:5173/app/  (run `node dev-server.js` in the repo root too, for config.js and /login)
npm run check      # type-check, tests, build into ../app
```

## Layout

| Path | What |
|---|---|
| `src/App.tsx` | Routes: `/app/plan/:step`, `/app/checkout/:step`, `/app/dashboard/:tab`, and the old `/platform?…` links |
| `src/pages/Builder.tsx`, `Checkout.tsx` | Build a plan, change an active plan (`?change=1`), sign and pay on Stripe |
| `src/pages/Dashboard.tsx`, `pages/dash/*` | Overview, inventory, products, inbound, orders (CSV import, shipping labels), returns, domain, contact |
| `src/state/` | The signed-in account and company, the plan being built, the warehouse data |
| `src/lib/` | Supabase calls (`api.ts`), the session `/login` stores (`session.ts`, refreshed before it expires), pricing, CSV, formats |
| `src/i18n/` | English, Polish, Chinese. English text is the key; `test/i18n.test.ts` fails if any string lacks a translation |

The backend address comes from the site's `/config.js` at runtime, so one build serves production and staging.
Errors go to the reporter in `/assets/monitor.js` (Sentry, when a DSN is set in `config.js`).

## Translations

Polish and Chinese were written from the app's strings and **need a native speaker's review** before launch. To add a string:
use `t('English text')` in the code, then add it to `src/i18n/pl.ts` and `src/i18n/zh.ts` (`npm test` lists what is missing).
`node scripts/i18n-keys.mjs` prints every key.

## Going live

The new app is served at `/app/` next to the old `/platform` page. When it has been checked against the live backend,
uncomment the switch-over line in `.htaccess`. `/platform` then redirects to `/app/` with its query string, so Stripe's
return links and the links in emails keep working. Leave `platform.html` in place until then, for rollback.

2ACE Market (switched off) is not in the new app; its code stays in `platform.html`.
