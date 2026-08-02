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

## 3. Google Cloud Console

- Add the production redirect URI to the OAuth client:
  `https://<your-site>/api/auth/google/callback`
- Consent screen: app name **Moderaty**, scope
  `https://www.googleapis.com/auth/youtube.force-ssl`; while unverified, add
  each channel owner's Gmail as a test user.

## 4. Cron

- `netlify/functions/cron.mjs` runs on a `* * * * *` schedule and calls
  `GET $APP_URL/api/cron` with the secret in an `Authorization: Bearer` header
  (never in the URL). Each invocation processes exactly
  one channel (least-recently-run first), so the schedule sets the
  per-channel scan cadence. A failed run throws and appears as a failed
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
