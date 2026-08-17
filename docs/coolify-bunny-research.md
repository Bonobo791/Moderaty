# Coolify + Bunny CDN — Deployment & Cache-Purge Research

Date: 2026-08-17 · Sources: coolify.io/docs (current docs), docs.bunny.net / bunny.net/docs, coollabsio/coolify GitHub, Bunny core-API OpenAPI spec.
All claims verified against the cited pages; anything not verifiable is marked UNVERIFIED.

---

## 1. Coolify — Git auto-deploy ("push to deploy")

**Yes.** With a GitHub App connected, Coolify redeploys on every push to the configured branch.

- Docs: "Automatically deploy new versions of your application when commits are pushed to a **specific branch**" — https://coolify.io/docs/applications/ci-cd/github/overview ; https://coolify.io/docs/applications/ci-cd/github/auto-deploy
- **Setting that controls it:** Application → **Advanced** → "Auto Deploy" toggle ("Enabled by default", and "only available for GitHub App based repositories"): https://coolify.io/docs/applications#auto-deploy . "Coolify automatically enables Auto Deploy after you set up your GitHub App. If it doesn't, enable it on your application": https://coolify.io/docs/applications/ci-cd/github/auto-deploy#github-app
- **Branch:** set when creating the resource (build-pack step: "Branch: Coolify will automatically detect the branch in your repository", editable): https://coolify.io/docs/applications/build-packs/dockerfile (step 5).
- **Webhooks vs GitHub App:** two different trigger mechanisms.
  - *GitHub App* (recommended): no repo-level webhook needed. During App setup Coolify registers a **webhook endpoint** for the App itself (`https://<your-coolify>/webhooks/source/github/events`, push + pull_request events, App webhook secret); "Select the endpoint for github to send Webhook when a event (commit, pr) happens on github. **If this endpoint is not reachable then automatic deployments won't work**": https://coolify.io/docs/applications/ci-cd/github/setup-app ("Set Webhook Endpoint", "Subscribe to events → Push"). The CI/CD page calls GitHub-App integration "Full integration with automatic webhooks": https://coolify.io/docs/applications/ci-cd
  - *Coolify-generated webhook URL (per git source)*: alternative for repos **without** the GitHub App (public repo / deploy key). Enable Auto Deploy, copy Coolify's webhook URL + secret, add it on the GitHub repo (Settings → Webhooks: Payload URL, Secret, "Just the push event", SSL verification on): https://coolify.io/docs/applications/ci-cd/github/auto-deploy#webhooks . With a GitHub App install you do **not** use this per-repo URL.

## 2. Coolify — Dockerfile build pack passes env vars as build ARGs

**Yes, confirmed explicitly.**

- "Coolify automatically injects build arguments into your Dockerfile during the build process. These include environment variables you've configured and predefined system values like SOURCE_COMMIT. … **By default, Coolify injects Docker build arguments (ARG statements) into your Dockerfile**" (can be disabled in the Advanced menu): https://coolify.io/docs/applications/build-packs/dockerfile#build-arguments
- "Build variables are injected during the image build process. **For Dockerfile deployments, they are added as ARG instructions.**" Every env var has independent **Build Variable** and **Runtime Variable** flags, both **on by default**; build vars are passed as `--build-arg KEY=value` (optionally via Docker BuildKit secrets `--secret id=KEY,env=KEY` if "Use Docker Build Secrets" is enabled): https://coolify.io/docs/knowledge-base/environment-variables
- **So `ARG TURSO_DATABASE_URL` + using it in a `RUN` step works**, as long as the variable exists in the app's Environment Variables and its "Build Variable" flag is on (default). Caveat: `SOURCE_COMMIT` is **excluded** from builds by default (cache preservation; enable "Include Source Commit in Build").

## 3. Coolify — Post Deployment Command

**Confirmed.**

- "Pre-deployment: Optionally, specify a script or command to execute **in the existing container before deployment**… Post-deployment: Optionally, specify a script or command to execute **in the newly built container after deployment completes**. This command is also executed with `sh -c`.": https://coolify.io/docs/applications/build-packs/dockerfile#prepost-deployment-commands
- **Where in UI:** "You can configure these settings in the **Advanced menu of your application**" (same page). UNVERIFIED: the exact tab label in the current UI ("Advanced" per the same page) — screenshots not published.
- **Caveats:** runs via `sh -c` inside the container (non-interactive; no TTY). This is where a Bunny purge curl can be hooked, but note it fires *inside the app container* and runs once per successful deployment.

## 4. Coolify — Scheduled Tasks (cron)

**Exist and are application-level**, though the current docs have no dedicated setup page (sitemap has none → UI path UNVERIFIED).

- Cron engine documented: standard `* * * * *` plus predefined strings (`daily`, `@daily`, `hourly`, …): https://coolify.io/docs/knowledge-base/cron-syntax
- Scheduled-task events + payloads (`task_success` / `task_failed` with `task_name`, `task_uuid`, `output`, and "**application_uuid** … included for application-level tasks"): https://coolify.io/docs/knowledge-base/webhook-payloads#scheduled-tasks
- Notifications support "Scheduled Task Success / Failure" events: https://coolify.io/docs/knowledge-base/notifications#scheduled-tasks
- UNVERIFIED by current docs: (a) the exact UI location (older versions: application settings → Scheduled Tasks); (b) the explicit statement that the command runs **inside the app container** — strongly implied (application-level tasks with captured `output`), but not stated on the pages above.

## 5. Coolify — outgoing webhooks (deployment lifecycle events)

**Exists, but the model changed vs the assumption:**

- Current docs describe a unified **Notifications** system ("Notifications tab of your Coolify dashboard"), with a **Webhook** channel (Notifications → Webhook → enter URL → enable): https://coolify.io/docs/knowledge-base/notifications#webhook
- **Events (current naming):** `deployment_success`, `deployment_failed`, `status_changed` for applications, plus `backup_*`, `task_*`, server/container events. **NOT `deployment.success`/`deployment.failure`** (dot notation was the old naming) — https://coolify.io/docs/knowledge-base/webhook-payloads#application
- **Payload shape:** all events are HTTP POST, `Content-Type: application/json`, minimum fields `success`, `event`, `message`; deployment events add `application_name`, `application_uuid`, `deployment_uuid`, `deployment_url`, `project`, `environment`, `fqdn` (PR previews: `pull_request_id`, `preview_fqdn`).
- Events are selectable per notification channel ("configure different events for each notification channel").
- **Per-application "Webhooks" tab:** UNVERIFIED — no current docs page describes per-application webhook config; only the global Notifications tab is documented. (Older Coolify had a per-app webhook URL/secret; do not rely on it without checking your version's UI.)
- **Use the `deployment_success` event to trigger the Bunny purge** (see §7).

## 6. Bunny CDN — Pull Zone basics & Host header

- **Origin URL → app:** create Pull Zone with origin type "Origin URL" pointing at the app: https://bunny.net/docs/cdn/quickstart
- **Default hostname:** `<pull-zone-name>.b-cdn.net` (name: letters/numbers only): quickstart + https://bunny.net/docs/domains ("Each pull zone you create gets a hostname on the b-cdn.net domain").
- **Custom domain:** add hostname in the zone's General → Hostnames, then a **CNAME from your domain to `<name>.b-cdn.net`** (e.g. `cdn` → `yourzone.b-cdn.net`); apex domains unsupported via CNAME (use Bunny DNS flattening or www redirect): https://bunny.net/docs/cdn/custom-hostname
- **Host header default — important correction:** the edge does **not** forward the client's original Host by default. Docs: "Host header (optional): The host HTTP header sent to the origin. **If left empty, the hostname is automatically extracted from your Origin URL.**": https://bunny.net/docs/cdn/quickstart (Origin URL tab). To forward the *requested* host header there is a zone flag `AddHostHeader` = "Determines if the zone should forward the requested host header to the origin": https://bunny.net/docs/api-reference/core/pull-zone/add-pull-zone (OpenAPI schema). Its default value is not stated in docs (UNVERIFIED; historically off). SvelteKit care: set `OriginHostHeader` / `AddHostHeader` (or a "Set Request Header" edge rule) if the app depends on the public Host.

## 7. Bunny CDN — Purge API

**The assumed endpoint is correct and still documented:**

- `POST https://api.bunny.net/purge?url=<url-encoded-pattern>&async=true`
  - Header: `AccessKey: <account API key>`
  - Query: `url` (required; supports `*` wildcards — "Prefix (Wildcard) Purge: The URL contains a `*`, or the path ends with `*` or `/`"), `async` (bool, default **false** = "wait for the purge logic to complete"), `exactPath` (bool, default false). Response 200.
  - Docs: https://docs.bunny.net/api-reference/core/purge/purge-url (also in OpenAPI: `post /purge`, operationId `PurgePublic_IndexPost`).
  - Whole site, e.g.: `curl -X POST 'https://api.bunny.net/purge?url=https%3A%2F%2Fwww.example.com%2F*&async=true' -H 'AccessKey: YOUR_KEY'`
- **Newer per-zone endpoint (also documented):** `POST https://api.bunny.net/pullzone/{id}/purgeCache` (no body = purge whole zone; `{"CacheTag":"..."}` = purge by `CDN-Tag`): https://docs.bunny.net/api-reference/core/pull-zone/purge-cache ; guide: https://bunny.net/docs/cdn/purge-cache
- **Rate limits:** token bucket, per account & per purge type — Exact purge ≈ 120 burst / 5/s refill; Prefix (wildcard) purge ≈ 20 burst / 0.5/s refill → **~30 wildcard purges/minute sustained**; 429 on excess: https://bunny.net/docs/cdn/purge-cache#rate-limits
- **API key:** docs only document a single **account-level** API key (dash.bunny.net → Account → API Key), sent via `AccessKey`; "Your API key has full access to your account": https://bunny.net/docs/account/api-keys . **Per-pull-zone API keys for purge: not documented** (a zone's "Token Key" is for token auth, not the API). OpenAPI lists an "API Keys" tag (`ApiKeyModel {Id, Key, Roles}`) hinting at key management, but no scoped-key docs exist → use the account key. UNVERIFIED: whether scoped keys can purge.

## 8. Bunny CDN — caching strategy for SvelteKit

- **Origin Cache-Control is honored by default:** "By default, Bunny caches all responses from your origin that include cacheable headers like `Cache-Control` or `Expires`" and "Bunny follows the origin's `Cache-Control` header to decide whether and how long to cache": https://bunny.net/docs/cdn/smart-cache . adapter-node already sends `Cache-Control: public, max-age=31536000, immutable` for `/_app/immutable/*` and `no-cache` for HTML, so defaults are mostly right.
- **Smart Cache (optional):** only caches known static extensions (js, css, woff2, images…) and **never caches `text/html`, `application/json`, `application/xml`**; enabled by default for zones accelerated by Bunny DNS: https://bunny.net/docs/cdn/smart-cache
- **Edge Rules for explicit control:**
  - Actions include **Override Cache Time** (edge TTL) and **Override Browser Cache Time** (browser `Cache-Control`); cache time `0` = bypass edge cache: https://bunny.net/docs/cdn/edge-rules/index ; https://bunny.net/docs/cdn/edge-rules/custom-cache-time
  - Trigger/pattern syntax (wildcards): `/_app/immutable/*`, `*.js`, `*://example.com/*`; query strings are not matched; scheme matters: https://bunny.net/docs/cdn/edge-rules/trigger-path
  - API: `POST /pullzone/{pullZoneId}/edgerules/addOrUpdate` — ActionType 3 = OverrideCacheTime, 16 = OverrideBrowserCacheTime; `Triggers[].PatternMatches`, `TriggerMatchingType` (MatchAny=0/MatchAll=1/MatchNone=2): https://docs.bunny.net/api-reference/core/pull-zone/addupdate-edge-rule
- **Recommended recipe (documented building blocks, no SvelteKit-specific example exists in docs):**
  1. Rule: Request URL matches `/_app/immutable/*` → **Override Cache Time = 31536000** (1 year; hashed/immutable).
  2. Leave HTML/API to origin headers (SvelteKit sends `no-cache`) and/or rule: `*/api/*` + `*.html` → Override Cache Time = `0` (bypass). If Smart Cache is off, `text/html`/JSON would otherwise be cacheable only per origin `Cache-Control`.
- **Why purge after deploy:** "Bunny CDN does not monitor your origin for file changes. Once a file is cached, it stays cached until its `Cache-Control` lifetime expires… To reflect a change immediately, purge the cache": https://bunny.net/docs/cdn/purge-cache — immutable hashes mean stale `/_app/immutable/*` entries are harmless; the purge (or `?v=` busting) matters for HTML and non-hashed paths.

---

## Suggested wiring (per findings)

1. Coolify: GitHub App source → branch auto-detect/select, Auto Deploy on (default). Webhook endpoint of the GitHub App must be reachable.
2. Dockerfile build pack with `ARG TURSO_DATABASE_URL` — works (Build Variable flag default on).
3. Coolify Notifications → Webhook channel → your endpoint → events "Deployment Success" (payload `event: "deployment_success"`).
4. On `deployment_success`, call `POST https://api.bunny.net/purge?url=https%3A%2F%2F<your-domain>%2F*&async=true` with account `AccessKey` (mind ~30 wildcard purges/min; alternatively full-zone `POST /pullzone/{id}/purgeCache`).
5. Bunny pull zone: Origin URL = Coolify app FQDN; set Host header explicitly if needed (default = hostname from Origin URL); CNAME your domain to `<name>.b-cdn.net`.
