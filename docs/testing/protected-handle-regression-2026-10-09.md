# Protected-handle browser regression

Based on main `496565f0187fed87238d31e6aae0f06955d2036c`, isolated on `task/protected-handle-playwright-20261009` after reading `AGENTS.md` and discussing the design. The browser test first reproduced an application bug. The identity fix was proposed, then implemented after approval.

## Reproduce

```sh
npm ci
npm run prepare
npx playwright install chromium
npm run check:e2e
npm run test:e2e
```

The launcher isolates application source in a temporary project containing synthetic dotenv files, drops inherited credentials and Node preloads, generates synthetic secrets, and creates a temporary file-backed libSQL database. Developer dotenv files remain untouched. It creates the documented pre-0000 base tables, applies the full real migration journal, and checks the applied count. Teardown stops the server and removes the database. Browser reports are under `reports/playwright/` and `reports/playwright-results/`.

This environment used Playwright 1.64.0 and Chromium 153.0.8010.0 with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/tmp/moderaty-chromium`: the standard browser download returned HTML instead of a ZIP. The alternate Chromium binary came from `@sparticuz/chromium` 153.0.0 outside the repository. A normal setup uses Playwright's bundled Chromium. The override changes the executable, with identical assertions and application paths.

## Failure and fix

| Identity | Configured handle | Display name | YouTube author ID | Before fix | After fix |
| --- | --- | --- | --- | --- | --- |
| Protected | `@protected_creator` | `Protected Creator` | `UCsynthetic_protected_author` | Rule ban completed | Approved by allowlist; no action |
| Control | None | `Unprotected Creator` | `UCsynthetic_control_author` | Rule ban completed | Rule ban completed |

Both comments contain `synthetic-ban-trigger`, matching the same configured ban rule. Before the fix, all persistence and positive-control checks passed, while five protected-case assertions failed. The outbound `banAuthor=true` request named both comment IDs. The retained [failing evidence](protected-handle-evidence-2026-10-09.json) records that result. The [passing evidence](protected-handle-green-evidence-2026-10-09.json) records only the control's ban, plus the protected approval and verified persisted configuration.

`youtube.ts` parses `snippet.authorDisplayName` into `authorName`. Main compared that display name with normalized configured handles. `Protected Creator` becomes `protected creator`, which cannot equal `protected_creator`. Staging also incorrectly recorded display names as handles.

YouTube supplies `snippet.authorChannelId.value` separately from display names ([Comments](https://developers.google.com/youtube/v3/docs/comments), updated September 30, 2026). Its `channels.list` API resolves a handle using `forHandle` ([Channels: list](https://developers.google.com/youtube/v3/docs/channels/list), updated September 14, 2026). Comment resources do not supply an `authorHandle` field. Generic channel `customUrl` metadata is not used to infer identities.

The UI now resolves the entered handle through `channels.list(part=id, forHandle=...)` before writing configuration. An empty, malformed, failed or ambiguous response fails the add. Migration `0071_protected_channel_identity` adds nullable `resolved_channel_id` to owner-configured protections; applied migration files are unchanged. Incoming author IDs match those configured IDs before rules or AI. Display names cannot grant protection or become stored audit handles. Protected approval audits carry the configured handle; unverified handles remain NULL.

Protection binds the verified channel identity across display-name and handle changes. Re-adding a verified handle preserves its original identity without lookup. Removing and re-adding selects its current holder. Concurrent legacy resolutions cannot overwrite an identity that was already verified.

Existing handle-only entries remain visible as unresolved and offer **Verify @handle**. Until resolution succeeds, comments that cannot be proven protected are held for review before rules or AI; automatic bans, deletes and rejects are paused. Known protected identities still receive approval. Missing author IDs also go to review whenever protections are configured. Explicit resolution works at the 100-entry limit without adding a row. Failed resolution retains the original configuration.

## What the test proves

Chromium submits the actual authenticated form, reloads the page, verifies the UI row and persisted handle plus resolved identity, then exercises production moderation. Ownership checks, sessions, consent, YouTube parsing, database reads and writes, allowlist matching, rule decisions, action staging, enforcement, completion and audits all execute. The test launcher invokes `runChannel` through IPC in the same Vite SSR module graph and database as the app; application code gains no test endpoint or authentication bypass.

The control must produce a rejected rule decision, durable completed ban action, audit row and serialized provider request before absence checks can pass. An inactive pipeline, empty provider page, disabled enforcement or dry run fails. The protected case must produce an allowlist approval and audit, no staged action, no outbound ban, and exactly one acted comment overall. Comment rows must retain NULL author names and IDs. The configured identity stays only in owner configuration.

Only external HTTP boundaries return synthetic responses: OAuth refresh, handle lookup, comment retrieval and enforcement. Unexpected server fetches throw and appear in evidence; browser requests outside the loopback app are blocked. No live provider request or real moderation occurs. AI is not invoked because the keyword rule decides the control; this test does not prove AI scoring or cron authorization. It evaluates newly fetched comments, not pre-existing staged moderation actions.

Focused real-database tests additionally cover different display names, copied protected handles, missing author IDs, unresolved legacy protections, channel scoping, lookup failure, capacity resolution and concurrent resolution/removal. Provider parser tests reject malformed and ambiguous identity responses. Upgrade tests apply the real journal twice and preserve legacy configuration with a NULL resolved identity.

## Validation

- The initial browser regression failed repeatedly on main; its control passed.
- The unchanged baseline passed 206 Vitest files and 4,021 tests.
- Final browser regression passes with the approved identity fix.
- Final Vitest: 207 files and 4,041 tests passed.
- `npm run check`: zero errors and warnings.
- `npm run check:e2e`: passed.
- `npm run build`: passed with the Netlify adapter.

No suite discovery or CI configuration was changed. Playwright explicitly discovers `.pw.ts` files, avoiding Vitest's `.test`/`.spec` patterns. No mutation or property-test configuration was changed. Future integration must reconcile package files and migration numbering/ancestry with other branches before applying migrations. No production migration, push, PR, merge or deployment was performed.

## PR #222 review fixes

Triage validated four functional issues on the published commit `4751ac0`:

- Raw OAuth/lookup errors and decryption diagnostics reached the form. Three failing route regressions reproduced this before the fix. Provider failures now stay in server logs; the browser receives a fixed message, and configuration remains unchanged.
- Missing `items` looked like malformed provider data. Two failing lookup regressions reproduced this. Missing, NULL or empty items now produce a safe not-found error. Malformed bodies/items and invalid identities remain failures.
- Two lookups starting with 99 entries could both insert. A synchronized real-database regression failed with 101 rows. The final write now locks and rechecks capacity in a transaction after provider work.
- Disconnect, same-ID reconnection or ownership transfer during lookup could persist stale protection. Three route regressions failed. The final transaction checks the original owner organization and encrypted connection grant before writing. It cannot resurrect a deleted connection or bind to a replacement grant.

Gitar's proposed change to unresolved-identity moderation was declined because it conflicts with the approved hold-until-verification policy. The cap-before-duplicate behavior and normalized audit handle format predate this PR and remain unchanged.

Codacy's six SQL findings apply PostgreSQL/SQL Server checks to SQLite fixture DDL. The real libSQL migration/browser runs validate that DDL. No SQL dialect substitutions, analyzer exclusions, threshold changes or test removal were used. Function-length/complexity reports and the re-export style suggestion are maintenance advisories, not reproduced functional defects; no unrelated refactor was added. The lookup parser now reuses existing validation helpers as part of its functional fix.

CodeRabbit's requested draft review was rate-limited, and cubic reported its monthly review limit. Those unavailable reviews are not evidence of correctness. Existing CI validation jobs passed on the published commit; they do not run the opt-in Playwright command. Review fixes are validated locally before publication approval.

Review-fix verification: 207 files / 4,058 Vitest tests passed, plus Svelte check (zero errors/warnings), E2E type check, production build and Chromium browser regression. Nine reproducing tests failed before their corresponding fixes; 17 added tests cover fixes and malformed-response boundaries. No fixes have been published at this checkpoint.


## Second review: validated defects and remaining design decision

Review of published head `b86abc0` reproduced five failing assertions before
three local fixes: two stale-protection staging cases, one newest-label case,
and two malformed lookup cases. The staging transaction now reads the current
protection under the same channel write lock used by UI verification and applies
that outcome before inserting comment/action rows. A real-libSQL regression
scores both authors as rule bans, commits a new protection, and verifies the
protected author is approved while the unprotected control still stages,
dispatches, and completes its ban through the real enforcement code. Only the
external HTTP response is stubbed. New unresolved protection sends stale
negative decisions to review rather than a destructive action.

Multiple configured handles for one identity now use the newest configured
label. Missing/null `items` now remain malformed-response failures; only an
actual empty array means not found. This supersedes the earlier missing-items
review disposition. Reference: Google's channels.list response contract,
updated 2026-09-14: https://developers.google.com/youtube/v3/docs/channels/list.
Malformed-input cases remain tested under the corrected expected failure type.

The additional protection read is one statement per batch. The existing bulk
staging test still checks identical query counts for 3 versus 300 comments,
all 303 comment rows, all 303 credit transactions, and exact outcomes. Its exact
statement count now records 12 including the reads before and inside the
staging transaction instead of 10. No coverage, mutation, discovery or CI threshold changed.

Playwright's existing exact dev-dependency pin is authorized by the owner's
explicit Playwright request and design approvals; that approval is now recorded
in AGENTS.md.

### PR #226 privacy redesign

The owner chose protection that follows the current holder of the entered handle.
Configuration now stores only that normalized handle. Each run resolves its
current channel ID in memory, with five concurrent lookups bounded by the
existing run deadline. Missing or failed lookups hold comments for human review.
Staging reuses only proofs for unchanged row IDs and handles; a newly configured
entry without a current proof also causes review. Removing protection during
scoring queues a stale approval and clears its protection label.

Ordinary commenters' handles come from authoritative `channels.list` snippets,
in batches of at most 50 IDs. Only `@` custom URLs become normalized audit and
moderation-action handles. Display names and channel IDs remain in memory.
Existing 30-day and on-demand handle erasure remains in place.

Migration `0072_protected_handles_memory_only` removes `resolved_channel_id`,
keeps the newest duplicate configuration row and adds per-channel handle
uniqueness. Migration 0071 remains unchanged. Upgrade tests execute the new SQL
against pre-existing identity data, verify its removal and reject duplicates.
No production database or legal disclosure was modified.

Pending destructive actions re-read current comment authors and protection
before their dispatch claim. A newly protected author supersedes a pending ban;
unresolved identity changes the pending action to a review hold. An external
request already sent to YouTube cannot be withdrawn, and YouTube offers no
API to reverse a completed author ban.

The browser regression now forbids stored resolved IDs and verifies the ordinary
control's normalized handle in its completed ban audit. Earlier evidence files
record the previous account-binding implementation; they are historical evidence.

### Check and bot dispositions

Both CI validation jobs, CodeQL, Semgrep and Sonar passed on `b86abc0`; this is
not an all-checks-green claim. The Sentinel agent failed before inference because
its trusted checkout is `dev` at `769b0e6`, which lacks
`scripts/test-quality-context.mjs`. Its final conclusion job succeeds despite
that failed agent. That independent workflow belongs to another task/session;
this branch does not copy missing Sentinel files or weaken its checks.

All 13 current Codacy annotations were inspected: six SQL Server/PostgreSQL
checks target the SQLite fixture; seven length/complexity advisories do not
reproduce a functional defect. The three Sonar annotations are the existing
standalone-SQL literal, fixture re-export and fetch complexity advisories.
CodeAnt's new race, label and malformed-response findings are fixed locally.
Its green/risk/diagram/status and marketing comments do not replace testing.
Gitar reports its original findings closed; the missing-items behavior above
is nonetheless corrected using the current provider contract. CodeRabbit skips
the nondefault target and its earlier requested review was rate-limited; cubic
has exhausted its quota. Amazon Q's prior approval includes a >30-file caveat.
No unavailable review is counted as completed validation.

Second-review local validation: 208 Vitest files / 4,061 tests passed, Svelte
check reported zero errors and warnings, E2E type check and production build
passed, and the Chromium regression passed with its real positive control.
The strengthened staging race test additionally completes the control's remote
ban through the external synthetic HTTP boundary. Five assertions were seen
failing before fixes. The two privacy/design findings remain open even though
the implemented fixes validate green. No new fixes have been published.


## Billing marker and developer dotenv review

Gitar finding 4231570405 is valid. The staging protection refresh replaced a
billable AI result with a new decision lacking its consumed-call marker.
Three real-database tests failed before correction: verified and unresolved
protection overrides wrote no ledger entry, and an exhausted account staged
free instead of rolling back. Overrides now preserve the original billable
flag. Tests prove a debit of one credit, the scan-scoped ledger anchor, no
second debit on rescan retry, preservation of the safe moderation outcome,
and full rollback on insufficient credit. No billing or persistence mock was
introduced.

Codex finding 4231580125 is valid. A dev checkout's dotenv file prevented the
isolated browser app from starting. The browser regression was first run in
a disposable project with four synthetic dotenv files and failed at the old
refusal. The launcher now disables Vite dotenv loading and gives SvelteKit
its own empty environment directory; SvelteKit loads dotenv independently of
Vite. Its supported inline configuration API receives the actual app compiler
and kit configuration. No production app configuration was changed.

The fixture serves unchanged source/dependencies via symlinks in the disposable
project, with generated app output and synthetic .env, .env.local,
.env.development and .env.development.local files there. It never reads,
renames, deletes or copies the user's real dotenv files. Child credentials
remain synthetic and the migrated libSQL database remains disposable.
The launcher checks both public/private poison markers and the expected
local database URL; contamination aborts before authentication/seeding.
A deliberate test-only change pointing SvelteKit back at the poisoned directory
failed this assertion; the correct isolation was then restored. The browser
positive-control ban and protected no-ban assertions remain unchanged.

Local verification: 208 files / 4,064 Vitest tests passed, Svelte check had zero
errors or warnings, E2E type check and production build passed. The Chromium
case passed with dotenv present; the intentional isolation-negative probe
failed for the expected reason. The two earlier privacy/handle-log design
blockers remain unresolved. No fixes from this review have been published.
