# Moderaty Umami Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution, or superpowers:subagent-driven-development if the user chooses that method. Follow the tasks and checkboxes below.

**Goal:** Replace GTM with self-hosted Umami for public-page traffic, approved campaign attribution and marketing clicks, preserving fork isolation and private-route protections.

**Architecture:** Keep the uncached runtime /api/analytics endpoint. A small browser client sends strictly constructed payloads directly to Umami POST /api/send; no external tracking script, SDK, proxy or new package is needed. The root Analytics component owns document eligibility, navigation and error presentation.

**Tech Stack:** Existing SvelteKit 2, Svelte 5, TypeScript, browser fetch and Vitest; separate Umami and PostgreSQL service in Coolify.

**Spec:** The Design section in this document. Intended repository location: docs/superpowers/plans/2026-10-05-umami-replacement.md.

**Scope decision:** The user selected public pages and marketing clicks. Completed signups, payments, account activity and channel connections are outside this change.

## Global Constraints

- Preserve disabled-by-default behavior. Unconfigured deployments and unchanged forks make zero requests to the official Umami collector.
- Runtime-only configuration; no PUBLIC_* variables, static env imports, build arguments, configured identifiers or collector origins in distributable artifacts.
- Client configuration contains public measurement settings only. No Umami password, administrative token or database credential reaches the browser.
- Use the five existing public routes: /, /pricing, /privacy, /terms and /dpa. Register future blog routes separately after verifying their public rendering and query behavior.
- No account/channel/comment data, explicit user identifiers, identify requests, replay, heatmaps, performance capture or advertising click IDs.
- No Moderaty database/schema changes. Umami has its own database and backup lifecycle.
- Use a cloud checkout and the repository's dev integration workflow. Re-read current AGENTS.md before execution; no production access, main push, agent merge or deployment.
- Do not modify existing Stryker or Fast Check tests. Run required repository checks before each commit.
- Use the repository's Node 24 and npm 11 toolchain.
- This document authorizes planning only; implementation and operator production actions are separate steps.

## Review Focus

1. Configuration returns after navigation to a private route: it must never activate collection.
2. URLs contain encoded credentials, duplicate UTMs or UTM values resembling identifiers: no such values may reach Umami or diagnostics.
3. A connect click immediately opens login: preserve navigation and allow its already-frozen public click request to complete.
4. A delayed collector response arrives after stop or opt-out: it cannot revive collection or restore the discarded cache.
5. A default fork or prerendered document receives copied official configuration: browser hostname checks must prevent official collection.

## Design

### Selected approach

Use Umami's documented collection API directly. Compared with inserting the stock tracker, this allows explicit payload control and observable delivery failures. Compared with a server proxy, it avoids another data-processing hop and IP/user-agent forwarding.

The reviewed Coolify template pins Umami 3.0.3. In that version, the stock tracker exposes manual tracking but swallows collection errors; the newer data-auto-pageview option documented by Umami requires 3.2. Direct /api/send calls avoid relying on that option. Confirm the actual deployed version before acceptance; upgrades remain a separate decision.

### Runtime configuration

Replace GTM_ID and GTM_ALLOWED_HOSTNAMES with the following settings:

| Variable | Default | Requirement |
| --- | --- | --- |
| ANALYTICS_ENABLED | false | Literal true enables deployment opt-in |
| UMAMI_URL | empty | Browser-reachable HTTPS origin, such as the proposed https://analytics.moderaty.com; no credentials, subpath, query or fragment |
| UMAMI_WEBSITE_ID | empty | A valid website UUID created in the operator's Umami instance |
| ANALYTICS_ALLOWED_HOSTNAMES | empty | Comma-separated exact DNS hostnames; no wildcard, scheme, port or path |

The example origin is a proposal, not a verified deployed service. Actual values remain in hosting settings. On Coolify, mark these Runtime Variables with Build Variable OFF. Remove obsolete GTM settings from examples and instructions; do not add a GTM fallback.

GET /api/analytics returns null when disabled or the claimed browser hostname is unlisted. Enabled, invalid configuration returns the existing generic 503. Valid configuration returns { umamiUrl, websiteId, hostname }. Limit hostnames to the collector's 100-character bound and validate DNS labels and UUIDs at both boundaries. Preserve the independently verified browser hostname, adapter-node pinned ORIGIN behavior, no-store responses and existing payload-free POST diagnostics.

### Payload and campaign rules

- Rebuild the page URL from the approved pathname, never forward location.href.
- Preserve only utm_source, utm_medium and utm_campaign with exact approved values. Drop duplicate UTM keys, unapproved values, every other parameter and all fragments.
- Initial approved source values: google, youtube, instagram, facebook, linkedin, newsletter.
- Initial approved medium values: organic, social, cpc, email, referral.
- Start the campaign list empty. Add the operator's actual, nonidentifying campaign slugs to an explicit source-controlled registry when campaigns are defined. Never accept arbitrary campaign text based only on a slug regex.
- A query key matching code, state, token, access_token, refresh_token, id_token, email, invite, session, password, reset or verification, case-insensitively after URL parsing, makes the entire page ineligible.
- Other unknown query keys are discarded while the public page may still be measured. This intentionally replaces GTM's blanket query-string exclusion.
- Use fixed page titles: Home, Pricing, Privacy, Terms and DPA. Do not read arbitrary DOM text into analytics.
- External referrers become HTTP(S) origins only; discard path, query, fragment and credentials. Same-origin public referrers contribute an empty referrer. Preserve suppression when the same-origin referrer identifies an excluded or credential-bearing page.
- Send only website, hostname, sanitized url, fixed title, sanitized referrer and, for clicks, the approved name and placement. Omit screen dimensions, language, timestamps and all caller-supplied identity fields.

Umami still processes the visitor's network IP and browser user agent and derives session/visit information. Limited payloads and no cookies do not establish that the entire processing operation is outside LGPD.

### Events

Use static data-moderaty-event and data-moderaty-placement attributes on approved links. Analytics.svelte listens for click and middle-button auxclick, validates the exact event/placement pair and calls the client. It never records href, visible text, form values or arbitrary attributes.

| Event | Allowed placements |
| --- | --- |
| connect_click | nav, nav_mobile, hero, final_cta, plan_hosted, plan_lifetime |
| pricing_click | nav, nav_mobile, home_pricing, footer |
| source_click | nav, nav_mobile, footer, plan_self_hosted |
| contact_click | footer, pricing_contact |

connect_click means a click on the public CTA, not a completed signup or YouTube connection. Shared plan components use the same markers wherever rendered; the sanitized page URL distinguishes home from pricing.

### Browser lifecycle and preferences

One AnalyticsClient belongs to each document. Send one initial pageview and one per committed change of the sanitized public URL. Ignore hash-only navigation and duplicate effect calls; count Back between different eligible public URLs.

A document beginning on or visiting an excluded route remains ineligible for its lifetime. Abort pending configuration when navigation becomes private. Remove GTM-specific forced document reloads because this design installs no external script or history hook.

Already-started requests contain immutable safe public payloads and may finish. Do not attach a route-effect cancellation signal to a click keepalive request: doing so loses the click that navigates to login. Never await analytics before allowing a link to navigate.

DNT, GPC or a stored opt-out prevents collection. Store only moderaty.analytics.optOut=1 when opted out; never persist the Umami cache or visitor identifiers. Provide an accessible Audience measurement control in the public footer, with its explanation on the Privacy page. Storage failures fail closed and display a generic preference/measurement error. React to cross-tab preference changes. Opt-in may reload the public document to restart safely; it must not enable a private document.

### Transport and errors

Send { type: 'event', payload } to new URL('/api/send', umamiUrl) with credentials omitted, no-referrer policy and keepalive enabled. Use the browser's normal User-Agent rather than attempting to set that forbidden header.

Check HTTP status and JSON shape. A normal 3.0.3 response contains a cache token; keep only a nonempty string of at most 4096 characters in memory and send it as x-umami-cache on subsequent requests. Ignore sessionId, visitId and other response fields. The successful bot-suppression response { beep: 'boop' } is an intentional skip. Other malformed success responses are failures.

Clear cache on stop, opt-out and config changes. Delayed responses may not repopulate a stopped client. Compose request deadlines with caller cancellation; allow already-started click requests their own bounded lifetime.

Retain loud, generic browser failures, the existing optional-measurement status on eligible public pages, and payload-free rate-coalesced server diagnostics. Never log raw collector responses, tokens or request payloads. Do not retry automatically because a failed response can follow a successfully stored event.

## Task 1: Define the public measurement policy

**Create:** src/lib/analytics-policy.ts; src/lib/analytics-policy.test.ts.

**Interfaces produced:**
- MarketingEvent and MarketingPlacement string unions matching the table above.
- AnalyticsConfig = { umamiUrl: string; websiteId: string; hostname: string }.
- PagePayload = { website: string; hostname: string; url: string; title: string; referrer: string }.
- isAnalyticsPage(url: URL): boolean.
- buildPagePayload(url: URL, referrer: string, config: AnalyticsConfig): PagePayload | null.
- parseMarketingClick(name: string | null, placement: string | null): { name: MarketingEvent; placement: MarketingPlacement } | null.

- [x] Add failing tests: public path allowlist, sensitive query-key casing/encoding, approved versus arbitrary UTMs, duplicate UTM removal, fragment removal, fixed titles, external-origin referrers, private same-origin referrer suppression, and exact event/placement pairs. Assert complete returned payloads and rejected cases, rather than source-text matches.
- [x] Run npm run test -- src/lib/analytics-policy.test.ts and confirm the tests fail for absent behavior.
- [x] Implement the interfaces and exact registry/rules above without new packages.
- [x] Re-run the targeted tests, then npm run check, npm run build and npm run test. Confirm all pass.
- [x] Commit as step 1: define public Umami payload policy.

## Task 2: Replace the runtime integration atomically

**Modify:** src/lib/analytics.ts; src/lib/analytics.test.ts; src/lib/components/Analytics.svelte; src/lib/components/Analytics.test.ts; src/routes/api/analytics/+server.ts; src/routes/api/analytics/analytics.test.ts; .env.example; README.md; docs/ANALYTICS.md; docs/COOLIFY_BUNNY.md.

**Interfaces consumed:** Task 1 types and policy functions.

**Interfaces produced:**
- createAnalyticsClient(options: { onFailure: () => void }): AnalyticsClient.
- AnalyticsClient.pageview(url: URL, signal?: AbortSignal): Promise<'sent' | 'skipped'>.
- AnalyticsClient.click(event: MarketingEvent, placement: MarketingPlacement): Promise<'sent' | 'skipped'>.
- AnalyticsClient.stop(): void.
- The runtime configuration response described in Design.

- [x] Replace GTM-specific tests with failing assertions for the complete Umami config/transport/lifecycle contract. Retain disabled/fork, pinned ORIGIN, cache-control, cancellation and generic diagnostic tests.
- [x] Add regression tests for all five Review Focus conditions. Also assert exactly one initial pageview, one public SPA pageview per changed canonical URL, no hash-only duplicate, no private-history reactivation, no tracking globals/scripts, bounded cache reuse, successful bot suppression, malformed/failed responses and no automatic retry.
- [x] Run npm run test -- src/lib/analytics.test.ts src/lib/components/Analytics.test.ts src/routes/api/analytics/analytics.test.ts; confirm the new assertions fail.
- [x] Change server and client together so the new response shape never leaves a committed dev version with a mismatched loader. Remove GTM script/dataLayer logic and forced navigation; retain the lifetime safety latch.
- [x] Rework runtime examples and the analytics runbook around the new settings, limitations and same-artifact runtime checks. Keep all example measurement values empty or synthetic.
- [x] Re-run targeted tests, then npm run check, npm run build and npm run test. Confirm all pass.
- [x] Commit as step 2: replace GTM with guarded Umami collection.

## Task 3: Instrument public CTAs and add visitor control

**Modify:** src/lib/components/Analytics.svelte and its tests; src/lib/analytics.ts and its tests; src/lib/components/landing/{Nav,Hero,FinalCta,Pricing,Footer,PlanHosted,PlanLifetime,PlanSelfHosted}.svelte; src/lib/components/landing/pricing/PricingPlans.svelte.

**Create:** src/lib/components/AnalyticsPreference.svelte; src/lib/components/AnalyticsPreference.test.ts.

**Interfaces produced:**
- getAnalyticsOptOut(): boolean.
- setAnalyticsOptOut(disabled: boolean): void.
- Static link markers using the exact event/placement table.
- AnalyticsPreference embedded in Footer; no account preference storage.

- [x] Add failing tests: static event payloads contain only approved placement; nested target, keyboard, modifier and middle clicks behave correctly; no handler prevents navigation or waits for the network.
- [x] Assert DNT, GPC and stored opt-out create zero collector requests. Assert preference storage failure remains disabled, cross-tab opt-out stops future requests, and late responses cannot restore cache.
- [x] Run npm run test -- src/lib/analytics.test.ts src/lib/components/Analytics.test.ts src/lib/components/AnalyticsPreference.test.ts and confirm failure.
- [x] Implement delegation in the owning Analytics component and add static markers to the listed links. Add the accessible preference control; keep arbitrary DOM/text/URLs outside event data.
- [x] Re-run targeted tests, then npm run check, npm run build and npm run test. Confirm all pass.
- [x] Commit as step 3: add public marketing events and measurement preference.

## Task 4: Update disclosures and prepare the operator rollout

**Modify:** src/lib/components/landing/legal/Privacy.svelte; src/lib/landing/legal.ts; src/lib/landing/legal.test.ts; docs/ANALYTICS.md; docs/COOLIFY_BUNNY.md.

**Add operator assessment:** docs/privacy/2026-10-05-umami-audience-measurement.md.

- [x] Add a behavior/content regression for accurate audience-measurement disclosure and the working opt-out explanation. Run npm run test -- src/lib/landing/legal.test.ts src/lib/components/AnalyticsPreference.test.ts before editing copy and confirm the new assertions fail.
- [x] Update Privacy sections 1, 2, 9 and 12 to cover visitors, purpose, data flow, lawful basis, hosting/sharing, retention and rights. Describe IP/UA processing and pseudonymous session derivation accurately; do not claim guaranteed anonymity or automatic LGPD compliance.
- [x] Advance legal version 1.18 to 1.19 if still current, following the existing legal-version and renewed-acceptance mechanism. Set the effective date to the actual approved publication schedule, not an invented date.
- [x] Preserve the existing Privacy section 13 promise of 30 days' advance notice, including its user notification commitments. Operator activation must occur after the notice period; do not silently remove the promise or enable measurement during it.
- [x] Prepare an assessment template with the defined purpose, necessity, balancing factors and safeguards. Mark the operator's legal-basis decision as awaiting completion; never publish a statement that the assessment is finished when it is not.
- [x] Document the deployment and acceptance checklist below, including retention as an activation prerequisite.
- [x] Run relevant legal/analytics tests, npm run check, npm run build and npm run test. Confirm all pass, then commit as step 4: document Umami privacy and activation requirements.

## Implementation verification — 5 October 2026

Implemented on `feat/umami-gtm` at the user's request. The user confirmed there
are no existing users and no required publication schedule; version 1.19 uses
5 October 2026 while preserving section 13's future notice commitment.

The final suite passes 194 files / 3,745 tests, with zero Svelte/TypeScript errors
or warnings. Both Netlify and Node builds pass. Synthetic runtime origins and
UUIDs are absent from deployment/client artifacts. Chromium checks one unchanged
Node build under multiple runtime configurations with all external requests
intercepted. A review found and reproduced a pending-pageview loss on equivalent
URL navigation; canonical effect dependencies fix it, with browser regressions
for hash, discarded-query and reordered-UTM changes. Follow-up independent review
found no remaining material issues.

Operator deployment, actual collector delivery/CORS/dashboard/purge verification,
publication, production activation and pushing remain pending. Local browser
regression instructions are in `docs/ANALYTICS.md`.

## Operator deployment and acceptance checklist

These are reviewable handoff steps. No server access, configuration mutation, production database work or message sending was performed to create this plan.

- [ ] Confirm the Umami service is healthy, its actual version is recorded, and it has its own PostgreSQL volume. Change the default admin password, keep a unique APP_SECRET, use HTTPS and restrict dashboard access.
- [ ] Disable optional Umami project telemetry with DISABLE_TELEMETRY=1 and external dashboard calls with PRIVATE_MODE=1, confirming support in the deployed version.
- [ ] Create separate production and staging website records. Put their actual URLs, UUIDs and exact hostnames in each Moderaty environment's runtime settings; keep production ANALYTICS_ENABLED=false.
- [ ] Complete the legitimate-interest assessment for the defined limited purpose. If that basis does not hold, keep collection disabled and design consent gating before activation.
- [ ] Record hosting, proxy/CDN and backup providers/countries and the applicable international-transfer mechanism. Review their logs as well as the analytics database.
- [ ] Establish and verify a version-tested purge process for 90-day detailed analytics and 7-day backup expiry, confined to the Umami database. These are proposed operational limits, not LGPD deadlines. Disclose any backup deletion lag accurately. Self-hosted Umami does not automatically impose these limits.
- [ ] Publish the updated disclosure and required advance notices, with activation no earlier than the applicable effective date and 30-day notice period.
- [ ] On staging, test browser CORS preflight and collection through the actual Coolify proxy. Verify any deployed CSP permits only the intended collector origin; do not solve a restriction by broadly allowing unrelated hosts.
- [ ] Inspect requests for a synthetic approved campaign, then test private routes, credential-bearing queries, copied config on another hostname, DNT/GPC and opt-out. Confirm only the approved payload reaches Umami and counts appear in its dashboard.
- [ ] Verify no Google analytics requests, tracking scripts, configured website UUIDs or collector origins appear in prerendered HTML/client build artifacts. Test runtime switching using the same built artifact.
- [ ] Verify both supported builds once before release: npm run build for Netlify and MODERATY_ADAPTER=node npm run build for adapter-node, using isolated development inputs only.
- [ ] Follow the human-reviewed dev-to-main release process with analytics still disabled. The operator enables collection only after all readiness conditions pass and verifies the production network and counts.

**Rollback:** Set ANALYTICS_ENABLED=false in the runtime environment and restart/redeploy the instance; existing documents require reload or opt-out to stop their already-initialized client. Keep the isolated Umami data under its retention policy. Do not reactivate GTM automatically. A code rollback is separate from the immediate measurement-disable switch.

**Historical data:** Start a new Umami measurement baseline at activation. GTM is a tag manager; inspect any downstream analytics separately if historical reports are needed. No GA/GTM history import or advertising conversion replacement is included.

## Sources and dates

The repository baseline was read from main commit 092db9d8b6a6ee87e7f3a7c653a75cc179afda4f, merged on 2026-10-05. All external references below are first-party. Current technical documentation is undated, so retrieval today does not prove publication within six months. Version-specific 3.0.3 source remains relevant because the reviewed Coolify template pins that version. The older ANPD guides remain relevant because they set out the lawful-basis assessment and safeguards applied here; no six-month freshness claim is made for them.

- [Moderaty analytics implementation and protections](https://github.com/Bonobo791/Moderaty/blob/092db9d8b6a6ee87e7f3a7c653a75cc179afda4f/docs/ANALYTICS.md)
- [Repository execution and legal-version rules](https://github.com/Bonobo791/Moderaty/blob/092db9d8b6a6ee87e7f3a7c653a75cc179afda4f/AGENTS.md)
- [Current Privacy implementation, including section 13 notice commitment](https://github.com/Bonobo791/Moderaty/blob/092db9d8b6a6ee87e7f3a7c653a75cc179afda4f/src/lib/components/landing/legal/Privacy.svelte)
- [Coolify Umami template](https://github.com/coollabsio/coolify/blob/main/templates/compose/umami.yaml)
- [Umami collection API](https://docs.umami.is/docs/api/sending-stats)
- [Umami 3.0.3 collection implementation](https://github.com/umami-software/umami/blob/v3.0.3/src/app/api/send/route.ts)
- [Umami 3.0.3 tracker implementation](https://github.com/umami-software/umami/blob/v3.0.3/src/tracker/index.js)
- [Umami 3.0.3 CORS configuration](https://github.com/umami-software/umami/blob/v3.0.3/next.config.ts)
- [Umami configuration and version requirements](https://docs.umami.is/docs/environment-variables)
- [Umami self-hosted retention FAQ](https://docs.umami.is/docs/faq)
- [Coolify deployment guide](https://coolify.io/docs/deploy-your-first-service)
- [ANPD legitimate-interest guide, 2024](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/copy_of_guia_legitimo_interesse.pdf/@@display-file/file)
- [ANPD cookies and tracking guide, 2022](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-orientativo-cookies-e-protecao-de-dados-pessoais.pdf/@@display-file/file)
- [ANPD current international-transfer guidance](https://www.gov.br/anpd/pt-br/assuntos/assuntos-internacionais/transferencia-internacional-de-dados)
