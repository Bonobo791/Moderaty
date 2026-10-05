# Optional Umami audience measurement

Measurement is disabled by default. Unconfigured deployments and unchanged forks
make **zero requests to the official collector**. This integration replaces GTM;
it loads no third-party script, tracking SDK, iframe or tracking global. It sends
restricted public-page payloads directly to a self-hosted Umami collection API.
No Moderaty database migration or new product package is required.

## Runtime configuration

| Setting | Default | Enabled deployment requirement |
| --- | --- | --- |
| `ANALYTICS_ENABLED` | `false` / unset | Literal `true` opts in |
| `UMAMI_URL` | empty | Browser-reachable HTTPS origin; no credentials, subpath, query or fragment |
| `UMAMI_WEBSITE_ID` | empty | Website UUID created in your own Umami instance |
| `ANALYTICS_ALLOWED_HOSTNAMES` | empty | Comma-separated exact DNS browser hostnames, at most 100 characters each |

Hostnames are trimmed and lowercased in operator configuration. They contain no
scheme, port, path, trailing dot or wildcard; subdomains require separate entries.
Use separate staging and production website records. Real origins and UUIDs
belong exclusively in hosting runtime settings, with **Build Variable OFF** in
Coolify. Netlify uses the Functions environment scope. Never use `PUBLIC_*`,
static environment imports, Docker `ARG`/`ENV` or Vite substitutions. Remove old
GTM settings from hosting; there is no GTM fallback. Public measurement settings
are visible to enabled-site visitors; no Umami password, admin token, APP_SECRET
or database credential is returned to a browser.

`GET /api/analytics` reads private runtime settings on every request and returns
`null` when disabled or when the browser hostname claim is not exactly allowed.
Invalid enabled settings return a generic 503 and a bounded server diagnostic.
Every response is `Cache-Control: no-store`; the endpoint is never prerendered
and bypasses session/database checks. Keep the existing CDN `/api/*` cache bypass.
Browser claims support configured aliases even when adapter-node pins `ORIGIN`.
The browser independently validates settings and its actual hostname before
collection, so copied configuration cannot activate a fork.

## Data and lifecycle

Only `/`, `/pricing`, `/privacy`, `/terms` and `/dpa` are eligible. A parsed query
key matching `code`, `state`, `token`, `access_token`, `refresh_token`, `id_token`,
`email`, `invite`, `session`, `password`, `reset` or `verification`, ignoring case,
excludes the entire page. Other unknown keys are dropped. Rebuilt relative page
URLs contain no fragments, advertising click IDs, arbitrary query values or
credentials. Fixed titles are Home, Pricing, Privacy, Terms and DPA.

Only exact reviewed values survive campaign filtering:

- `utm_source`: google, youtube, instagram, facebook, linkedin, newsletter.
- `utm_medium`: organic, social, cpc, email, referral.
- `utm_campaign`: initially none. Add actual nonidentifying campaign slugs to
  `APPROVED_CAMPAIGNS` in `src/lib/analytics-policy.ts` after review.

Duplicate UTM keys are removed entirely. External HTTP(S) referrers contribute
only their origin, discarding credentials, path, query and fragment. Safe
same-origin referrers contribute an empty string. A private or credential-bearing
same-origin referrer suppresses the document. Future blog routes require separate
public-route and query-policy review.

One client belongs to each document. It sends one initial pageview and one per
committed change of the canonical public URL, including Back between distinct
public URLs. Hash-only changes, discarded query changes and duplicate effects do
not create pageviews. A document beginning on or visiting an excluded route is
permanently ineligible. Private navigation cancels pending configuration, stops
future collection and discards cache; normal navigation proceeds without the old
GTM forced reload. Requests already started contain immutable safe public data
and may finish. Click requests have their own bounded lifetime, independent of
route-effect cancellation, so a connection CTA can still navigate to login.

| Event | Allowed placements |
| --- | --- |
| `connect_click` | nav, nav_mobile, hero, final_cta, plan_hosted, plan_lifetime |
| `pricing_click` | nav, nav_mobile, home_pricing, footer |
| `source_click` | nav, nav_mobile, footer, plan_self_hosted |
| `contact_click` | footer, pricing_contact |

Static approved link attributes provide these values. Click and middle-button
auxclick handling records neither destinations, visible text, form inputs nor
arbitrary attributes. `connect_click` is a public CTA click, **not a completed
signup or YouTube connection**. Signups, payments, accounts and channel activity
remain outside measurement.

Page payloads contain only website UUID, approved hostname, rebuilt URL, fixed
title and sanitized referrer. Clicks add the approved name and
`data: { placement }`. There are no explicit visitor identifiers, identify calls,
comment/channel content, timestamps, screen sizes, language, replay, heatmaps,
performance capture or advertising conversion tracking.

## Preferences and transport

DNT, GPC or a stored opt-out suppresses collection. The public footer's accessible
**Audience measurement** control stores only `moderaty.analytics.optOut=1` on
opt-out; opting in removes that key and may reload the public document. No visitor
identifier or Umami cache is persisted. Storage failures fail closed with a
generic visible error; cross-tab opt-out stops the document client. A private
document cannot become eligible by opting in.

Requests are `{ type: 'event', payload }` sent to `new URL('/api/send', UMAMI_URL)`
with credentials omitted, `no-referrer`, keepalive and a five-second deadline.
Caller cancellation is composed with deadlines; click sends use their own
deadline. The normal browser User-Agent is used. Successful responses provide a
nonempty cache string of at most 4096 characters, retained only in memory and
passed as `x-umami-cache`. SessionId, visitId and other response fields are ignored.
The Umami 3.0.3 bot response `{ beep: 'boop' }` is an intentional skip.
Cache is discarded on stop, opt-out and configuration changes. Late responses
cannot restore a discarded cache. Failed/malformed responses show a generic
measurement status on eligible public pages and log generic browser errors.
There is no automatic retry: an event might have been saved before delivery failed.

Payload-free, credential-free and referrer-free POST diagnostics use the same
local endpoint and exact runtime/hostname gates. They contain no error text,
URLs, cache tokens or account information. Reports are shared per document and
server logs coalesced to one per minute per worker with constant memory. Failure
to deliver a diagnostic is logged generically without hiding the original failure.

## Operator activation checklist

These are human handoff steps, not actions performed by implementing this code.
Keep production `ANALYTICS_ENABLED=false` until all prerequisites pass.

- Confirm service health and record the **actual deployed Umami version**. The
  reviewed Coolify template pins 3.0.3; this transport follows that version's API.
  Upgrades are a separate operator decision. Use a separate PostgreSQL volume,
  unique APP_SECRET, HTTPS, a changed default admin password and restricted
  dashboard access.
- Set `DISABLE_TELEMETRY=1` and `PRIVATE_MODE=1`; confirm those flags are supported
  by the deployed version. Create separate staging/production website records.
- Complete the [audience measurement assessment](privacy/2026-10-05-umami-audience-measurement.md).
  The legitimate-interest decision is **awaiting operator completion**. If that
  basis is unsuitable, keep measurement disabled and implement visitor consent
  gating before activation. Deployment opt-in is not visitor consent.
- Record hosting, proxy/CDN and backup providers/countries and the applicable
  international-transfer mechanism. Review their access logs independently.
- Establish and verify a version-tested purge confined to the **Umami database**:
  proposed detailed-data retention is 90 days and backup expiry is 7 days. These
  are operational limits, not LGPD deadlines; self-hosted Umami does not impose
  them automatically. Verify actual deletion and disclose backup deletion lag.
- Publish the approved disclosure and required notices. Privacy §13's promise of
  30 days' advance notice, including prominent service notice and e-mail, remains.
  Activation must follow any applicable effective date and notice period.
- Verify real CORS preflight through the Coolify proxy, including JSON and
  `x-umami-cache`. Any deployed CSP must allow only the intended collector origin
  in `connect-src`; never broadly permit unrelated hosts.
- On staging, inspect a synthetic approved campaign and click. Confirm only the
  permitted payload reaches Umami and dashboard counts match. Test private routes,
  parsed credential queries, copied settings on another host, DNT/GPC and opt-out.
- Check that no Google requests or tracking scripts occur. Confirm configured
  UUIDs/origins are absent from prerendered HTML and distributed client artifacts;
  test runtime switching against **one unchanged built artifact**.
- Verify Netlify (`npm run build`) and node (`MODERATY_ADAPTER=node npm run build`)
  with isolated development inputs; never copy production credentials.
- Follow human review and the dev-to-main release process with analytics disabled.
  Only the operator enables production collection after every prerequisite passes
  and verifies actual network delivery and counts.

Umami processes network IP and browser user agent to derive session/visit
information. Small payloads and no cookies do not guarantee anonymity or LGPD
compliance. The collector's geography derivation and infrastructure logs also
need assessment. The published Privacy page explains the scope and preference.

## Local browser regression

Run `MODERATY_ADAPTER=node npm run build`, then
`node scripts/test-analytics-browser.mjs`. This uses Python 3 Playwright and
Chromium; set absolute `PYTHON_BINARY` and `CHROMIUM_BINARY` paths if needed.
One unchanged Node build is restarted with disabled, enabled, denied-host and
invalid runtime settings. Chromium exercises actual SvelteKit navigation,
pending-configuration races, CTA clicks, private-document blocking, browser
privacy signals, storage errors, cross-tab opt-out and generic failure reporting.

All collector and other external requests are intercepted. The temporary local
database contains only synthetic migration-count bookkeeping for anonymous public
and login requests; it does not verify migrations or authenticated flows. Actual
collector CORS, persistence, dashboard counts and purge behavior remain operator
checks on staging.

## Rollback and historical reports

Set `ANALYTICS_ENABLED=false` in runtime settings and restart/redeploy the instance.
Existing documents must reload or opt out to stop an initialized client. Keep
isolated Umami data under its retention policy. Do not automatically reactivate
GTM. Code rollback is separate from this immediate disable switch.

Start a new measurement baseline at activation. GTM is a tag manager: inspect
any downstream analytics separately for historical reports. No GA/GTM history
import or advertising-conversion replacement is included.
