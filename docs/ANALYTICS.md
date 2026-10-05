# Optional Google Tag Manager

Google Tag Manager (GTM) is disabled by default. An unchanged fork or an
unconfigured deployment makes **zero GTM requests**, including on prerendered
marketing and legal pages. On eligible public pages the browser makes a same-origin
configuration request to `/api/analytics`; a disabled deployment responds with `null`.

## Runtime configuration

Set these variables only in the hosting platform's **runtime** environment:

| Variable | Default | Operator configuration |
| --- | --- | --- |
| `ANALYTICS_ENABLED` | `false` / unset | Literal `true` to opt in |
| `GTM_ID` | empty | Your own GTM container ID |
| `GTM_ALLOWED_HOSTNAMES` | empty | Comma-separated exact hostnames |

Hostnames contain no scheme, port, path, or wildcard. For example, an operator
hosting on `app.example.com` supplies that exact hostname. List `www.example.com`
separately if it also serves the application. Configuration trims whitespace and
normalizes hostname case; it does not include subdomains automatically.

The official Moderaty container ID belongs only in the official deployment's
hosting settings. Self-hosters opt in with their **own** container ID and
hostnames. Never commit actual IDs to `.env.example`, source, Dockerfiles, image
defaults, or CI build settings. GTM IDs are public to visitors when a container
loads; deployment-only configuration prevents automatic inheritance by forks,
and does not make the ID secret.

On **Coolify**, make all three variables Runtime Variables with **Build Variable
OFF**. On **Netlify**, give them the Functions scope so the server endpoint reads
them at runtime. No analytics configuration is needed for a build. Do not use
`PUBLIC_*`, `$env/static/*`, Docker `ARG`/`ENV`, or Vite substitutions for these
values. The existing `.dockerignore` excludes local `.env` files.

## Loading behavior

1. The root layout initializes analytics in the browser only on `/`, `/pricing`,
   `/privacy`, `/terms`, and `/dpa`, with no query string. Section anchors on
   those pages work normally. Login, consent, invitations, contact verification,
   contact forms, and all application/account pages never initialize it or show
   an analytics failure notice. SSR and prerendering emit no GTM elements or ID.
2. `/api/analytics` reads `$env/dynamic/private` on each request. Disabled settings
   return `null`. Invalid enabled configuration returns a generic 503 and logs
   the cause on the server. All responses use `Cache-Control: no-store`.
3. The browser supplies its hostname as a query parameter; the endpoint matches
   this untrusted claim against the operator's exact allowlist. This works for
   configured aliases even when adapter-node pins `event.url` to one `ORIGIN`.
   No forwarded headers need to be trusted. The endpoint exposes only a public
   container ID and allowed hostname, not a secret or an authorization grant.
4. Before touching `dataLayer` or inserting a script, the browser independently
   checks its current hostname against the response and rechecks page eligibility
   after the asynchronous request. A copied response cannot enable a fork.
5. When leaving a document containing GTM for an excluded route, navigation
   creates a new document. Removing a script cannot stop an executed container;
   reloading isolates it from sensitive page content. A document that starts on
   or visits an excluded route never initializes GTM later, even after SPA
   navigation to a public page. This prevents sensitive Back-history exposure
   while preserving normal navigation on disabled deployments. Pending
   initialization is cancelled before navigation to an excluded page. A public
   page with a same-origin excluded URL in `document.referrer` also skips GTM.
6. The loader preserves existing `dataLayer` entries, queues the standard GTM
   start event, and inserts one asynchronous GTM script per document. A failed
   configuration or script request logs a browser error and shows a small generic
   usage-measurement status on eligible public pages; it does not block the app.

There is no `noscript` iframe: JavaScript must perform the browser hostname check
before a GTM request. This integration supplies no account identifiers, e-mails,
channel data, comment content, or application events. Tags configured within the
container control their own collection and must be reviewed separately.

## Activation and verification

Before enabling GTM, review the container's tags, privacy disclosures, notices,
and any required visitor consent. The current Privacy Policy §12 states that the
service does not use third-party tracking cookies. Do not enable a container that
contradicts those disclosures. This loader's deployment opt-in is **not visitor
consent** and does not add a consent-management banner.

For a deployment test, open browser developer tools → Network and filter for
`googletagmanager.com`:

- With default settings, there must be no GTM request and no GTM iframe.
- With enabled settings and your exact allowed hostname, there should be one
  `gtm.js` request using your container ID on eligible prerendered pages.
- With enabled settings on a different hostname, there must be no GTM request.
- Account, consent, invitation and contact-verification URLs must make no GTM
  requests, including after navigating from a tracked public page and using Back.
- With adapter-node `ORIGIN` pinned, verify each configured hostname separately.
- Reload after switching back to `ANALYTICS_ENABLED=false`: no GTM request.

Test runtime changes against the **same built artifact** to confirm that a
rebuild is unnecessary. Check static HTML and client bundles for your configured
ID; it must be absent. Keep `/api/analytics` out of CDN caching (Bunny's existing
`/api/*` bypass covers it).

Changing environment settings requires restarting/redeploying the server
instances according to the hosting platform. Disabling stops loading in new
documents; already-open tabs have already loaded the container and must reload.
