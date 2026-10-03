# Moderaty launch runbook

Use this checklist for a release. The operator performs deployments, secret entry, purchases, production changes and account/legal decisions. Recording a checklist does not verify a deployment.

## Minimum release gates

1. **Release and cache**: finish the intended fixes, run all three local gates, and record the exact release SHA. The owner merges/deploys. Confirm Coolify deployment success and migration verification for that SHA. Run the read-only preflight below against the public hostname. Separately establish that its commit marker is not cached and that public HTML reflects the release.
2. **Bunny configuration**: the owner securely supplies the correct production site URL and a least-privilege zone-scoped key as GitHub Actions repository secrets, then reruns the purge workflow. Verify the actual wait/purge evidence, not the green wait-step label alone. Do not put the Bunny key in the app runtime or paste it into a ticket. Verify the public cache policy before relying on the marker.
3. **Payment and BYOK**: execute the focused dev smoke below using test Stripe, an isolated dev organization/channel and the owner's secure credential entry. Record outcomes against the release SHA. A real-money operator test is a separate purchase approval; it is not implied by this checklist.
4. **Cron and independent alerts**: prove both a completed scheduled tick and a missed-tick alert in dev, with delivery and recovery confirmed. Then the owner enables separate production checks. A healthy `/api/health` cannot establish that background work runs.
5. **Recovery and mail**: complete an approved disposable native Turso restore drill, and owner-controlled Proton delivery checks. Keep both open until observed. If the owner accepts a launch exception, record exactly which verification remains missing and who is responding.
6. **Legal decision**: the operator and legal advisers confirm the effective document version, consent flow and any required notice/cutover timeline before enabling a release or new subprocessor. Record the approved decision separately from technical checks.

### Read-only preflight

The supplied script has no dependencies, credentials, sign-in, forms, purchases, cron invocation or database writes. It reads only `/api/health` and `/__moderaty_commit.txt` at the supplied HTTPS origin. Redirects fail. It requires the complete expected commit SHA and exits 1 on failed health, unknown marker or a mismatch; bad arguments exit 2. It does not print raw errors or response bodies.

```sh
# First test the helper locally; its tests inject fetch and make no network calls.
npm test -- scripts/public-launch-preflight.test.mjs

# Owner/operator: replace the SHA with the actual intended release commit.
node scripts/public-launch-preflight.mjs https://moderaty.com FULL_RELEASE_SHA
```

The helper tests use fake responses and make no network calls. A query-busted marker helps but cannot independently prove the CDN's actual cache-key policy; compare it with the verified Coolify release and reviewed cache rules. Do not point a generic monitor at `/api/cron`, even without a secret.

## Focused dev checkout and BYOK smoke

Use Stripe test mode and the dev Turso database. Confirm environment isolation before entering the flow. Use only owner-approved test accounts and channels; keep `DRY_RUN=true` for external comment protection. The owner enters API keys directly in the app, never in chat, screenshots or issue text.

- [ ] Start a fresh signup. Google identity login and YouTube channel permission are distinct steps. Cancel/back out of each and verify the app can resume without a partial paid state. Confirm explicit legal consent and current-version recording before the app opens.
- [ ] Hosted checkout displays USD 5 every month, 100 included comments, and renewal/cancellation information. Cancel once, return, then complete one Stripe test-mode purchase. Confirm the correct organization receives the hosted entitlement and included credits.
- [ ] Lifetime checkout displays USD 49 once, BYOK required and the remaining-slot/sold-out state. Complete one test-mode purchase. Confirm `plan='lifetime'`, one claimed slot and one active lifetime entitlement, with the visible slot count decreased once.
- [ ] Refresh/revisit the success page and replay the relevant **test-mode** webhook under owner control. Confirm no duplicate entitlement, slot claim or credit grant. Verify webhook delivery separately from the browser redirect; a success page alone is not enough.
- [ ] A hosted organization cannot accidentally buy a second active hosted plan; a lifetime organization cannot buy credit bundles or enable automatic top-up. Verify a non-owner cannot initiate billing or save/remove the BYOK key, including server-side action tests.
- [ ] Owner saves a valid OpenAI key on the lifetime Team page. UI shows stored/not-stored status without returning the key. Verify scoring with an isolated, approved dev fixture; record only the outcome. Clear the key and verify the missing-key path fails closed to human review without using the operator key. Under global dry-run, verify the preview outcome rather than expecting a durable review-queue row.
- [ ] If top-ups are offered at launch, test the configured 500- and 2,000-credit checkout prices: USD 20.40 and USD 64.65. Legacy 100-credit purchases should not be newly offered. Automatic top-up must remain off until separately enabled with explicit owner consent.
- [ ] One free feedback preview moves from pending to a persisted preview in Recent digests; refresh and revisit retain it. A second attempt is refused. Neither preview spends credits or changes YouTube moderation. Prove the scheduler drains it; merely clicking Run is not completion.
- [ ] Record pass/fail, release SHA, dev deployment identifier and sanitized test-mode event/session references. Never record a key, token, full webhook payload, customer address or tax identifier.

## Monitoring configuration to approve and enable

`launch-monitoring.example.json` is a vendor-neutral configuration worksheet, not an importable provider file. All entries are disabled. Select and approve the monitor, independent host, alert destination and responders before enabling it.

- **Public service check**: GET production `/api/health`, timeout 10 seconds, interval 60 seconds, require HTTP 200 and JSON `status='ok'`, alert after 3 consecutive failures, recover after 2 successes. Run from a separate failure domain. Dev gets its own origin and incident.
- **Completed-tick check**: use the existing runtime-only `HEALTHCHECK_PING_URL` hook, with a different ping URL per environment. For an every-minute Coolify schedule, start with a 60-second expected period plus 180-second grace, approximately 4 minutes since the last success. Verify the actual runtime schedule and review against measured longest ticks. Recalculate if the schedule changes to 15 minutes; do not retain a one-minute deadline.
- **Task command**: `APP_URL=http://127.0.0.1:3000 node scripts/dev-cron.mjs --once`, on `* * * * *`. The secret stays in runtime and its Authorization header. Confirm the final release includes the scheduled-task reliability fix before enabling checks.
- **Meaning**: operator-actionable task failure must exit nonzero and withhold the heartbeat. Existing owner-actionable token/credit states deliberately warn without an operator outage alert. A failed monitor ping logs an error and relies on the dead-man monitor to notice silence; it does not make the task fail.
- **Alert delivery**: choose a tested channel independent of the app's Proton send path, name the primary responder and a backup route, notify once when an incident opens, repeat every 30 minutes while unresolved, and send recovery. Maintenance silences need a named owner and an automatic expiry, initially no longer than 30 minutes.
- **Dev proof**: stop only the dev scheduler and confirm the dead-man alert while health remains 200; restore it and confirm recovery. Use an isolated dev database-failure fixture to prove health 503 and recovery. Exercise a controlled task error to prove nonzero status and no success ping. Verify delivery, not only an incident visible in the monitor dashboard.

Do not label monitoring complete until the owner has enabled production and checked delivery. Configuration files and application hooks are preparation only.

## Turso Free native recovery drill

The selected plan stays Free with native Turso recovery only. No S3, independent export pipeline, paid upgrade or deleted-database recovery is part of this plan. [Turso's current PITR documentation](https://docs.turso.tech/features/point-in-time-recovery) describes a rolling 24-hour Free window, restoring an existing database into a **new** database, additional quota use and separate connection authentication. Published retention is not proof of this account's effective restore points or a measured recovery time.

1. Obtain owner approval for a named disposable source, a new isolated restore target, fixture contents and cleanup. Verify actual Free-plan database/storage headroom and the restore timestamps available to that source. Do not select a timestamp solely from the published window.
2. Owner creates/uses the approved disposable source with two known fixture states at recorded UTC times. Choose a point between those states inside verified coverage. Keep real customer data out of the drill. No source deletion is needed.
3. Owner runs native PITR into the new target using the approved account flow. The documented CLI shape is `turso db create NEW_TEST_TARGET --from-db APPROVED_TEST_SOURCE --timestamp VERIFIED_UTC_TIMESTAMP`. This command was not executed. Credential creation or new persistent access remains owner-controlled.
4. Keep the restored database disconnected from application cron, YouTube, Stripe and mail side effects. With an authorized read-only connection, verify the expected schema, fixture rows at the chosen point, absence of the later fixture, `PRAGMA integrity_check` and `PRAGMA foreign_key_check`. Preserve original source and production connections.
5. Measure from recovery decision to verified, authenticated, isolated usability; record elapsed time, selected timestamp, safe schema/fixture results and remaining quota. This establishes a drill RTO; it does not promise the same recovery time for production volume.
6. Owner-approved cleanup applies only to the named disposable resources. Never delete production to test recovery. If there is no valid point, quota blocks creation or account/provider access is unavailable, record the exact failure, preserve the source and escalate through the owner's Turso account. There is no independent backup fallback in this design. Detection and response must fit inside the effective rolling window.

Keep the recovery gate open until a live authorized restore and its acceptance checks are recorded.

## Proton and incident response

- The operator securely supplies separate dev/prod SMTP credentials as runtime-only secrets, verifies domain authentication and outbound STARTTLS connectivity, then performs approved delivery checks. Validate links, Sent copies, limits and applicable notices. Record sanitized delivery outcomes; never include credentials or raw message payloads.
- If public health fails, first compare the verified release/deployment and provider status; inspect sanitized application/Coolify errors. If only the dead-man alert fires, check whether the scheduled task exists and ran, its exit status, and its last successful ping. Do not try to repair monitoring by making public cron calls.
- If a release must roll back, the owner chooses a previously verified compatible app release and verifies migration compatibility before switching. A code rollback is not a database restore. Re-run public health/commit checks and confirm cron, webhook and mail recovery after the authorized change.
- Record incidents with UTC times, environment, release SHA, coarse error category, affected function and outcome. Exclude credentials, raw provider responses, full request URLs/headers, payment data and comment text.
