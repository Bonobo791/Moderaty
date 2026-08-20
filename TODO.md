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
`npm run check` / `npm run build`). Priority = severity, then lines.

### Critical

- [ ] `src/lib/server/pipeline.ts` — `runChannel`: cyclomatic still over the
      limit after the phase helpers; finish extracting claims/enforcement.

### Major

- [ ] `src/routes/(app)/channels/[id]/log/+page.server.ts:55` — `load`:
      cyclomatic 20, 100 lines. Split the query-building from the page assembly.
- [ ] `src/lib/server/youtube.ts:78` — `parseComment`: cyclomatic 18. Extract
      the per-field validators.
- [ ] `src/routes/(app)/channels/[id]/+page.server.ts:121` — `dryRun` action:
      cyclomatic 16, 58 lines.
- [ ] `src/lib/server/contact.ts:102` — `createOrReusePendingSubmission`:
      61 lines. Extract the fresh-row builder (conflict loop stays).

### Completed in PR #130 (removed from this list)

cron `GET` sweeps extraction · `fulfillCheckout` card-save split ·
`decideNewComments` options object (S107) · `deleteUserRecords` per-org helpers ·
OAuth callback channel-picker refactor · `rules` scanAction-based
`duplicateAlternation`/`unsafeSyntax`.
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
