# Running 2ACE: deploys, staging, monitoring

## What happens on a push

`.github/workflows/ci.yml` runs on every pull request and every push:

| Job | Checks |
|---|---|
| Website and database tests | `tests/run.sh`: every migration in an in-memory Postgres, admin and scan screens, `/platform`, guides, SEO |
| Edge Functions | `deno check` on every function, `deno test --allow-env` on `_shared/` |
| Customer app | `web/`: types, tests, build, and that the committed `app/` matches the build |

On `main`, and only when all three pass:
1. **Deploy database and functions** (off until you switch it on, see below).
2. **Deploy website**: the same SSH `git pull` as before.

A red test now stops the deploy. Before this change, every push to `main` went live untested.

## Switching on database and function deploys

Until this is on, apply migrations and deploy functions by hand as before.

1. Check the migration history the CLI will compare against:
   `supabase link --project-ref hvbcmilcjragrcezwzlo && supabase migration list`.
   If migrations were applied by hand (in the SQL editor), the **Remote** column is empty for them. Mark them as applied first,
   or CI will try to run them again: `supabase migration repair --status applied <version> …` for each one that is already in.
2. In GitHub > Settings > Environments > **production**, add:
   - variable `AUTO_DEPLOY_SUPABASE` = `true`, variable `SUPABASE_PROJECT_REF` = `hvbcmilcjragrcezwzlo`
   - secrets `SUPABASE_ACCESS_TOKEN` (supabase.com > Account > Access tokens) and `SUPABASE_DB_PASSWORD`
3. Optional: add yourself as a required reviewer on the environment, so every production deploy waits for a click.

Each run shows a `--dry-run` of the migrations before applying them.

## Staging

Pushing to a `staging` branch runs the same pipeline against the **staging** environment. To set it up:

1. Create a second Supabase project (staging). Push the schema: `supabase link --project-ref <staging-ref> && supabase db push`.
   Set its function secrets (Stripe **test** keys, Furgonetka sandbox, Resend) in its dashboard.
2. Put its URL and anon key in the `staging` block of `/config.js`. Pages on `staging.<domain>` use them; until they are
   filled in, staging pages refuse to load instead of talking to the live database.
3. In Hostinger, create the `staging.2ace.pl` subdomain with its own `git clone` of this repository on the `staging` branch,
   and a deploy key restricted to `git pull --ff-only` there (as for production).
4. In GitHub > Environments > **staging**: `AUTO_DEPLOY_SUPABASE=true`, `SUPABASE_PROJECT_REF`, the two Supabase secrets,
   `DEPLOY_SSH_KEY`, and variables `DEPLOY_HOST`, `DEPLOY_PORT`, `DEPLOY_USER`, `DEPLOY_HOST_KEY` (the server's public host key).

## Error monitoring (Sentry)

Everything is wired and **off** until a DSN is set:

- Browser (every page, including the new app): set `sentryDsn` in `/config.js` (the DSN is public by design).
- Edge Functions: `supabase secrets set SENTRY_DSN=<dsn> SENTRY_ENVIRONMENT=production`.

Reports carry the error, its stack trace, the page path (never the query string) and the browser. They contain no cookies,
no request bodies and no customer details. **Before switching it on**, add Sentry to the "Who receives it" list in the
privacy policy (`privacy.html`), e.g. "Sentry: error reports when something breaks (the error, the page and the browser)".

## Uptime

`.github/workflows/uptime.yml` checks every 15 minutes: the home page, `/platform`, `/app/`, `/login`, `config.js`, the
database API and the Edge Functions runtime. A failed run is emailed by GitHub. Run it by hand from the Actions tab, or
locally: `node scripts/uptime.mjs https://2ace.pl`. GitHub pauses scheduled workflows after 60 days with no commits.

## The new customer app

Built from `web/` into `app/`, served at `/app/`. See `web/README.md`, including how to switch `/platform` over to it.
