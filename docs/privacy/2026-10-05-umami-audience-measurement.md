# Public audience measurement assessment

Status: **awaiting operator completion and approval**. This is a review template,
not a completed legitimate-interest assessment, legal-basis decision or activation
approval. Production measurement must remain disabled until the activation
checklist in [ANALYTICS.md](../ANALYTICS.md) is complete. If legitimate interest
is unsuitable, keep collection disabled and design visitor-consent gating.

## Purpose and boundaries

Understand traffic to the five public pages, approved campaign attribution and
clicks on approved public marketing links to improve website information. Do not
measure completed signups, payments, account activity or channel connections.
Do not use the data for advertising profiling, cross-service identity, comment
profiling, model training or sale. Do not extend routes/events without review.

The browser sends a website UUID, exact approved hostname, rebuilt public URL,
fixed title, external HTTP(S) referrer origin, and approved click name/placement.
Only exact source/medium registry values are allowed; the campaign registry starts
empty. Duplicate UTMs and all unapproved query values/fragments are discarded.
Parsed credential keys exclude the entire page. No explicit visitor identifier,
account/channel/comment data, advertising click IDs, screen dimensions, language,
client timestamps, identify calls, replay, heatmaps or performance capture is sent.

Umami receives the visitor's network IP and normal browser user agent. Version
3.0.3 derives session/visit identifiers from those values, website identity and
rotating salts; it can derive device/browser and approximate location. Its bounded
response cache remains only in document memory. These are pseudonymous operations,
not a guarantee of anonymity. Hosting/CDN/proxy logs and backups may independently
retain network data and need their own inventory and safeguards.

## Operator decisions to complete

| Decision | Required evidence / outcome | Status |
| --- | --- | --- |
| Specific need | What website decision needs each metric? Who will use it? | Awaiting completion |
| Necessity | Why are less intrusive aggregate server counts insufficient? Can any field/event be removed? | Awaiting completion |
| Legal basis | Article 7 basis for this limited purpose; if IX, documented legitimate interest and ANPD necessity/balancing analysis | Awaiting completion |
| Expectations and impacts | Visitor expectations, public browsing, minors/vulnerable visitors, inference/reidentification risks and likely impact | Awaiting completion |
| Safeguards and objection | DNT/GPC, footer opt-out, permanent private-document guard, reviewed payload registry, least privilege | Code implemented; operational verification pending |
| Controller / processors | Confirm legal operator, collector hosting provider, proxy/CDN and backup operators, contractual roles and access | Awaiting completion |
| Countries and transfers | Actual processing/backup countries and applicable LGPD Article 33 mechanism, including ANPD clauses where used | Awaiting completion |
| Retention | Proposed 90-day detailed-data limit and 7-day backup expiry; tested purge and deletion-lag evidence | Awaiting completion |
| Notices | Approved publication/effective schedule; applicable prominent service/e-mail notices and 30-day period | Awaiting operator publication; user reports no current users |
| Data-subject rights | DPO handling of access/objection/deletion when no supplied account identifier links a visitor to records | Awaiting completion |
| Final determination | Named approver, dated reasoning, basis accepted/rejected and review interval | Awaiting completion |

## Operational evidence before activation

Record the actual deployed Umami version and image digest. The reviewed Coolify
template pins 3.0.3; upgrades and schema-specific purge procedures require separate
verification. Use a separate PostgreSQL database/volume; never purge Moderaty's
database. Confirm unique APP_SECRET, changed admin password, HTTPS, restricted
dashboard access, backups and administrative access logs. Verify support for
`DISABLE_TELEMETRY=1` and `PRIVATE_MODE=1` in the actual version.

Attach a tested deletion procedure with tables/relations, cutoff convention,
foreign-key effects, scheduling, failure alerts and restore/re-purge behavior.
Show that detailed events/sessions age out at the proposed 90-day limit and backup
copies expire within 7 days; record any deletion lag before disclosing it. These
limits are proposed operational choices, not deadlines supplied by LGPD or an
automatic feature of self-hosted Umami. Record access-log retention separately.

Verify CORS through the actual proxy, including `content-type` and
`x-umami-cache`. Scope CSP `connect-src` to the intended collector. Inspect
synthetic requests and dashboard counts, DNT/GPC and opt-out, private-route and
credential-query exclusion, copied config on a fork, and runtime switches against
one built artifact. Confirm no configured measurement settings in distributed
assets, no Google requests and no external tracking scripts. Code/browser tests
cannot establish the health, retention, countries or legal basis of an undeployed
collector.

## Approval record

- Assessor and completion date: awaiting completion.
- Evidence attached: awaiting completion.
- Lawful-basis determination and reasons: awaiting completion.
- Required notices and earliest permissible activation: awaiting completion.
- Approver and next review: awaiting completion.
- Activation decision: **not approved by this document**.

Preserve Privacy §13's 30-day advance-notice promise for applicable future changes,
including prominent service notice and e-mail. The operator reported there are no
current users, so the prepared version 1.19 uses 5 October 2026. This repository
change does not publish the disclosure, send messages or enable production.
