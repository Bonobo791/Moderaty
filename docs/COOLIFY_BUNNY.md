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
                   │    · GitHub Actions on push to main → bunny-purge.mjs (outside the container)
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
- **Every PRODUCTION deploy updates Bunny CDN.** A GitHub Actions workflow
  (`.github/workflows/bunny-purge.yml`) runs `node scripts/bunny-purge.mjs`
  on every push to `main` — the same event that deploys production on both
  targets — purging `https://<public-domain>/*` from outside the container.
  Bunny never watches the origin, so the purge is what makes a deploy
  visible. The dev app has no CDN and never purges. A failed purge fails the
  workflow loudly. The purge key is a **least-privilege Bunny API key scoped
  to the production zone** (never the account-level key), stored as a GitHub
  Actions secret — it never ships in the application runtime environment, so
  a compromised container cannot purge other zones.
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
| `Dockerfile` | Multi-stage (node:24-alpine): `npm ci --ignore-scripts` (docker:S6505) → migrate+verify gate (TURSO_* arrive as **BuildKit secret mounts** — `--secret id=KEY,env=KEY` with Coolify's "Use Docker Build Secrets", never ARG/ENV, docker:S6472) → `MODERATY_ADAPTER=node` build → runtime stage with prod deps only, `scripts/` included for the in-container cron/purge commands, unprivileged `app` user, `PORT=3000`, `HEALTHCHECK /api/health`. |
| `.dockerignore` | Keeps `drizzle/` + `scripts/` in the build context (migrations run in-build); excludes `.env`, `node_modules`, `build`, worktrees. |
| `scripts/bunny-purge.mjs` | Whole-site wildcard purge with `BUNNY_ACCESS_KEY` (a zone-scoped key; the script never runs inside the app container); wildcard pattern from `BUNNY_PURGE_URL` (defaults to `APP_URL`); non-OK answers throw; CLI exits non-zero. Tested in `scripts/bunny-purge.test.mjs`. |
| `.github/workflows/bunny-purge.yml` | Runs the purge on every push to `main` (= every production deploy), with `BUNNY_ACCESS_KEY`/`BUNNY_PURGE_URL` from repository secrets. |
| `scripts/bunny-purge.mjs` CLI guard | Normalized-path direct-execution check — `node scripts/bunny-purge.mjs` from any cwd enters the purge flow; imports (tests) never do. |
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
   | `TURSO_DATABASE_URL` | production DB | `dev-2` DB | **Build Variable ON** + runtime; delivered to the build as a BuildKit secret |
   | `TURSO_AUTH_TOKEN` | production | dev | Build Variable ON + runtime; delivered to the build as a BuildKit secret |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | production client | dev client | keep the existing clients — grants survive |
   | `OPENAI_API_KEY` | production | dev | |
   | `ENCRYPTION_KEY` | production value | dev value | `crypto.randomBytes(32).toString('hex')` per env |
   | `CRON_SECRET` | production value | dev value | any long random string |
   | `APP_URL` | `https://<public-domain>` (Bunny) | `https://<dev-domain>` | drives OAuth `redirect_uri` + Secure cookies |
   | `ORIGIN` | `https://<public-domain>` | `https://<dev-domain>` | adapter-node URL generation — pins origin behind the CDN |
   | `DRY_RUN` | `true` → `false` after verification | `true` | I8 |
   | `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | production | dev | Stripe is live on this branch |
   | `STRIPE_PRICE_CREDITS_100` / `STRIPE_PRICE_CREDITS_500` / `STRIPE_PRICE_CREDITS_2000` | production Prices | dev Prices | one-time USD Price IDs for the 100/500/2,000-credit bundles; auto top-up validates active/currency/type |
   Do not set `BUNNY_ACCESS_KEY` in the application environment — the purge
   runs OUTSIDE the container (`.github/workflows/bunny-purge.yml`), with a
   least-privilege zone-scoped Bunny key stored as a GitHub Actions secret.
   An account-level key inside the production container could purge every
   zone in the account if the container were compromised (coderabbit).

   Do not set `MODERATY_ADAPTER` at runtime — it is build-time only (the
   Dockerfile sets it). Do not set `CONTEXT` — unset is the always-migrate
   default.

   **Critical build setting**: in the application's **Advanced** menu enable
   **Use Docker Build Secrets**. The Dockerfile's migrate+verify gate reads
   the TURSO_* build variables exclusively as BuildKit secret mounts
   (`--secret id=KEY,env=KEY`, docker:S6472 — never as `--build-arg`), so a
   build without this setting fails loudly at the gate with a BuildKit
   "secret not found" error. This is by design: the credentials must never
   appear in build args, image history, or baked layers.

5. **Scheduled Task** (Scheduled Tasks → application): expression `* * * * *`,
   command `APP_URL=http://127.0.0.1:3000 node scripts/dev-cron.mjs --once`.
   One task replaces the Netlify Scheduled Function; N channels ⇒ each
   channel scanned every N minutes, exactly as on Netlify. Failures appear as
   failed tasks — loud, never silent.
6. **Domain**: the app's fqdn is the *origin* hostname (e.g.
   `moderaty-prod.<server>`); the public domain points at Bunny (§5), not at
   the app.

### 3.5 CDN cache purge (production only)

After every production deploy (a push to `main` — the trigger for both the
Netlify and the Coolify production apps), the
[`bunny-purge.yml`](../.github/workflows/bunny-purge.yml) workflow runs
`node scripts/bunny-purge.mjs` with the **repository secrets**:

| Secret | Value |
| --- | --- |
| `BUNNY_ACCESS_KEY` | a Bunny API key **scoped to the production pull zone** (least privilege — never the account-level key) |
| `BUNNY_PURGE_URL` | the production public domain (defaults to `APP_URL`) |

The key never enters the container's runtime environment; the purge never
runs inside production with account-level credentials. The dev app has no
CDN and never purges.

## 4. Coolify — dev app (`moderaty-dev`, branch `dev`)

Same as §3 with these deltas: branch `dev`; the **dev** Turso database, dev
Google OAuth client, dev Stripe keys; `DRY_RUN=true`; its own domain; no
`BUNNY_ACCESS_KEY` and no purge at all (no CDN in front of dev — add a
second Bunny zone later if edge behavior needs staging; the
bunny-purge workflow fires only on pushes to `main`). The **Use Docker
Build Secrets** build setting (§3.4) applies here exactly as on prod — the
dev TURSO_* build variables reach the migrate gate as secret mounts, never
as build args. Scheduled Task
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
5. **Purge wiring** is the GitHub Actions workflow on push to `main` (§3.5) —
   it runs OUTSIDE the container with a zone-scoped key from repository
   secrets. Rate limits (~30 wildcard purges/min) are irrelevant at one purge
   per deploy. If the zone-scoped key ever becomes a concern, the alternative
   is the per-zone `POST /pullzone/{id}/purgeCache` endpoint.

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
  GitHub Actions workflow ever proves insufficient.
- `X-Forwarded-Proto` behind Bunny was not verified; `ORIGIN` (§3.4) removes
  the dependency, so confirm at gate 3 rather than assume.
- Turso embedded replicas on the Coolify server are a possible future
  optimization (persistent disk) — out of scope; do not paper over
  availability with silent fallbacks (DEPLOY.md §7).
