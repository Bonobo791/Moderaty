# First hosted welcome (MOD-258)

## Release scope and guardrails

This implements **only the first informational account welcome**. It does not
implement, enroll, or enable the later promotional series, lifetime offers,
marketing-consent changes, or unsubscribe flows. Marketing opt-in is not a
prerequisite for this service-oriented email. Existing legal consent stays
unchanged; there is no new email-verification ceremony.

New accounts enqueue inside the existing user/personal-organization/consent/
session transaction. Only a newly inserted account can enqueue there. The existing
authenticated cron drains after commit; SMTP is never called by signup. A rolled
back signup leaves no welcome. Re-consent, repeated OAuth flows, subsequent login,
and organization switches do not reenroll the campaign. Each enabled cron tick
also examines at most 25 user IDs for existing hosted accounts with missing,
unknown or never-sent history and automatically enrolls eligible accounts. Already queued delivery takes
priority over discovery; when the queue is empty, a newly enrolled welcome can
be attempted in the same tick if budget remains.
No operator command or per-user action is required.

Automatic discovery and delivery use the existing runtime guards:

- `MODERATY_DEPLOYMENT=official-hosted`: deliberate operator declaration for the
  official hosted database, regardless of adapter or payment plan
- `WELCOME_EMAIL_ENABLED`: enabled by default for official hosting when unset,
  empty or `true`; explicit `false` pauses automatic discovery and delivery
- `DRY_RUN=false`: existing dry-run safety gate

Do not enable these on self-hosted instances, restored production copies, or dev
instances containing real recipients. Free/unsubscribed official hosted accounts
are included. A known non-hosted cohort or operational suppression is excluded.
For a mixed-origin database, classify/exclude non-hosted rows before enabling
official-hosted operation.
No production state or credentials were used during implementation.

## History policy

The user explicitly chose on 2026-10-03 to include both **never-sent and unknown or
missing historical send records**. Missing history is not described as proof that
no prior email was sent. This is reflected in the durable `source` value:
`signup`, `never_sent`, or `historical_unknown`.

The current main schema and repository history contained no first-welcome record.
Migration 0062 creates the separate outbox without updating/enrolling any existing
user. Migration 0063 adds recipient-independent campaign pacing, carrying forward
any recent attempt, live lease or transport-outage cooldown without enrolling
users. The campaign row contains only the campaign key and next allowed attempt
time; account deletion cannot erase this pacing fence. Automatic discovery reuses
these tables and requires no new migration. A missing row is counted as
historical unknown by the preview. Previously
recorded success (`state=accepted` or `accepted_at` present), suppression, terminal
failure, and uncertain new submissions are excluded from automatic backfill.
A template-version change never changes the campaign key or reenrolls accounts.

Before the production migration/batch, the human operator must verify the deployed
migration journal and inspect any historical records outside this repository. If
successful sends are known, represent them as `accepted` campaign records before
backfill. No per-user proof of "never sent" is required for historical unknowns.
Unknown historical sends can lead to a duplicate welcome if an earlier external
send was never recorded. This is an intentional consequence of the chosen cohort.

**Historical unknown is different from a new ambiguous SMTP attempt.** Never
requeue an ambiguous submission just because historical unknown is eligible.

## Queue and delivery behavior

The primary key is `(user_id, campaign)` with campaign `hosted-signup-welcome`;
template version is currently 1. Records contain source/cohort, explicit state,
queued/attempt/retry timestamps, attempt count, a random stable Message-ID, claim
nonce/expiry, sanitized error category, provider acceptance timestamp/message ID,
and suppression reason. Recipient names, addresses, message bodies, credentials,
and consent evidence are not copied into the outbox.

- `never_sent` / missing or `historical_unknown`: enrollment candidates only
- `queued` / `retryable_failure`: may be claimed when due
- `claimed`: no transport submission yet; abandoned claims can safely recover
- `in_flight`: submission may have occurred; expiry becomes `ambiguous`
- `accepted`: Proton confirmed the intended envelope recipient and final DATA 250
- `permanent_failure`: definite rejection or five failed attempts; operator review
- `suppressed`: deleted/anonymized, unusable recipient, non-hosted or operator exclusion
- `ambiguous`: manual reconciliation required; never an automatic retry candidate

A fenced atomic claim and campaign-wide throttle allow at most one SMTP attempt
per 60 seconds, including overlapping cron invocations and account deletion
during submission. Claiming reserves the campaign slot transactionally; the
pre-send transition refreshes the interval and rejects expired claims. One cron tick attempts at
most one recipient, examines at most 25 users for enrollment and recovers at most 25 stale
claims, checking its five-second share of the existing 20-second budget between
operations. Discovery uses an indexed keyset page capped before eligibility
checks; deadline checks occur between short transactions. Retry delays for definite failures are
60s, 120s, 240s, 480s, then terminal after the fifth failed attempt. DNS, explicit transient SMTP rejection and proven pre-DATA errors
are safe retry categories. Configuration/authentication, TLS, DNS and sender-policy (`MAIL FROM`) outages preserve
the recipient attempt count and pause the entire campaign for 15 minutes through
a recipient-independent durable cooldown. They cannot permanently exhaust the queued users while an
operator repairs the transport. A deadline proven to occur before `sendMail` defers
without consuming an attempt; a deadline during transport is uncertain.

Nodemailer's `CONN` command label also occurs after the complete DATA body, so it
is **not** evidence of a pre-submission failure. Unclassified disconnects,
unconfirmed/malformed success and a crash after provider acceptance but before
DB persistence become ambiguous. The accepted-state write is deliberately outside
the SMTP-failure catch. A stable Message-ID is useful for reconciliation but does
not guarantee provider deduplication, exactly-once SMTP, or inbox delivery.

Immediately before submission the worker rereads live account/recipient, cohort,
suppression, memberships and channel preview state, then fences the write against
account changes and the claim. Deletion erases the outbox in the account-deletion
transaction. Invalid stored membership roles suppress that welcome with
`invalid_membership`, release its claim, and emit a fixed diagnostic category;
operators must repair the membership before deliberately requeueing it. Other
preparation/persistence failures emit fixed, bounded diagnostics without raw SQL,
addresses or credentials. Valid IDNA ASCII-label domains remain eligible.
A deletion/suppression committed after SMTP has started cannot recall
a message already submitted; there is no cross-system transaction with SMTP.

## Copy review and local previews

Subject: **Welcome to Moderaty — let’s get your channel ready**

Preview: **Your first steps with Moderaty, from connecting a channel to reviewing comments.**

Version 1 is English only because there is no stored language preference; it does
not infer language from a name, email or Google profile. Personalization is bounded,
control-character sanitized and HTML-escaped. Both formats include the support
address `contact@moderaty.com`, the contact page `https://moderaty.com/contact`,
a dashboard CTA and a direct login fallback with no recipient/session data in URLs.
Reply-To is `contact@moderaty.com`. The origin comes from a validated HTTPS APP_URL.

The content distinguishes signing in from connecting a YouTube channel, tells the
user to select the right team, and reserves connection instructions for teams in
which the user is an owner/admin. Settings/rules, the review queue and audit log
are explained. Preview copy depends only on the **moderation** one-use marker,
not the unrelated feedback preview. One free attempt per channel changes no
YouTube comments or comment credits; failure can consume the attempt. Used and
paused states receive appropriate next steps.

Generate reviewable, synthetic HTML and plain text without a DB or SMTP call:

```sh
node scripts/preview-welcome-email.mjs /tmp/moderaty-welcome-previews
```

Review all six variants (new owner, member, connected unused, connected used,
mixed teams and mixed preview status) at mobile and desktop widths. Copy approval
and a controlled external-inbox delivery test remain first-release gates; the
local tests use only a loopback fake SMTP server and synthetic database.

## Automatic existing-user enrollment and optional monitoring

Normal authenticated cron selects an unfiltered, indexed page of at most 25
user IDs before checking eligibility. Already queued, accepted, suppressed,
non-hosted, terminal-failure and fresh ambiguous submissions are skipped while
the saved position advances. Deleted account tombstones never acquire fresh
delivery metadata. Invalid recipients receive a suppression record. Enrollment
rereads account and campaign state inside the same short transaction used by signup.

The `welcome_discovery` campaign row saves the last inspected user ID and the
highest user ID at the start of each traversal. The fixed upper bound makes
each traversal finite even while new accounts arrive. Reaching the end resets
the cursor, revisiting failed or newly eligible accounts and later inserts that
sort before the previous position. A 60-second discovery lease and claim-token
checks prevent overlapping or expired workers from overwriting that position.
The inspected position and successful enrollment commit together; failed
enrollment advances the position separately so one failing account cannot pin
the remaining users. Migration `0067_welcome_discovery` creates this state.

`welcomeEmailCandidatesScanned` counts users inspected for enrollment, including
excluded and already enrolled users, and is at most 25 per tick. SQLite regression
tests verify actual scan and VM work on a mostly enrolled population, rather than
only the number of eligible results. If the shared deadline expires, unprocessed
IDs resume on the next tick. Already queued delivery is attempted before discovery;
an initially empty queue gets at most one post-enrollment attempt when time remains.
An in-progress database operation is still subject to database and network latency.

Restarting or overlapping ticks cannot duplicate campaign enrollment. Acceptance
state or timestamp prevents reenrollment even if the other marker is missing.
New SMTP uncertainty stays held for reconciliation. Existing users are included
regardless of plan or marketing opt-in.

An account enrollment that still fails after busy retries logs a fixed diagnostic
category and increments `welcomeEmailEnrollmentErrors`; the remaining users
and queued deliveries continue within the shared deadline. Failed candidates
are retried after the saved traversal wraps. The cron health response and both schedulers
report these failures without exposing account identifiers or raw database errors.

The following CLI commands remain optional diagnostic and enrollment tools;
they are never prerequisites for the app's automatic enrollment.

Run from a reviewed checkout with Node 24 and the installed project dependencies.
The CLI uses Vite's server module loader to invoke the exact same enrollment and
eligibility implementation used by signup. It never calls SMTP, regardless of the
send switch. It does not install packages. Supply the target environment explicitly;
do not casually source the main checkout's production `.env` during development.

Read-only commands:

```sh
node scripts/welcome-email.mjs preview
node scripts/welcome-email.mjs status
```

Preview returns **counts only**: total, eligible, excluded, and the eligible
historical-unknown subset. It paginates 250 rows internally and does not return
addresses or mutate records. Status returns campaign counts by durable state. CLI failures identify safe usage, configuration, missing-
schema, busy-database, authentication or connectivity categories without printing
raw database errors, URLs, SQL parameters or credentials.
Counts are a point-in-time observation; enrollment and sending recheck eligibility.

For an optional manual batch, the human operator can run:

```sh
node scripts/welcome-email.mjs enqueue --limit=5 --confirm-enqueue
```

`limit` is 1–25 **users scanned**, not a promise to enqueue that many. The response
contains scanned/queued counts and a resume cursor. A full page returns a cursor;
repeat with `--after=CURSOR` until it returns null. Rerunning a page is safe and
cannot duplicate a campaign enrollment. A full final page can require one empty
follow-up page. Unknown/no-record users take this same path; an already queued,
accepted, ambiguous or excluded user is skipped. The app enrolls existing users
automatically through cron; migrations themselves only create the durable schema.
Explicitly disabling delivery also pauses automatic discovery. New hosted signups
retain their transactional enrollment while disabled.

## Staged release, monitoring and recovery

These steps are **human rollout gates**, not actions performed by the implementation:

1. Review copy, the branch diff, migration and existing-user preview policy
2. Verify the actual deployed migration journal/history, prepare a recoverable
   backup through the existing operator process, then apply and verify migration
   0062 and 0063 before exercising the new code; confirm key, indexes and integrity checks
3. Validate in an isolated synthetic database with mocked SMTP; exercise automatic
   enrollment across bounded pages, signup rollback, concurrent/repeated sweeps,
   terminal markers and uncertain-send holds
4. Obtain separate authorization for a controlled external-inbox test and any
   necessary runtime configuration; never use an existing real-user database for
   a synthetic test; verify headers, both MIME parts, dashboard/login and Reply-To
5. Release only through the human's normal code-review/deployment process.
   Official-hosted cron then enrolls every eligible existing account automatically;
   no manual batch enrollment or additional activation flag is required
6. Monitor cron `welcomeEmailCandidatesScanned`, `welcomeEmailsQueued`,
   `welcomeEmailEnrollmentErrors`,
   `welcomeEmailsAccepted`, `welcomeEmailErrors`,
   `welcomeEmailAmbiguous`, `welcomeEmailSuppressed`, `welcomeEmailSweepError`, and
   operator state counts. `welcomeEmailAmbiguous` is a bounded presence flag
   (0 or 1), not the queue total. Ambiguous rows stay visible in subsequent
   enabled cron health without scanning/counting the complete campaign. Both the
   local/Coolify driver and Netlify wrapper name welcome sweep, delivery and
   reconciliation failures, including alongside owner-actionable channel errors
7. Stop with `WELCOME_EMAIL_ENABLED=false` if errors, uncertainty, bad copy or
   recipient issues appear. The switch prevents new claims; it cannot recall an
   attempt already in progress. Resolve the cause before resuming

For an `ambiguous` row, keep sending disabled for the affected rollout while the
operator searches Proton's submission records by the stable Message-ID and time.
Record the investigation in the release/incident record. If acceptance is proven,
set the row to accepted with the confirmed timestamp/message ID. If non-submission
is proven, a human may deliberately reset it to queued with a next retry time and
clear its claim/lease. If outcome remains unknown, leave it ambiguous or suppress;
do not infer non-delivery from a missing inbox message. Do not use the historical
backfill command to resolve an uncertain attempt.

Operational suppression sets `state=suppressed`, a non-sensitive reason and null
retry/claim/lease fields. Only the human operator should perform production
reconciliation or suppression changes. Raw SMTP replies, tokens, addresses or
message bodies must never be copied into error categories or release logs.
