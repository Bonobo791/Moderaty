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

# Manual end-to-end verification (execution plan v3, steps 27–28)

These checks require real credentials and a browser-driven Google consent
flow, so they are human tasks. Everything automatable has already been
verified (see the Phase H PR body).

## Step 27 — Credentials

- [ ] Google Cloud Console → project → enable **YouTube Data API v3**
- [ ] OAuth consent screen (external; scope
      `https://www.googleapis.com/auth/youtube.force-ssl`; test Gmail added as
      a test user; app name shown to users: **Moderaty**)
- [ ] OAuth client (Web) with authorized redirect URI
      `http://localhost:5173/api/auth/google/callback`
- [ ] `.env` filled with real `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` /
      `OPENAI_API_KEY`, a generated `ENCRYPTION_KEY`
      (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`),
      and a `CRON_SECRET`
- [ ] `DRY_RUN=true` for the first run

## Step 28 — Live smoke test

- [ ] `npm run dev`, open `http://localhost:5173`, connect a YouTube channel
      via Google OAuth; expect redirect back with the channel card visible
- [ ] Add one keyword rule matching a word in a recent comment (action: `hold`)
- [ ] `curl "http://localhost:5173/api/cron?secret=<CRON_SECRET>"` — expect
      `dryRun: true`, per-channel `{ fetched, acted, queued }` counts, no
      `error` values
- [ ] Audit log page shows rows; rule hit appears as action `dry-run`; no
      YouTube-side changes (dry run changes nothing durable — I8)
- [ ] Set `DRY_RUN=false`, restart, re-run cron — expect the matched comment
      held on YouTube (YouTube Studio → Comments → Held for review), DB status
      updated, audit row with actor `system`
- [ ] Approve one pending queue item from the UI — expect status change and
      audit row with actor `user`

## Troubleshooting (from the plan)

- `redirect_uri_mismatch` → fix the redirect URI in Google Cloud Console, not
  the code.
- Missing `refresh_token` on reconnect → revoke the app at
  https://myaccount.google.com/permissions and reconnect.
- `quotaExceeded` → wait for the daily quota reset; do not create extra
  Google Cloud projects.
