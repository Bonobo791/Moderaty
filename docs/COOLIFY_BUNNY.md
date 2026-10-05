# Moderaty on Coolify + Bunny CDN (implementation plan & operator runbook)

Status: scaffolding implemented and repo-side verified (2026-08-18:
adapter builds, migrate gate against dev Turso, node-server smoke test, and
the §9 doc/`ORIGIN` claims all confirmed); cutover (§8) is pending and
human-only.
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
with an expiring DB lease (channels.lease_expires_at), so a second scheduler
cannot claim a channel while its lease remains held.
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
  health check hits `/api/health` (fails on a dead database); each cron tick
  runs at most one workload via the lease-protected `/api/cron`;
  `DRY_RUN=true` until verified (I8). Operator-actionable tick failures exit
  non-zero and appear in the scheduled-task log; channel-owner-only failures
  are suppressed as described in the Scheduled Task setup below.

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
   | `OPENAI_JAILBREAK_MODEL` | optional | optional | prompt-injection detector model; defaults to `gpt-6-luna` |
   | `ENCRYPTION_KEY` | production value | dev value | `crypto.randomBytes(32).toString('hex')` per env |
   | `CRON_SECRET` | production value | dev value | any long random string |
   | `APP_URL` | `https://<public-domain>` (Bunny) | `https://<dev-domain>` | drives OAuth `redirect_uri` + Secure cookies |
   | `ORIGIN` | `https://<public-domain>` | `https://<dev-domain>` | adapter-node URL generation — pins origin behind the CDN |
   | `DRY_RUN` | `true` → `false` after verification | `true` | I8 |
   | `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | production | dev | Stripe is live on this branch |
   | `STRIPE_PRICE_CREDITS_100` / `STRIPE_PRICE_CREDITS_500` / `STRIPE_PRICE_CREDITS_2000` | production Prices | dev Prices | one-time USD Price IDs for the 100/500/2,000-credit bundles; auto top-up validates active/currency/type |
   | `STRIPE_PRICE_HOSTED_MONTHLY` / `STRIPE_PRICE_LIFETIME` | production Prices | dev Prices | hosted USD 5 monthly recurring Price and USD 49 one-time Price; the app validates mode, currency, amount, and interval |
   | `STRIPE_TEST_PRODUCT` | optional | optional | a Product (`prod_…`) or Price (`price_…`) id in the app's own Stripe environment — enables the "Test checkout" card that smoke-tests the billing pipeline with a real purchase (grants 1 credit); the card renders only for the operator account hardcoded in `src/lib/server/billing/checkout.ts`, never for other users |
   | `MERCADOPAGO_ACCESS_TOKEN` / `MERCADOPAGO_WEBHOOK_SECRET` | production | dev | optional BRL prepaid credit checkout; webhook fulfillment is signed and idempotent |
   | `MERCADOPAGO_ENVIRONMENT` / `MERCADOPAGO_PRICE_CREDITS_*_BRL_CENTS` | production | sandbox | optional Mercado Pago sandbox/production mode and BRL bundle prices in cents |
   | `PROTON_SMTP_USERNAME` / `PROTON_SMTP_TOKEN` | production token | dev token | Proton Mail SMTP for transactional e-mail (contact-form verification and service notices, incl. zero-credit account warnings). Username = the custom-domain sender mailbox and doubles as the From address (domain active in Proton, SPF/DKIM/DMARC verified); token from Proton → Settings → All settings → IMAP/SMTP → SMTP tokens — never the mailbox password, and a separate token per environment |
   | `PROTON_FROM_NAME` | `Moderaty` | `Moderaty` | optional sender display name; defaults to `Moderaty` |

   **Stripe webhook endpoint is per-environment, per-sandbox.** Register
   `https://<app-domain>/api/stripe/webhook` under **Developers → Webhooks**
   (Workbench → Event destinations) once per app — `moderaty-prod`'s in the
   live environment, `moderaty-dev`'s inside whichever test environment or
   *named sandbox* owns that app's `STRIPE_SECRET_KEY` and Prices. Endpoints
   do not cross environments: an endpoint registered in the default test
   environment never receives a sandbox's events, and vice versa — that
   mismatch silently starves every webhook (`stripe_events` stays empty,
   plans never flip to `hosted`, saved cards never appear). Pin each
   endpoint's API version to the SDK's (`2026-07-29.dahlia`, see
   `src/lib/server/stripe/client.ts`) and copy *that endpoint's* signing
   secret into the app's `STRIPE_WEBHOOK_SECRET` — a `stripe listen` secret
   or another endpoint's `whsec_` fails verification with
   `400 invalid signature`. Subscribe the endpoint to every event the
   dispatcher handles (full list in DEPLOY.md §2); after a HOSTED purchase,
   the endpoint's Deliveries should show 2xx for `customer.subscription.created`
   and `invoice.paid`, and the Usage page should show the new plan and saved
   card — a LIFETIME purchase is a one-time payment, so it produces
   `checkout.session.completed`/`payment_intent.succeeded`/`charge.succeeded`
   but no subscription events. A `500 handler failed` delivery is an
   application bug — check the app log, not the endpoint config.

   Do not set `BUNNY_ACCESS_KEY` in the application environment — the purge
   runs OUTSIDE the container (`.github/workflows/bunny-purge.yml`), with a
   least-privilege zone-scoped Bunny key stored as a GitHub Actions secret.
   An account-level key inside the production container could purge every
   zone in the account if the container were compromised (coderabbit).

   Do not set `MODERATY_ADAPTER` at runtime — it is build-time only (the
   Dockerfile sets it). Do not set `CONTEXT` — unset is the always-migrate
   default.

   **E-mail cutover (per app, env before code).** The transport is fixed —
   `smtp.protonmail.ch:587`, mandatory STARTTLS
   (`src/lib/server/protonMail.ts`). Set `PROTON_SMTP_USERNAME`,
   `PROTON_SMTP_TOKEN`, and `PROTON_FROM_NAME` as Runtime Variables BEFORE
   the deploy that sends e-mail reaches the app; the transport fails loudly
   with a variable-specific `is not configured` error until both required
   vars exist, so env-before-code ordering makes the switch a config step,
   not an outage. The container must egress outbound **TCP 587** — verify
   on the actual deployment by submitting the contact form once and
   expecting the verification e-mail (or a loud `500 e-mail could not be
   sent (...)`); a copy lands in the Proton mailbox's Sent folder as the
   submission record (SMTP acceptance, not recipient delivery — there are
   no delivery webhooks on this transport). Failure mapping is
   generic-to-client with sanitized codes in the server
   log: `authentication failure` (bad/absent/expired token), `TLS failure`,
   `provider throttled the request` (every Proton 4xx maps to this label —
   check the logged response code before assuming a send limit; Proton is
   a mailbox service, not a bulk-mail platform),
   `provider rejected the request` (5xx), `send timed out`. Token rotation:
   mint the new SMTP token, update the var, verify a send, THEN revoke the
   old one. Rollback: redeploy the previous release and remove the
   `PROTON_*` vars — no Mailjet env was ever provisioned, so rollback
   restores the unconfigured-transport state; there is no Mailjet side to
   retire.

   **Critical build setting**: enable **Use Docker Build Secrets** for the
   application — in current Coolify it lives on the application's
   **Environment Variables** settings page (not the Advanced menu). The
   Dockerfile's migrate+verify gate reads the TURSO_* build variables
   exclusively as BuildKit secret mounts (`--secret id=KEY,env=KEY`,
   docker:S6472 — never as `--build-arg`). Without the setting (or without
   the Build Variable flags, or without BuildKit secret support on the build
   server) the secret mounts are **empty**, the env vars never reach the
   build, and the gate aborts loudly: the 2026-08-19 production symptom was
   `netlify-migrate: TURSO_DATABASE_URL is not set` (drizzle-kit dying with
   `TURSO_DATABASE_URL is required` from `drizzle.config.ts` is the same root
   cause one step later). The gate's preflight error names the fix. This is
   by design: the credentials must never appear in build args, image history,
   or baked layers.

   **Interrupted npm downloads.** The dependency-install step runs
   `scripts/install-dependencies.mjs`, keeping `npm ci --ignore-scripts` and
   npm's fetch retries. A connection reset while reading a tarball can escape
   those fetch retries. The helper logs and retries the whole locked install
   for `ECONNRESET`, `ETIMEDOUT`, or `EAI_AGAIN`, with at most three attempts
   and waits of 5 then 10 seconds. A BuildKit npm cache retains verified
   downloads; `npm ci` replaces partial `node_modules`. Permanent errors
   (including invalid lockfiles, integrity failures, and authentication
   failures) stop immediately. If all three attempts fail, the image build
   remains blocked: inspect the build server's registry connectivity and
   retry the deployment after it recovers.

   **Operator checklist (all three, then redeploy):**
   1. **Use Docker Build Secrets** is ON (Environment Variables settings).
   2. **Build Variable ON for `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`
      only** — Coolify passes exactly the build-flagged variables as secrets
      (`is_buildtime`); a variable with Build Variable OFF never reaches the
      gate. The 2026-08-19 14:16 retry failed for exactly this reason: every
      variable had Build Variable OFF, so no secret arrived.
   3. The build server's Docker supports BuildKit secrets — Coolify probes
      `docker build --help | grep -q secret` and, if it fails, **silently
      falls back to `--build-arg`** even with the setting on, failing the
      gate with the same symptom. Requires Docker 18.09+ with BuildKit.
   4. **Include Source Commit in Build** is ON (app settings) — Coolify
      excludes `SOURCE_COMMIT` from builds by default (cache preservation).
      The Dockerfile bakes it into `static/__moderaty_commit.txt` (via a
      BuildKit secret mount in secrets mode, `--build-arg SOURCE_COMMIT`
      otherwise) so the bunny-purge workflow can wait for the deploy to
      serve the pushed commit before purging; without it the marker reads
      `unknown` and the wait always times out.

   **Expired Turso tokens fail loudly now.** After the credential env check,
   the gate's first spawned step is `scripts/db-preflight.mjs`, a `SELECT 1`
   through the same `@libsql/client`
   driver drizzle-kit uses — added because drizzle-kit exits 1 with *no*
   output on connection failures (the 2026-09-17 dev deploy showed only
   spinner frames; the cause was a 30-day `TURSO_AUTH_TOKEN` that had expired
   12 days earlier). If the gate fails with `db-preflight: cannot reach the
   database — ... HTTP status 401`, mint a non-expiring token for the
   database in the failing `TURSO_DATABASE_URL` — `turso db tokens create
   dev-2 -e never` for the dev app, `turso db tokens create
   moderaty-bonobo791 -e never` for prod (never a dev token for a prod
   outage) — and update every copy: the
   worktree `.env`, this app's env vars, and the Netlify branch-deploys
   context.

   **An extra migration hash can indicate a lost journal entry.** The
   2026-10-04 deployment of `bd7e04e` passed preflight and migration, then
   verification rejected `EXTRA applied hash da0cfc786b88…` (66 applied,
   65 journal entries). That hash belongs to the unchanged
   `0064_cron_workload_fairness.sql`; a merge had omitted its journal entry.
   The repair restores that entry and the snapshot chain. Additive migration
   `0066_repair_scheduler_journal` also handles installations that already
   applied 0065 without 0064: it creates the missing scheduler table and
   records the replayed 0064 hash, preserving an existing scheduler turn.
   Deploy the repaired source through the normal migrate-and-verify gate.
   Do not erase applied hashes or disable verification to clear this error.

   **Build Variable flags — only the two TURSO_* variables need them.**
   Coolify injects an `ARG` statement into the Dockerfile for every env var
   with Build Variable ON (a misconfigured app logs hadolint
   `SecretsUsedInArgOrEnv` warnings for `ARG CRON_SECRET`, `ARG
   ENCRYPTION_KEY`, `ARG TURSO_AUTH_TOKEN` — those injected ARGs are exactly
   why the runtime secrets must be Runtime-only). Keep Build Variable ON only
   for `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`; every other secret
   (`CRON_SECRET`, `ENCRYPTION_KEY`, `GOOGLE_CLIENT_SECRET`, `OPENAI_API_KEY`,
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PROTON_SMTP_TOKEN`, …)
   should be **Runtime Variable only**, so they never travel as build args
   and no injected `ARG` block appears.

5. **Scheduled Task** (Scheduled Tasks → application): expression `* * * * *`,
   command `APP_URL=http://127.0.0.1:3000 node scripts/dev-cron.mjs --once`.
   One task replaces the Netlify Scheduled Function. Without pending feedback
   previews, N eligible live channels rotate about every N schedule intervals.
   When previews and live moderation are both ready, they alternate slots, so
   the live rotation is about 2N schedule intervals; neither class can monopolize
   ticks. See [cron workload fairness](cron-workload-fairness.md) for leases,
   retry expiry, and examples at different schedule intervals.
   The script exits
   non-zero (→ Coolify's task-failure notification) only for
   operator-actionable failures: configuration or transport errors,
   non-suppressed HTTP failures, invalid response bodies, failed sweeps or
   auxiliary jobs, `budgetExhausted`, a lost run-health write, or a channel
   error category the owner cannot fix. A non-OK response whose only channel
   failures are `credits` or `token`, with no operator problems, is suppressed.
   These channel-owner states —
   `credits` (top-up needed) and `token` (reconnect needed) — are persistent
   and already surfaced on the dashboard, so they log a warning and keep the
   task green instead of emailing once a minute until the owner acts.
   Optionally set **`HEALTHCHECK_PING_URL`** (Runtime Variable; healthchecks.io
   or a Uptime Kuma push monitor) — healthy and suppressed owner-actionable
   ticks attempt the ping; ticks that throw stay silent, so the monitor alerts
   on silence and also catches the task never running at all, which an exit
   code can't report.
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
  same production DB. Overlap requires every writer to run the same
  reservation-aware moderation version. The per-channel DB lease coordinates
  cron runs; it does not make older queue actions or reconciliation workers
  honor newer human-dispatch reservations.
- Retention sweeps (consent e-mails 10y, handles 30d) run inside the same
  endpoint and move to Coolify with it; `DRY_RUN` keeps both no-ops (I8).

## 8. Cutover & Netlify retirement (human-only, in order)

Each step has a verify gate; do not proceed past a failed gate.

For the first deployment of `human_dispatch_token` / `human_dispatch_state`,
pause both cron schedules and quiesce older moderation writers, including
manual queue/Undo requests and every app replica, before starting the new
version. Drain outstanding requests and investigate any unresolved remote
outcome. Apply and verify the additive migrations, start only reservation-aware
writers, and then resume scheduling. Both deployment targets must honor the
reservation before their schedules overlap. This is a human-operated cutover;
the additive database schema alone does not provide that runtime barrier.

Do not roll back to reservation-unaware code while a reservation exists.
Keep affected writers paused and investigate instead of clearing ownership
to permit a rollback. A paused dispatch can be released only with evidence
that its request never began or has settled; elapsed time and the current
YouTube comment state alone do not prove an earlier request cannot still land.
Record the evidence and reconcile the exact comment, intent, and dispatch
token with a guarded update so a newer owner cannot be overwritten. Production
record changes remain human-only.

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
   overlaps under the version barrier in §7 — or pause it from Netlify's Functions UI).
8. **Retire Netlify**: delete the Netlify site (stops its builds and
   Scheduled Function); optionally remove the Netlify redirect URIs from both
   Google clients. Leave `netlify.toml`, `netlify/`, and adapter-netlify in
   the repo — Netlify stays a supported target for anyone who wants it.

## 9. Open items / unverified details

- Exact current-UI location of Coolify **Scheduled Tasks** and the
  per-application webhook tab (research could not confirm; the features exist
  and are application-level — locate them in your Coolify version).
  **Verified 2026-08-18 against current Coolify docs** (llms-full.txt):
  application-level tasks exist and are scoped per application
  (`application_uuid` is included in `task_success`/`task_failed` webhook
  payloads; the API lists "Scheduled tasks on app/service") — only the exact
  dashboard tab location is undocumented, so locate it in your Coolify
  version at setup.
- **Alternative purge trigger** — **verified 2026-08-18 against current
  Coolify docs** (llms-full.txt): the Notifications → Webhook channel sends
  `deployment_success` events whose payload carries `fqdn`,
  `application_uuid`, `deployment_uuid`, and `deployment_url` — exactly what
  a purger needs. Kept as an alternative to the GitHub Actions workflow;
  the workflow (§3.5) remains primary because it needs no Coolify-side
  configuration and fires on the same push event that deploys.
- `X-Forwarded-Proto` behind Bunny was not verified; `ORIGIN` (§3.4) removes
  the dependency. **Verified 2026-08-18 against adapter-node source**: the
  built handler calls `parse_origin(env('ORIGIN', undefined))` at startup —
  a set `ORIGIN` is validated and used verbatim for URL generation, and an
  invalid value throws at boot (fail-loud). Confirm at gate 3 rather than
  assume.
- Turso embedded replicas on the Coolify server are a possible future
  optimization (persistent disk) — out of scope; do not paper over
  availability with silent fallbacks (DEPLOY.md §7).
