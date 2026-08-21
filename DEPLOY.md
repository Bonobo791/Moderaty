<!--
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher

Licensed under the PolyForm Shield License 1.0.0; you may not use
this file except in compliance with the License. You may obtain a
copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.

The software is provided "as is", without warranty or condition of
any kind, express or implied. See the License for the specific
language governing permissions and limitations under the License.
A copy of the License is included in the LICENSE file at the
repository root.

Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md
-->

# Deploying Moderaty to Netlify

> **Two supported deploy targets.** This file documents the Netlify target.
> The **Coolify + Bunny CDN** target — self-hosted dev/prod apps with
> push-to-deploy on `main` and `dev`, a Bunny pull zone in front of
> production, and automatic cache purges after every PRODUCTION deploy (the
> dev app has no CDN and never purges) — is documented
> in [`docs/COOLIFY_BUNNY.md`](docs/COOLIFY_BUNNY.md). The codebase serves
> both targets: Netlify builds are unchanged (default adapter), Coolify
> builds via the Dockerfile with `MODERATY_ADAPTER=node`.

The repo is deploy-ready: `netlify.toml` pins the build
(`node scripts/netlify-migrate.mjs && npm run build`, publish `build`,
Node 24) and `netlify/functions/cron.mjs` is a Netlify
Scheduled Function that triggers one bounded moderation run every minute
(during early operation; raise to `*/15 * * * *` when user volume grows).
Scheduled functions only fire on the published production deploy — branch
deploys and Deploy Previews never trigger them — so non-production
environments drain via `node --env-file=.env scripts/dev-cron.mjs`
(see AGENTS.md, Project Structure).
The steps below are the one-time manual setup.

## 1. Database (Turso)

**Migrations run automatically at deploy time.** The Netlify build command
starts with `scripts/netlify-migrate.mjs`, which runs `npm run db:migrate`
then `npm run db:verify` before the app builds — so a deploy is blocked
until the database it will serve is actually migrated AND verified.
Production and `dev`-branch deploys both migrate (each against its own
per-context database); Deploy Previews skip the step loudly, because previews
execute untrusted PR code that must never run SQL against a shared database.
The manual `npm run db:migrate` below remains for initial DB setup (before
the site exists), local work, and outage recovery.

- Create the production Turso database and note its URL and auth token.
- Apply migrations once from a checkout with the production values sourced:
  `npm run db:migrate` (loads `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`).
- **Verify against the actual schema afterwards** — drizzle-kit can exit 0
  without applying anything (the 0007/0008 incidents). Check the target, not
  the exit code: `PRAGMA table_info(<new table>);` for the new column,
  `SELECT COUNT(*) FROM __drizzle_migrations;` for the applied count, and
  `PRAGMA integrity_check;` + `PRAGMA foreign_key_check;` before declaring
  success. If the tool no-ops, apply the SQL manually through the same
  journal bookkeeping (hash = sha256 of the file, `created_at` = journal
  `when`) inside one transaction. `npm run db:verify` automates the
  applied-count check: it recomputes each journal entry's sha256 and compares
  against `__drizzle_migrations`, failing loudly on any missing or extra
  hash — the deploy gate runs it on every build.
- **Historical drift repair (0003 only, likely already done):** migration
  `0003_wide_impossible_man.sql` had its license header added ~30 minutes after
  it was applied, changing its recorded hash. If the first gated deploy
  reports `MISSING 0003_wide_impossible_man` + an `EXTRA applied hash
  4cb16c12…`, the production database still holds the pre-header hash; the
  only difference is the header (verify with
  `git diff 4c11b2f 33428fb -- drizzle/0003_wide_impossible_man.sql`), so
  backfill the journal row instead of re-running the migration:
  `UPDATE __drizzle_migrations SET hash = 'effa15e51ca99fd0acf8556c1f1a9bc3abd097bc84dac09f6b05eff27c4f2130' WHERE hash = '4cb16c12ec9d828ba5d32b31f85a55d70af231d310f3904eb149e039822301c6';`
  (one row), then re-run `npm run db:verify`. If production reports no drift
  at all, nothing to do — it was migrated after the header commit.
- **License-header swap (PolyForm, every header-carrying migration):** the
  AGPL header on each of `0000`–`0016` (except `0012`) was replaced by the
  PolyForm Shield notice, which changes the sha256 recorded for any database
  where those migrations are already applied. The dev database has been
  repaired; **production must be repaired by a human before its next deploy**:
  after merging this change, run the deploy gate once (it will report
  `MISSING`/`EXTRA` for exactly the 16 header-carrying migrations), then
  backfill each row instead of re-running the migration:
  `UPDATE __drizzle_migrations SET hash = '<new sha256 from scripts/verify-migrations.mjs output>' WHERE hash = '<old sha256>';`
  (16 rows, one per migration; only the comment header differs — the SQL
  statements are byte-identical), then re-run `npm run db:verify`. A
  convenience is to compute old/new pairs from the pre- and post-merge file
  hashes (`sha256sum drizzle/<tag>.sql`) and update by exact old-hash match.
- For the multi-tenancy contract (migration `0013_channels_org_contract.sql`
  and later), also run the tenancy Definition-of-Done probe against the
  production database from a checkout with the production values sourced:
  `node --env-file=.env scripts/verify-tenancy.mjs`. It is read-only except
  one self-cleaning probe row, prints PASS/FAIL per invariant, and must end
  with `ALL CHECKS PASSED` (exit 0) before the tenancy rollout is declared
  done.

## 2. Netlify site

- Add the site from the Git repo; build settings come from `netlify.toml`.
- Set these in **Site settings → Environment variables**:

  | Variable | Notes |
  | --- | --- |
  | `TURSO_DATABASE_URL` | `libsql://...` from step 1 |
  | `TURSO_AUTH_TOKEN` | from step 1 |
  | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth client (Web) |
  | `OPENAI_API_KEY` | for AI scoring |
  | `STRIPE_SECRET_KEY` | Stripe API secret key (live mode) |
  | `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
  | `STRIPE_PRICE_CREDITS_100` / `STRIPE_PRICE_CREDITS_500` / `STRIPE_PRICE_CREDITS_2000` | Stripe Price IDs for the three credit bundles (active, one-time, USD — auto top-up validates all three) |
  | `ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
  | `CRON_SECRET` | any long random string; also used to trigger cron manually |
  | `MJ_APIKEY_PUBLIC` / `MJ_APIKEY_PRIVATE` | MailJet REST API key and secret key (contact-form verification e-mails) |
  | `MAILJET_FROM_EMAIL` | sender of the verification e-mails — must be verified in the Mailjet account (`https://app.mailjet.com/account/sender`) |
  | `MAILJET_FROM_NAME` | sender display name, e.g. `Moderaty` |
  | `APP_URL` | the deployed site URL, e.g. `https://moderaty.netlify.app` |
  | `DRY_RUN` | start with `true`; flip to `false` after verifying a dry run |

- **Two environments, two deploy contexts.** Set the same keys twice:
  the **production** context (`main` deploys) gets the production Google
  OAuth client and the production Turso database; the **branch-deploys**
  context (the `dev` branch and PR previews) gets the dev Google OAuth
  client and the dev Turso database. This is what keeps dev from touching
  production — do not point either context at the other's resources.
  The build command migrates + verifies against whichever database the
  context points at, so every production and `dev` deploy is gated on its
  own schema being current (Deploy Previews skip the migration step).

## 3. Mercado Pago (optional BRL prepaid credits)

- Create a Mercado Pago application for the target account and keep its
  access token and webhook secret only in the matching Netlify/Coolify context.
- Configure the `MERCADOPAGO_PRICE_*_BRL_CENTS` values and the exact BRL
  catalog used by the account; the app rejects missing or invalid amounts.
- Register `https://<your-site>/api/mercadopago/webhook` as the payment webhook
  URL and select payment notifications. The return URL is not authoritative;
  the signed webhook fetches the payment from Mercado Pago before crediting.
- Run a sandbox payment first. Confirm the credit ledger has one purchase row
  and that replaying the same webhook does not add credits twice.
- Exercise a full refund and, where the Mercado Pago account exposes it, a
  chargeback. Confirm a refund/dispute ledger reversal is created once, a
  partial refund is rejected for manual review, and a repeated notification
  does not reverse credits twice.
- Mercado Pago currently covers manual prepaid credits only. Stripe remains the
  provider for hosted plans and automatic top-up until separate mandate and
  refund/dispute behavior is implemented and reviewed.

## 4. Google Cloud Console

- Add the production redirect URI to the OAuth client:
  `https://<your-site>/api/auth/google/callback`
- The dev OAuth client additionally needs the dev redirect URIs:
  `https://dev--<your-site>.netlify.app/api/auth/google/callback` (the `dev`
  branch deploy) and `http://localhost:5173/api/auth/google/callback` for
  local development. Keep both clients in the same Google Cloud project.
- OAuth grants are per-client: a channel connected through one environment
  cannot be token-refreshed through the other (`401 unauthorized_client`).
  Connect channels separately in each environment.
- Consent screen: app name **Moderaty**, scope
  `https://www.googleapis.com/auth/youtube.force-ssl`; while unverified, add
  each channel owner's Gmail as a test user.

## 5. Cron

- `netlify/functions/cron.mjs` runs on a `* * * * *` schedule and calls
  `GET $APP_URL/api/cron` with the secret in an `Authorization: Bearer` header
  (never in the URL). Each invocation processes exactly
  one channel (least-recently-run first), so with N connected channels the
  per-channel scan cadence is N minutes at `* * * * *` (e.g. 5 channels ⇒ each
  scanned every 5 minutes). Raise the schedule frequency if N × interval grows
  past an acceptable cadence. A failed run throws and appears as a failed
  invocation in **Netlify → Functions → cron** logs.
- **Function timeout:** Netlify's default is 10s, below the trigger's 25s
  abort and the endpoint's 20s run budget. Raise it to 26s (Site settings →
  Functions) so the graceful-timeout path can fire; on a 10s limit the
  platform kills first (runs still recover via lease expiry, but failures are
  reported less cleanly).
- Manual trigger (e.g. right after connecting a channel) — prefer the header
  form so the secret stays out of shell history and logs:
  `curl -H "Authorization: Bearer <CRON_SECRET>" "https://<your-site>/api/cron"`
  (the endpoint also accepts the plan-documented `?secret=` query form as a
  fallback)

## 6. Post-launch verification

- Deploy, then open the site and connect a channel via Google OAuth.
- Trigger cron manually (above) with `DRY_RUN=true`; expect `dryRun: true`
  counts and `dry-run` audit rows, with no YouTube-side changes.
- Set `DRY_RUN=false`, redeploy/restart env, trigger again; confirm held
  comments appear in YouTube Studio → Comments → Held for review.
- Watch the next scheduled invocation succeed in the Netlify function logs.

## 7. Backups

- **Automated:** `.github/workflows/db-backup.yml` dumps the production
  database daily at 03:23 UTC and keeps the gzipped SQL dump as a workflow
  artifact for 30 days. One-time setup: mint a Turso platform API token
  (`turso auth api-tokens mint <name>`) and add it to the repo as the
  `TURSO_API_TOKEN` secret (Settings → Secrets and variables → Actions).
  A run without the secret, or one that produces no dump, fails loudly.
- **Manual:** with the turso CLI logged in,
  `node scripts/backup-db.mjs moderaty backups` writes
  `backups/moderaty-<timestamp>.sql.gz` (the `backups/` dir is gitignored).
  The script is read-only against the database and refuses to write an empty
  or schema-less dump.
- **Restore:** create a fresh Turso database, then load the dump:
  `gunzip -c backups/moderaty-<timestamp>.sql.gz | turso db shell <new-db>`.
  Point `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` at the new database in
  Netlify env vars, redeploy, and re-run `npm run db:migrate` only if the
  dump predates a newer migration (the dump includes `__drizzle_migrations`,
  so drizzle-kit applies just the gap). Verify per §1 afterwards.

## 8. Database outage runbook

Turso outages (e.g. HTTP 502 "connect to upstream failed") are Turso-side;
nothing in the app causes or can prevent them. When one happens:

1. Confirm it is Turso, not you: `turso db shell moderaty "SELECT 1;"`.
   `turso db show moderaty` succeeding while queries fail means
   control-plane up / data-plane down. Per-host stalls do NOT appear on
   status.turso.tech — a green status page proves nothing.
2. Do nothing destructive. A 502 fails before any write, so nothing is
   corrupted; cron simply misses runs and reconciles on the next successful
   invocation (invariants I3/I4). Expected impact: the dashboard errors
   loudly, moderation pauses, no data is lost and no wrong moderation
   actions occur. A deploy attempted during the outage now fails loudly at
   the build step (`db:migrate`/`db:verify` cannot reach the database) and
   Netlify does not publish — the old deploy keeps serving, which is the
   correct outcome. Retry the deploy after recovery.
3. Wait 15–30 minutes and retry. Past ~60 minutes, open a Turso support
   ticket with the database URL.
4. After recovery, re-verify any `db:migrate` that ran during the outage —
   drizzle-kit can exit 0 without applying anything (§1). Check
   `__drizzle_migrations` and the actual schema, never the exit code.

**Failure isolation (optional, human-only):** keep production and dev in
separate Turso groups or locations so one location-level stall cannot take
both down. Embedded replicas are not worth it on Netlify serverless
(ephemeral filesystem). If availability ever needs to exceed what Turso
single-primary offers, that is a re-platforming decision — do not paper
over it with silent fallbacks in app code.
