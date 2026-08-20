-Add contact page with company name and email
-Add calculator to calculate costs per last 3 months of comment volume on homepage (the user just adds their number of comments and it spits out a number)
-Add calculator that pulls real data from YouTube to determine costs - should be a forecast that gives a range of potential costs for the next month with a disclaimer that this is a 95% probability of being in the shown range
-Create auto-recharge functionality and update website language
-Add channel disconnect button and functionality

## Deferred lint/quality refactors (Codacy/SonarCloud, triaged 2026-08-19)

Real maintainability findings — each is a focused, test-guarded refactor (no
security/correctness impact; the suite must stay green: `npm run test` /
`npm run check` / `npm run build`). Priority = severity, then lines.

### Critical
- [ ] `src/routes/api/cron/+server.ts:45` — `GET` handler: cyclomatic 33, 131 lines. Extract the per-sweep blocks (consent sweep, handle sweep, deletion outbox, auto top-up, dry-run window) into helpers; the shared `deadline` must keep flowing through.
- [ ] `src/lib/server/stripe/webhooks.ts:83` — `fulfillCheckout`: cyclomatic 29, 83 lines. Split the grant/credit step from the card-save step; keep the loud-failure paths.
- [ ] `src/lib/server/pipeline.ts:420` — `decideNewComments`: cyclomatic 19, 78 lines, **10 params** (S107, limit 8). Package trailing params into an options object (pattern already used for `decide`).
- [ ] `src/lib/server/pipeline.ts:803` — `runChannel`: cyclomatic 31, 86 lines. Extract per-phase helpers (claims, decisions, staging, enforcement).
- [ ] `src/lib/server/deletion.ts:147` — `deleteUserRecords` tx callback: cyclomatic 25, 96 lines. Extract the per-org deletion helper.

### Major
- [ ] `src/routes/api/auth/google/callback/+server.ts:42` — handler cyclomatic 27. Extract token-exchange + user-creation steps.
- [ ] `src/lib/server/rules.ts:39` — `duplicateAlternation`: cyclomatic 29. Simplify the scan (it is already covered by property tests).
- [ ] `src/lib/server/rules.ts:84` — `unsafeSyntax`: cyclomatic 25. Split the backreference check from the group-stack scan.
- [ ] `src/routes/(app)/channels/[id]/log/+page.server.ts:55` — `load`: cyclomatic 20, 100 lines. Split the query-building from the page assembly.
- [ ] `src/lib/server/youtube.ts:78` — `parseComment`: cyclomatic 18. Extract the per-field validators.
- [ ] `src/routes/(app)/channels/[id]/+page.server.ts:121` — `dryRun` action: cyclomatic 16, 58 lines.
- [ ] `src/lib/server/contact.ts:102` — `createOrReusePendingSubmission`: 61 lines. Extract the fresh-row builder (conflict loop stays).

### Minor / low value (can be left)
- [ ] `src/lib/server/billing/autotopup.ts:205` — `maybeTriggerAutoTopUp`: 81 lines (cyclomatic already reduced); `src/routes/(app)/usage/+page.server.ts` `load`/`setAutoTopup` lengths; `scripts/seed-dev.mjs:127` `seedChannel` 75 lines; `src/lib/server/pipeline.ts` 610 non-comment lines (file split).
- [ ] Test-file lengths (pipeline.test.ts 1468, org.test.ts 754, etc.) — acceptable for fixture-heavy suites; split only when a test file needs a new concern.
- [ ] `Dockerfile:64` — consecutive `RUN`s (`npm prune --omit=dev`): cosmetic layer consolidation.

## Codacy dashboard cleanups (no code — settings clicks)

- [ ] Delete the custom **"Enforce Access to RAC_\* Tables in SQL Queries"** pattern in Codacy → Code patterns (leftover from another project; 26 false positives on drizzle migrations).
- [ ] Mark "won't fix" (per-issue) for the remaining false positives: XSS on `app.test.ts` HTML assertions, `contact.ts:285` escaped email template, `rules.ts:151` I6-gated `new RegExp`, package.json variant versions, `skill_prehook.py` broad-`except`/`pass` (hooks must exit 0).

## Operational (human, at the dev → main release)

- [ ] Apply migration **0028** (`contact_submissions_pending_email_unique` partial index) to the production DB per DEPLOY.md §1 — committed and dev-verified.
