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

# Moderaty on Coolify + Bunny CDN (implementation plan & operator runbook)

Status: planned, scaffolding implemented · Date: 2026-08-17
Sources for every platform claim: [`docs/coolify-bunny-research.md`](coolify-bunny-research.md).

The repo supports **two deploy targets**. Netlify (unchanged, see
[`DEPLOY.md`](../DEPLOY.md)) stays as the managed option; **Coolify + Bunny CDN
is the operator's self-hosted dev/prod environment**, and Netlify is retired
for the operator after a verified cutover (§8). A deployer picks either
target — the choice is the build-time `MODERATY_ADAPTER` env (`node` vs unset), nothing
else differs.

## 1. Architecture

```
GitHub ──push──▶ Coolify (self-hosted server)
                   ├─ app "moderaty-prod"  branch main   ──▶ Bunny CDN pull zone ──▶ users (public domain)
                   │    · scheduled task every minute → /api/cron (localhost)
                   │    · post-deployment command → bunny-purge.mjs
                   └─ app "moderaty-dev"   branch dev    ──▶ users (dev domain, no CDN)
                        · scheduled task every minute → /api/cron (localhost)

Turso (external): prod app → production DB · dev app → dev-2 DB
Netlify: unchanged until cutover; its production scheduled function keeps
ticking the SAME production DB — safe, because /api/cron claims each channel
with an expiring DB lease (channels.lease_expires_at), so two schedulers can
never process one channel twice.
```

Requirements met by this design:

- **Every commit auto-deploys on Coolify.** Both apps use the Coolify GitHub
  App integration: push events to `main` redeploy the prod app, push events to
  `dev` redeploy the dev app (Auto Deploy is on by default; the branch is
  fixed per app at resource creation). The App's webhook endpoint
  (`https://<coolify>/webhooks/source/github/events`) must be reachable from
  GitHub or auto-deploys silently stop — verify with a test push.
- **Every deploy updates Bunny CDN.** The prod app's Post Deployment Command
  runs `node scripts/bunny-purge.mjs` inside the freshly deployed container:
  `POST https://api.bunny.net/purge?url=<public-domain>/*&async=true` with the
  account API key. Bunny never watches the origin, so the purge is what makes
  a deploy visible. A failed purge fails the post-deployment command loudly.
- **Fail-loud, bounded, idempotent — the same invariants as Netlify.**
  The image build is gated by `scripts/netlify-migrate.mjs` (migrate + verify
  before build; `CONTEXT` unset = the conservative always-run default); the
  health check hits `/api/health` (fails on a dead database); cron ticks one
  channel per minute via the lease-protected `/api/cron`; `DRY_RUN=true`
  until verified (I8); a failed tick exits non-zero and appears in the
  scheduled-task log.

## 2. What already ships in the repo (this change)

| File | Purpose |
| --- | --- |
| `svelte.config.js` | Dual adapter: `MODERATY_ADAPTER=node` → adapter-node; unset → adapter-netlify; any other value fails the build loudly. Netlify builds unchanged. Guarded by `svelte.config.test.ts`. |
| `Dockerfile` | Multi-stage (node:24-alpine): `npm ci` → migrate+verify gate (`ARG TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`, which Coolify passes as build args; inline RUN env, never baked ENV) → `MODERATY_ADAPTER=node` build → runtime stage with prod deps only, `scripts/` included for the in-container cron/purge commands, unprivileged `app` user, `PORT=3000`, `HEALTHCHECK /api/health`. |
| `.dockerignore` | Keeps `drizzle/` + `scripts/` in the build context (migrations run in-build); excludes `.env`, `node_modules`, `build`, worktrees. |
| `scripts/bunny-purge.mjs` | Whole-site wildcard purge with `BUNNY_ACCESS_KEY`; wildcard pattern from `BUNNY_PURGE_URL` (defaults to `APP_URL`); non-OK answers throw; CLI exits non-zero. Tested in `scripts/bunny-purge.test.mjs`. |
| `scripts/dev-cron.mjs` | Now also the container scheduler: Coolify Scheduled Task runs `APP_URL=http://127.0.0.1:3000 node scripts/dev-cron.mjs --once` every minute (localhost, so the tick never traverses the CDN). |
| `docs/coolify-bunny-research.md` | Platform research with doc citations (kept for audit). |

Note: `netlify.toml`, `netlify/functions/cron.mjs`, and adapter-netlify stay
in the repo — the Netlify target remains fully supported as the "choice of
either" option.

## 3. Coolify — production app (`moderaty-prod`, branch `main`)

One-time setup (human, in the Coolify dashboard):

1. Install the Coolify **GitHub App** on the repo (or, without the App: create
   the resource with a deploy key, enable Auto Deploy, and add Coolify's
   per-source webhook URL + secret to the GitHub repo for "Just the push
   event"). Verify `https://<coolify>/webhooks/source/github/events` is
   reachable — the App route is what makes push-to-deploy work.
2. Create application → **Build Pack: Dockerfile**, **branch: `main`**.
3. **Ports Exposes: 3000**; **Health Check**: path `/api/health` (the
   container also ships a Dockerfile HEALTHCHECK).
4. **Environment Variables** (same ten keys as the Netlify production
   context, plus the Coolify/Bunny additions):

   | Variable | prod | dev app | Notes |
   | --- | --- | --- | --- |
   | `TURSO_DATABASE_URL` | production DB | `dev-2` DB | **Build Variable ON** (becomes the Docker ARG) + runtime |
   | `TURSO_AUTH_TOKEN` | production | dev | Build Variable ON + runtime |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | production client | dev client | keep the existing clients — grants survive |
   | `OPENAI_API_KEY` | production | dev | |
   | `ENCRYPTION_KEY` | production value | dev value | `crypto.randomBytes(32).toString('hex')` per env |
   | `CRON_SECRET` | production value | dev value | any long random string |
   | `APP_URL` | `https://<public-domain>` (Bunny) | `https://<dev-domain>` | drives OAuth `redirect_uri` + Secure cookies |
   | `ORIGIN` | `https://<public-domain>` | `https://<dev-domain>` | adapter-node URL generation — pins origin behind the CDN |
   | `DRY_RUN` | `true` → `false` after verification | `true` | I8 |
   | `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | production | dev | Stripe is live on this branch |
   | `BUNNY_ACCESS_KEY` | account API key | *(omit)* | used by the purge script; dev has no Bunny zone |

   Do not set `MODERATY_ADAPTER` at runtime — it is build-time only (the
   Dockerfile sets it). Do not set `CONTEXT` — unset is the always-migrate
   default.

5. **Scheduled Task** (Scheduled Tasks → application): expression `* * * * *`,
   command `APP_URL=http://127.0.0.1:3000 node scripts/dev-cron.mjs --once`.
   One task replaces the Netlify Scheduled Function; N channels ⇒ each
   channel scanned every N minutes, exactly as on Netlify. Failures appear as
   failed tasks — loud, never silent.
6. **Post Deployment Command** (Advanced menu, runs with `sh -c` in the new
   container after each successful deployment):
   `node scripts/bunny-purge.mjs`. A failed purge fails the post-deployment
   step loudly.
7. **Domain**: the app's fqdn is the *origin* hostname (e.g.
   `moderaty-prod.<server>`); the public domain points at Bunny (§5), not at
   the app.

## 4. Coolify — dev app (`moderaty-dev`, branch `dev`)

Same as §3 with these deltas: branch `dev`; the **dev** Turso database, dev
Google OAuth client, dev Stripe keys; `DRY_RUN=true`; its own domain; no
`BUNNY_ACCESS_KEY` and no post-deployment purge (no CDN in front of dev — add
a second Bunny zone later if edge behavior needs staging). Scheduled Task
identical (ticks the dev DB). Every push to `dev` auto-deploys here, so this
instance doubles as the live branch-deploy that Netlify used to provide.

## 5. Bunny CDN — production pull zone

1. **Pull zone** (`moderaty-prod`), origin type *Origin URL* =
   `https://<app-fqdn>` (§3.7). Standard hostname `<name>.b-cdn.net`.
2. **Host header** — critical: Bunny does **not** forward the original Host by
   default (it sends the hostname from the Origin URL). Set the zone's
   **AddHostHeader** flag on (forwards the requested Host) *and* keep
   `ORIGIN` (§3.4) set — SvelteKit URL generation and the form-action CSRF
   check then see the public domain, not the internal fqdn.
3. **Custom domain**: add the hostname in the zone, CNAME your domain to
   `<name>.b-cdn.net` (apex domains need Bunny DNS flattening or a www
   redirect). Bunny provisions the Let's Encrypt certificate.
4. **Cache rules** — SvelteKit already sends correct headers (immutable
   assets: `immutable, 1y`; HTML: `no-cache`; Bunny honors origin
   `Cache-Control`). Make it explicit with Edge Rules:
   - Request URL matches `/_app/immutable/*` → **Override Cache Time 31536000**
   - Request URL matches `*/api/*` and `*.html` → **Override Cache Time 0**
     (edge bypass) — keeps the dashboard, consent, and auth flows uncached.
   - Smart Cache (never caches `text/html`/`application/json`) may stay on;
     the rules above are the guarantee regardless.
5. **Purge wiring** is the prod app's post-deployment command (§3.6). Rate
   limits (~30 wildcard purges/min) are irrelevant at one purge per deploy.
   If the account key ever becomes a concern, the alternative is the per-zone
   `POST /pullzone/{id}/purgeCache` endpoint.

## 6. Google OAuth

- `APP_URL` constructs every OAuth `redirect_uri`
  (`src/lib/server/google.ts`), so `APP_URL` **must** be the public Bunny
  domain on prod and the dev domain on dev.
- Add to the **existing** clients (grants are per-client, so reusing the
  clients means **no channel reconnects**):
  - production client: `https://<public-domain>/api/auth/google/callback` and
    `https://<public-domain>/api/auth/google/login/callback`
  - dev client: the same two paths on `https://<dev-domain>`
- Keep the existing Netlify URIs registered until Netlify is retired (§8).

## 7. Cron model after cutover

- Prod and dev each drain through their own container's Scheduled Task; both
  hit `/api/cron` on localhost with `CRON_SECRET` in the Authorization header.
- Until Netlify is retired its production Scheduled Function keeps ticking the
  same production DB — the per-channel DB lease makes the overlap safe
  (double cadence at worst, never double processing).
- Retention sweeps (consent e-mails 10y, handles 30d) run inside the same
  endpoint and move to Coolify with it; `DRY_RUN` keeps both no-ops (I8).

## 8. Cutover & Netlify retirement (human-only, in order)

Each step has a verify gate; do not proceed past a failed gate.

1. **Dev app first** (dev DB is safe to break): deploy, check health, sign in,
   connect a channel, confirm the scheduled task ticks with `dryRun: true`.
2. **Prod app**: deploy, health, `DRY_RUN=true` manual tick
   (`curl -H "Authorization: Bearer <CRON_SECRET>" https://<app-fqdn>/api/cron`)
   → expect dry-run audit rows and no YouTube-side changes.
3. **Bunny zone**: browse via `https://<name>.b-cdn.net` — sign-in/OAuth
   completes, Host/Origin behave (check a page's absolute URLs), static
   assets cache (`/_app/immutable/*`), HTML does not.
4. **DNS cutover** to Bunny (CNAME + certificate) — the externally visible
   step; schedule it.
5. **OAuth on the public domain** end-to-end, including an existing channel's
   token refresh (proves the reused prod client's grant is intact).
6. **Go live**: `DRY_RUN=false` on prod, trigger one tick, verify held
   comments appear in YouTube Studio.
7. **Soak 1–2 weeks** with Netlify production still published (its cron
   overlaps safely per §7 — or pause it from Netlify's Functions UI).
8. **Retire Netlify**: delete the Netlify site (stops its builds and
   Scheduled Function); optionally remove the Netlify redirect URIs from both
   Google clients. Leave `netlify.toml`, `netlify/`, and adapter-netlify in
   the repo — Netlify stays a supported target for anyone who wants it.

## 9. Open items / unverified details

- Exact current-UI location of Coolify **Scheduled Tasks** and the
  per-application webhook tab (research could not confirm; the features exist
  and are application-level — locate them in your Coolify version).
- **Alternative purge trigger**: Coolify Notifications → Webhook channel on
  `deployment_success` (payload carries `fqdn`/`application_uuid`) if the
  post-deployment command ever proves insufficient.
- `X-Forwarded-Proto` behind Bunny was not verified; `ORIGIN` (§3.4) removes
  the dependency, so confirm at gate 3 rather than assume.
- Turso embedded replicas on the Coolify server are a possible future
  optimization (persistent disk) — out of scope; do not paper over
  availability with silent fallbacks (DEPLOY.md §7).
