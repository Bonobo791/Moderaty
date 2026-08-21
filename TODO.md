# TODO

Deferred product work, quality refactors, and release-step items. The
SonarQube/Codacy quality sections below reflect the state after the
2026-08-20 S3776 triage (all criticals fixed on `dev`); the analyzers
re-evaluate on the next `dev → main` merge.

## Product features

- [x] Contact page with company name and email — implemented in
      `src/routes/contact/` and covered by route/server tests.
- [ ] Add calculator to calculate costs per last 3 months of comment volume on
      homepage (the user adds their number of comments and it returns a
      projection).
- [ ] Add calculator that pulls real data from YouTube to determine costs —
      a forecast that gives a range of potential costs for the next month with
      a disclaimer that this is a 95% probability of being in the shown range.
- [x] Auto-recharge functionality and consent language — implemented in
      `src/lib/server/billing/autotopup.ts` and the Usage page.
- [x] Channel disconnect and full data removal — implemented in the channel
      detail route, not the old dashboard design location.
- [ ] Publish the Portuguese (`pt-BR`) product and legal translation with
      locale handling, deterministic formatting, and consent-version updates.
- [ ] Add Mercado Pago as a second billing provider without changing Stripe
      behavior; begin with BRL prepaid checkout and idempotent webhooks.
- [ ] Replace legal operator placeholders (`[legal name]`, CNPJ, and address)
      in Terms and Privacy before production launch.

## Quality — status after the 2026-08-20 SonarQube critical triage

**SonarQube criticals: ALL FIXED on `dev`** (verified with
`analyze_code_snippet` — 0 criticals on every production file):

- [x] `src/lib/server/rules.ts` — `duplicateAlternation` (29) + `unsafeSyntax`
      (25) → shared `scanAction()` state machine + `isBackreference` (`3c389a8`).
- [x] `src/routes/api/auth/google/callback/+server.ts` — `fetchOwnedChannels`
      (27) → `fetchChannelPage` + `collectChannelItems` (`7137003`).
- [x] `src/lib/server/stripe/webhooks.ts` — `fulfillCheckout` (38) →
      `rejectLateGrant` + `loadBundle` + `savePaymentMethod` (`ff11c09`).
- [x] `src/lib/server/pipeline.ts` — `decideNewComments` (27),
      `processOutstandingActions` (16), `runChannel` (33) → helper extraction
      (`84f3895`).
- [x] `src/routes/api/cron/+server.ts` — `GET` (53) → `authorizeCron` +
      `runSweep` + `runClaimedChannel` (`4cc7008`).
- [x] `src/lib/server/deletion.ts:147` — refactored in `4115955`.
- [x] `drizzle/*.sql` `plsql:S1192` ×2 (generated migration SQL — cannot
      define constants) — marked WONTFIX in SonarQube.
- [x] Already-fixed-on-dev items the main analysis was stale for:
      `write-commit-marker.mjs`, `pre-push-gate.mjs`, `billing/autotopup.ts`,
      google login callback, `google.ts`, `youtube.ts`.

After the next `dev → main` merge, re-check the SonarCloud quality gate
(critical count should be 0) and Codacy.

## Deferred quality refactors (low value; keep the suite green)

Test/script helpers and large test files flagged by Lizard (Codacy) nloc/ccn —
refactor only when the file is touched anyway; no security/correctness impact.

- [ ] `src/lib/server/testdb.ts` — `createTestDb` is ~198 lines (limit 100):
      split the per-table seeding helpers.
- [ ] `scripts/seed-dev.mjs` — `seedChannel` ~75 lines (limit 50).
- [ ] `src/routes/consent/consent.test.ts` — `captureAction` ~383 lines
      (test helper).
- [ ] `src/routes/connect-channel/connect-channel.test.ts` — `loadWith`
      ~109 lines (test helper).
- [ ] Large test files (Lizard file-nloc): `pipeline.test.ts` (~1905),
      `org.test.ts` (~951), `deletion.test.ts` (~1061), `youtube.test.ts`
      (~762), `pipeline.reconciliation.pbt.test.ts` (~844), `actions.test.ts`
      (~784), `billing/autotopup.test.ts` (~714). Split helpers out or accept
      the metric (tests).
- [ ] `src/lib/server/pipeline.ts:307` — SonarQube MINOR S1940: use `<=`
      instead of `!… < …` (trivial, no behavior change).

## Documentation and release readiness

- [x] Restore the Netlify/Turso/Google/cron/backup/outage runbook in
      `DEPLOY.md`.
- [x] Reconcile the dev database's historical migration hashes and verify all
      35 journal entries. Production remains human-only and must be checked
      separately.
- [ ] Mark the completed pipeline refactor and disconnect design documents as
      historical, and identify the current implementation as the source of
      truth.
- [ ] Replace the legacy greenfield instructions in
      `EXECUTION_PLAN_YouTube_Comment_Moderator.md` with a link to the current
      README, AGENTS.md, and deployment runbook.
- [ ] Triage the seven existing Svelte warnings in the UI components and
      account page.

## Codacy dashboard cleanups (settings clicks — no code)

- [ ] Delete the custom **"Enforce Access to RAC_\* Tables in SQL Queries"**
      pattern in Codacy → Code patterns (leftover from another project; the
      repo-side `.codacy.yml` Semgrep `drizzle/**` exclusion already hides the
      26 false positives).
- [ ] Mark "won't fix" (per-issue) for the remaining false positives: XSS on
      test HTML assertions, `contact.ts:285` escaped email template,
      `rules.ts:151` I6-gated `new RegExp`, package.json variant versions,
      `.agents/skills-src/*/skill_prehook.py` broad-`except`/`pass` (hooks must
      exit 0), `app.css` unknown rules, `tsconfig.json` JSONC parse artifact,
      `package-lock.json` file-length, `netlify-migrate.test.mjs` /
      `pre-push-gate.mjs` / `tonePrompt.js` "looks like JS template string".

## Operational (human, at the dev → main release)

- [ ] Apply migration **0028** (`contact_submissions_pending_email_unique`
      partial index) to the production DB per DEPLOY.md §1 — committed and
      dev-verified.
- [ ] Merge `dev → main` (batched release), then confirm SonarCloud + Codacy
      gates on the new main head.
