<!--
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
-->

# Deploying Moderaty to Netlify

The repo is deploy-ready: `netlify.toml` pins the build (`npm run build`,
publish `build`, Node 24) and `netlify/functions/cron.mjs` is a Netlify
Scheduled Function that triggers one bounded moderation run every minute
(during early operation; raise to `*/15 * * * *` when user volume grows).
Scheduled functions only fire on the published production deploy — branch
deploys and Deploy Previews never trigger them — so non-production
environments drain via `node --env-file=.env scripts/dev-cron.mjs`
(see AGENTS.md, Project Structure).
The steps below are the one-time manual setup.

## 1. Database (Turso)

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
  `when`) inside one transaction.
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
  | `ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
  | `CRON_SECRET` | any long random string; also used to trigger cron manually |
  | `APP_URL` | the deployed site URL, e.g. `https://moderaty.netlify.app` |
  | `DRY_RUN` | start with `true`; flip to `false` after verifying a dry run |

- **Two environments, two deploy contexts.** Set the same keys twice:
  the **production** context (`main` deploys) gets the production Google
  OAuth client and the production Turso database; the **branch-deploys**
  context (the `dev` branch and PR previews) gets the dev Google OAuth
  client and the dev Turso database. This is what keeps dev from touching
  production — do not point either context at the other's resources.

## 3. Google Cloud Console

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

## 4. Cron

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

## 5. Post-launch verification

- Deploy, then open the site and connect a channel via Google OAuth.
- Trigger cron manually (above) with `DRY_RUN=true`; expect `dryRun: true`
  counts and `dry-run` audit rows, with no YouTube-side changes.
- Set `DRY_RUN=false`, redeploy/restart env, trigger again; confirm held
  comments appear in YouTube Studio → Comments → Held for review.
- Watch the next scheduled invocation succeed in the Netlify function logs.

## 6. Backups

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

## 7. Database outage runbook

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
   actions occur.
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
