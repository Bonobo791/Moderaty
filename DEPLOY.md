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
- **Historical drift repair (16 migrations, REQUIRED before the first gated
  production deploy of this branch):** production has applied `0000`–`0019`
  (20 rows), but 16 rows in `__drizzle_migrations` record pre-header /
  AGPL-header / pre-contact-update hashes while the repo files were rewritten
  twice since (AGPL header → PolyForm Shield header → commercial-contact
  update). The gate will apply `0020`–`0035` cleanly, then fail verification
  with 16 `MISSING` + 16 `EXTRA` — the DDL is already applied; only the
  bookkeeping hashes drifted. Verified 2026-08-25 against production:
  14 of the 16 drifts are header-comment-only; the two exceptions are
  schema-equivalent (see below). Repair, from a checkout with the production
  values sourced:

  1. Let the gated deploy run its migrate step (it applies `0020`–`0035`,
     bringing production to 36 rows) and fail at verify.
  2. Dump the recorded hashes in rowid order:
     `SELECT rowid, hash FROM __drizzle_migrations ORDER BY rowid;`
  3. Run the reconciler with those 36 hashes as the attestation:
     `RECONCILE_EXPECTED_HASHES='["<row1 hash>",...,"<row36 hash>"]' node scripts/reconcile-migrations.mjs`
     It refuses on any count or positional mismatch, rewrites only the 16
     drifted rows in one write transaction, and read-back verifies each.
  4. `npm run db:verify` must pass; retry the deploy.

  Expected drifted rows (old → new, positional mapping confirmed against
  production 2026-08-25):

  | row | migration | old hash (prefix) | new hash |
  |---|---|---|---|
  | 1 | 0000_add_channel_scan_state | 9f0eacaf… | 9060bf3e5f994f40ae427a4295a475874b4b84a72d91c6f598da6a62ad1d2f09 |
  | 2 | 0001_add_moderation_actions | 8acc1c74… | cd2dc8c9ab50d916ed054dcd753e4044ac17c534324d503204fc4bee1d67d0a6 |
  | 3 | 0002_add_channel_cron_lease | 55a05b2f… | 44230339484f3387cd7ac5f52afb61b1449ef303a669162e8e8785ea0d103d88 |
  | 4 | 0003_wide_impossible_man | 4cb16c12… | 85270a0b3a5da75d5ad0cc95d9e09c2b727ebab5874943e68145f13c5ae84af2 |
  | 5 | 0004_smiling_nextwave | 70c0f38b… | 696cf965a32650cc83175617810aa7244a397761bac3f4c42852e93cefc3e9db |
  | 6 | 0005_common_texas_twister | cb7ee4c3… | 623b8e563f512762d7a2dba079f4f73a451276e8a87341eebcf269679a8a71e7 |
  | 7 | 0006_huge_boom_boom | 8c7d1440… | 0a48f2df03625f4dbee4a505aa114bc0d8981368f2950ac160cab73901269ab0 |
  | 8 | 0007_curved_blade | 7bc5adea… | c3a8336f8d3a3cd26f6dd84f6312f1c70c4aed95f8b25c576a145f760fc3d638 |
  | 9 | 0008_relax_comment_author_pii | 6b573491… | 93afef62f0ba015862e2cbbea3612296827eb03e48607bd9d978673b721bf58c |
  | 10 | 0009_aromatic_red_wolf | d49389ca… | 5ff4ba9ce1014545bc00aa408096a59e5910ab2175b93a54293daf7716e2b20d |
  | 11 | 0010_users_deleted_at_idx | dcbbf7fa… | 52daf06dd958dc9b87cdf6df4565431e846252c718c8a8777e218adf309fda12 |
  | 12 | 0011_consents_email | 20cb0570… | 3ec78e46da33c9174e88cc8a2efd120b2f4e170b24315c903b934657b453c65b |
  | 14 | 0013_channels_org_contract | 61e5ed85… | 0a38b7389a1dfb5800d51fc36e82cf902bbb104388a4d81d7eed0aa8beccc5ff |
  | 15 | 0014_channels_history_state | 283fda6a… | ca35c57b8f4b2fb016806330c1add91b9d3fec661c13ba704679a458e85b3c9c |
  | 16 | 0015_channels_protect_flags | 94d2659e… | f66ddfb2b37e7ea08a1fb41d30e135e1af6ecdefd73e41d654440540c6134fae |
  | 17 | 0016_audit_log_channel_action_idx | ca78ba56… | 27deb209b6fa421a67708ea74a04761c46101d7cdcc6ae80fd716988f289973e |

  Rows 13 (`0012`), 18–20 (`0017`–`0019`) already match the current files —
  they were applied after the last header rewrite.

  The two non-header drifts, both safe to rehash:
  - `0013` also gained `DROP TABLE IF EXISTS __new_channels` (mid-rebuild
    retry guard). It only changes re-run behavior; production applied the
    rebuild successfully, so the live schema is identical.
  - `0014` tightened its backfill to `WHERE next_page_token IS NOT NULL AND
    scan_cursor IS NOT NULL`. Production ran the looser version, so channels
    that had a continuation token but no scan boundary were backfilled into
    the unresumable shape (`history_next_page_token` set, `history_boundary`
    NULL). Schema is identical; to clear those stale rows after the repair:
    `UPDATE channels SET history_next_page_token = NULL WHERE history_next_page_token IS NOT NULL AND history_boundary IS NULL;`

  **Going forward: never edit a migration file that any environment has
  already applied — not even comments.** The deploy gate hashes file
  contents; a header or wording change strands the database with
  MISSING/EXTRA drift. New behavior always ships as a NEW migration.
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
