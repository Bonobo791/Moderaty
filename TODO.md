-Add contact page with company name and email
-Add calculator to calculate costs per last 3 months of comment volume on homepage (the user just adds their number of comments and it spits out a number)
-Add calculator that pulls real data from YouTube to determine costs - should be a forecast that gives a range of potential costs for the next month with a disclaimer that this is a 95% probability of being in the shown range
-Create auto-recharge functionality and update website language

## Codacy triage round 2026-08-20 (main-branch 111-issue list)

Re-validated the full dashboard list against `dev`:

- **Fixed on dev:** Dockerfile consecutive `RUN`s consolidated (build + prune);
  `json-ld.ts` `replaceAll` → regex replace (compat); `.codacy.yml` excludes
  `drizzle/**` from Semgrep (the RAC_\* false positives).
- **Already fixed on dev (main analysis stale):** `cron/+server.ts` non-format-
  string error log.
- **False positives (confirmed, no change):** `google.ts:54` SSRF (URL is a
  compile-time restricted endpoint union — cannot be caller-controlled);
  `moderation.ts:82` / `tone.ts:84` / `tone-eval.mjs:269` / `mailjet.ts:141`
  "JSON.stringify key ordering" (pattern misfires — no stringify-to-keys on
  those lines); `contact.ts:285` XSS (values are `escapeHtml`-escaped);
  `youtube.ts:377` SQLi (error message interpolation, not SQL); the
  `.agents/skills-src/*/skill_prehook.py` broad-`except`/`pass` (hooks must
  exit 0 — by design); `app.css` unknown rules, `tsconfig.json` JSONC parse
  artifact, `package-lock.json` file-length, `netlify-migrate.test.mjs` /
  `pre-push-gate.mjs` / `tonePrompt.js` "looks like JS template string".
- **Deferred (already listed below):** every complexity/line-count finding
  (pipeline, cron, deletion, stripe/webhooks, rules, youtube, route loaders,
  test helpers, seed-dev) — keep the suite green; refactor test-guarded.

## Deferred lint/quality refactors (Codacy/SonarCloud)

Real maintainability findings — each is a focused, test-guarded refactor (no
security/correctness impact; the suite must stay green: `npm run test` /
`npm run check` / `npm run build`). Priority = severity, then lines. State as
of the PR #130 triage (Codacy annotations on the current head).

### Critical (complexity gate failure)

- [ ] `src/routes/api/cron/+server.ts:122` — `GET`: cyclomatic still over the
      limit (was 33 → now ~17; gate limit 15). Keep extracting per-sweep
      blocks (already: sweeps, claim, channel run) until under 15.
- [ ] `src/lib/server/pipeline.ts` — `runChannel`: cyclomatic over the limit
      after the phase helpers; finish extracting claims/enforcement.

### Major

- [ ] `src/lib/server/stripe/webhooks.ts:187` — `savePaymentMethod`: 41 lines,
      cyclomatic 12 (limits 20/10). Split the PM-change-consent check from the
      update.
- [ ] `src/lib/server/pipeline.ts:897` — `finishDryRun` / `:917`
      `runEnforcement`: 5 params each (limit 4). Package trailing params.
- [ ] `src/lib/server/pipeline.ts:439` — `loadVideoContext` (22 lines) and
      `:462` `prepareDecisionBatch` (44 lines) — split the batch-prep.
- [ ] `src/lib/server/deletion.ts:162/208` — `loadMembershipSnapshot` /
      `planOrgFates`: 31 lines each (limit 20).
- [ ] `src/routes/api/auth/google/callback/+server.ts:49` —
      `fetchChannelPage`: 27 lines (limit 20).
- [ ] `src/routes/api/cron/+server.ts:84` — `runClaimedChannel`: 33 lines
      (limit 20).
- [ ] `src/routes/(app)/channels/[id]/log/+page.server.ts:55` — `load`:
      cyclomatic 20, 100 lines.
- [ ] `src/lib/server/youtube.ts:78` — `parseComment`: cyclomatic 18.
- [ ] `src/routes/(app)/channels/[id]/+page.server.ts:121` — `dryRun` action:
      cyclomatic 16, 58 lines.
- [ ] `src/lib/server/contact.ts:102` — `createOrReusePendingSubmission`:
      61 lines.
- [ ] `src/lib/server/billing/autotopup.ts` — `maybeTriggerAutoTopUp` 81 lines;
      `src/routes/(app)/usage/+page.server.ts` `load` (64) / `setAutoTopup`
      (53); `scripts/seed-dev.mjs:127` `seedChannel` (75).
- [ ] `src/lib/server/pipeline.ts` — 610 non-comment lines; consider a file
      split. Test-file lengths (pipeline.test.ts 1468, etc.) acceptable.

### Completed in PR #130 (removed from this list)

cron `GET` sweeps extraction · `fulfillCheckout` card-save split ·
`decideNewComments` options object (S107) · `deleteUserRecords` per-org helpers ·
OAuth callback channel-picker refactor · `rules` scanAction-based
`duplicateAlternation`/`unsafeSyntax`.

## Deferred design/UX decisions (review findings needing a product call)

- [ ] **Checkout fallback outcomes visible to the purchaser** (CodeAnt,
      webhooks): unknown-bundle / missing-card failures are only server-logged;
      surface an actionable outcome to the user or support flow.
- [ ] **Dry-run audit idempotency** (CodeRabbit, cron): audit rows insert
      before the continuation token persists; a crash between them duplicates
      dry-run audit rows. Fix: idempotency key on dry-run audits, or a
      transactional checkpoint spanning audit insert + token update.
- [ ] **Metadata outage vs allowlist/rules** (CodeAnt candidate, pipeline):
      currently a metadata outage queues every comment (I11, pinned). Decide
      whether allowlist/rule decisions should survive an outage (continue with
      empty tone context).

## Codacy dashboard cleanups (no code — settings clicks)

- [ ] Delete the custom **"Enforce Access to RAC_\* Tables in SQL Queries"** pattern in Codacy → Code patterns (leftover from another project; 26 false positives on drizzle migrations — repo-side guard added: `.codacy.yml` excludes `drizzle/**` from Semgrep).
- [ ] Mark "won't fix" (per-issue) for the remaining false positives: XSS on `app.test.ts` HTML assertions, `contact.ts:285` escaped email template, `rules.ts:151` I6-gated `new RegExp`, package.json variant versions, `skill_prehook.py` broad-`except`/`pass` (hooks must exit 0).
- [ ] Suppress the engine-noise findings: `app.css` "unknown rule" (`scss_no-unused-private-members`, `no-obsolete-attribute`), `tsconfig.json` JSONC parse artifact, `package-lock.json` file-length, `google.ts:54` SSRF (compile-time restricted endpoint union), `moderation.ts:82`/`tone.ts:84`/`tone-eval.mjs:269`/`mailjet.ts:141` "JSON.stringify key ordering" (pattern misfires), `youtube.ts:377` SQLi-in-error-message, `netlify-migrate.test.mjs`/`pre-push-gate.mjs`/`tonePrompt.js` "looks like JS template string" (all FPs).

## Operational (human, at the dev → main release)

- [ ] **RELEASE GATE:** before merging dev → main, verify migration **0028**
      (`contact_submissions_pending_email_unique` partial index) is applied to
      the PRODUCTION DB per DEPLOY.md §1 (query `sqlite_master` for the index,
      or check `__drizzle_migrations`). An unchecked TODO must never release a
      schema without the index.
