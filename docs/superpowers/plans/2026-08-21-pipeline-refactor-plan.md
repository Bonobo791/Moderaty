# Moderaty pipeline module refactor plan

## Goal
- Split `src/lib/server/pipeline.ts` into focused modules so moderation decisions, scoring, database staging, YouTube enforcement, and run orchestration have separate change boundaries.
- Preserve the existing public import path and behavior while making the implementation and its regular test suite easier to navigate.
- Keep property-based and mutation-oriented tests intact unless an import path or fixture contract requires a minimal compatibility update.

## Assumptions / constraints
- Work directly on `dev`; do not touch `main` or production data.
- Keep `src/lib/server/pipeline.ts` as a compatibility facade that re-exports `runChannel`, `RunChannelOptions`, and `ChannelRunResult`.
- No database migration, API, webhook, billing, YouTube, dry-run, or entitlement behavior changes.
- Preserve the current bounded-run, idempotency, deadline, staging-before-remote, and dry-run invariants.
- Preserve unrelated worktree changes under `.codacy/`; stage only this plan and later pipeline refactor files.
- Do not change Stryker or Fast Check tests unless a required path/contract update cannot be avoided.

## Research (current state)
- Modules/subprojects involved:
  - Server moderation pipeline and its database, billing, AI, tone, rules, and YouTube dependencies.
  - Cron and dashboard callers that invoke `runChannel`.
  - Regular pipeline integration tests and separate property-based reconciliation tests.
- Key files/paths:
  - `src/lib/server/pipeline.ts` — currently 1,047 lines in this checkout; CodeScene's 724-line snapshot predates recent additions.
  - `src/lib/server/pipeline.test.ts` — 1,905-line integration suite covering decisions, staging, enforcement, dry-run, cursors, deadlines, and credits.
  - `src/lib/server/pipeline.pbt.test.ts` — 324 lines covering ingest idempotency and AI-failure queuing.
  - `src/lib/server/pipeline.reconciliation.pbt.test.ts` — 844 lines covering enforcement convergence, dry-run durability, and bounded cursor progress.
  - `src/routes/api/cron/+server.ts` and `src/routes/(app)/channels/[id]/+page.server.ts` — production callers.
- Entrypoints (API/UI/CLI/Jobs):
  - `GET /api/cron` invokes `runChannel` for cron work and dry-run drains.
  - The channel dashboard invokes `runChannel` for an on-demand run/preview.
- Related configs/flags:
  - `$env/dynamic/private` `DRY_RUN` controls deployment-wide dry-run behavior.
  - `RunChannelOptions.forceDryRun` can only enable dry-run; `window` requires dry-run semantics.
  - `deadline`, `maxPages`, cursor, page token, and scan cursor bound a run.
- Data models/storage touched:
  - `channels`, `comments`, `rules`, `auditLog`, `moderationActions`, `organizations`, and `creditTransactions` through Drizzle.
  - No schema changes are needed.
- Interfaces/contracts (APIs/events/IPC):
  - Preserve `runChannel(channelId, options): Promise<ChannelRunResult>`.
  - Preserve all callers' `$lib/server/pipeline` import path.
  - Preserve YouTube and scoring function signatures.
- Existing patterns to follow:
  - The prior S3776 refactor already decomposed large functions internally without changing behavior; this work moves those stable helper groups across module boundaries.
  - Server-only imports stay under `src/lib/server/`.
  - Reuse existing types and avoid duplicate test fakes or production logic.

## Analysis
### Options
1. **Focused module extraction with a compatibility facade**
   - Move the existing helper groups into `pipeline/types.ts`, `decisions.ts`, `scoring.ts`, `staging.ts`, `enforcement.ts`, and `run.ts`.
   - Keep `pipeline.ts` as a small re-export facade.
   - Strength: preserves all callers while directly reducing the hotspot's responsibility count.
   - Risk: requires explicit contracts between modules and careful handling of shared types/errors.
2. **Replace the pipeline with a new service/class abstraction**
   - Introduce a stateful pipeline service and adapt callers/tests to it.
   - Strength: could centralize dependencies.
   - Risk: larger behavioral and test-surface change; unnecessary for this refactor.
3. **Leave the file intact and suppress the CodeScene finding**
   - Strength: lowest immediate diff.
   - Risk: does not reduce change friction or ownership boundaries and would hide a real maintainability issue.

### Decision
- Chosen: **Option 1**, with the full extraction performed in this order:
  1. `enforcement.ts`
  2. `decisions.ts`
  3. `staging.ts`
  4. `scoring.ts`
  5. `run.ts` orchestration and the `pipeline.ts` facade
- Why:
  - This follows the requested risk order: YouTube/database action state is isolated first, then pure decision behavior, persistence, scoring, and finally orchestration.
  - The public function remains stable, so cron/dashboard callers and their mocks do not need a contract migration.
  - Each step can be validated independently and committed while `dev` remains releasable.

### Risks / edge cases
- Shared types can create circular imports. `types.ts` will hold public options/results plus internal `Decision`/action contracts; modules will import types only where possible.
- `ChannelDeactivatedError` must remain recognizable by orchestration after moving the active-channel guard. The class/error contract will be exported from the enforcement boundary or replaced with a stable type guard without changing catch behavior.
- Staging must continue to charge credits in the same transaction as comments/actions/audits. The extraction must not move a write across the transaction boundary.
- Enforcement must preserve claim fencing, dispatched-action verification, batch size 50, per-item delete handling, and completion auditing.
- Dry-run/window mode must continue to avoid comments, cursor, checkpoint, and YouTube writes while retaining capped audit text.
- Deadline behavior must continue to return `partial: true` without new durable writes when a boundary is reached.
- The current regular test file has a large shared fake database and hoisted mocks. Test support will be extracted once, then responsibility-specific suites will use it rather than copy the fake.
- The two Fast Check suites cover cross-module invariants; they should remain integration tests and should not be rewritten merely to match the new folder layout.

## Q&A results (captured after the session)
- Outcome/acceptance criteria:
  - Produce a plan, then implement the full staged refactor after approval.
  - Refactor the pipeline's regular test coverage along with production modules.
  - Keep behavior, public imports, and validation green.
- Scope boundaries:
  - Full extraction, not only the first enforcement move.
  - Keep `pipeline.ts` as a facade.
  - Split the regular `pipeline.test.ts` coverage by responsibility; retain PBT suites as integration coverage.
- Constraints/non-goals:
  - No feature behavior changes, schema migrations, production DB work, or unrelated `.codacy` changes.
- Known modules/paths/subprojects:
  - `src/lib/server/pipeline.ts`, its three test suites, cron, and channel dashboard callers.
- Decisions made in Q&A:
  - `1b`: create the plan, then implement after approval.
  - `2a`: retain the compatibility facade.
  - `3b`: complete the full staged extraction.
  - Refactor the test file as part of the work.
- Remaining open questions (if any):
  - None for the proposed scope; the facade and existing invariants define the compatibility boundary.

## Implementation plan
1. **Baseline and contracts**
   - Confirm the current pipeline test baseline and preserve unrelated `.codacy` files.
   - Add `pipeline/types.ts` for public run options/results and shared internal decision/action types.
   - Keep the initial facade behavior unchanged so imports remain stable.
2. **Extract enforcement**
   - Move action validation, pending-action claiming, dispatch/completion transactions, verification, YouTube batching/deletes, outstanding-action processing, active-channel checks, and auto-top-up enforcement into `pipeline/enforcement.ts`.
   - Export only the contracts needed by `run.ts` and tests.
   - Move the enforcement-focused regular tests and add direct boundary tests where existing coverage currently reaches the code only through `runChannel`.
3. **Extract decisions**
   - Move rule/allowlist precedence, AI/tone threshold decisions, AI-failure queueing, deferred decisions, and credit-budget decision contracts into `pipeline/decisions.ts`.
   - Keep deadline exceptions and safe error serialization unchanged.
   - Split decision threshold, allowlist, tone, and AI-failure tests into `pipeline/decisions.test.ts`.
4. **Extract staging**
   - Move audit/comment/action row builders, transactional staging, credit charging, and dry-run audit staging into `pipeline/staging.ts`.
   - Preserve PII retention rules, capped dry-run text, and the same transaction boundaries.
   - Move staging, audit, credit, and persistence assertions into `pipeline/staging.test.ts`.
5. **Extract scoring**
   - Move video-context loading, comment deduplication, rule preparation, credit-budget setup, parallel scoring, settled-result folding, and `decideNewComments` into `pipeline/scoring.ts`.
   - Preserve one rule compilation per run, one metadata request per batch, per-comment failure isolation, and deadline propagation.
   - Move batch preparation/scoring tests into `pipeline/scoring.test.ts`.
6. **Finish orchestration and facade**
   - Move channel loading, token refresh, page fetch, result persistence, dry-run/window finishing, and `runChannel` into `pipeline/run.ts`.
   - Reduce `pipeline.ts` to the documented re-exports.
   - Keep `pipeline.test.ts` as a small facade/orchestration contract suite and place the remaining run-flow tests in `pipeline/run.test.ts`.
   - Leave `pipeline.pbt.test.ts` and `pipeline.reconciliation.pbt.test.ts` as integration suites, changing only imports if required.
7. **Review and cleanup**
   - Remove dead imports/helpers and verify no module imports browser/client code.
   - Review module sizes and dependency direction: `run -> scoring/staging/enforcement`, `scoring -> decisions`, shared types/constants without reverse orchestration imports.
   - Run the full validation suite and inspect the final diff for unrelated changes.

## Tests to run
- Targeted tests after each extraction:
  - `npx vitest run src/lib/server/pipeline*.test.ts` (or the new `src/lib/server/pipeline/*.test.ts` paths).
- Full behavior validation:
  - `npm test`
  - `npm run check`
  - `npm run build`
- Static/diff validation:
  - `git diff --check`
  - Local Codacy analysis on changed files.
- Mutation/property constraints:
  - Do not alter Stryker or Fast Check test definitions unless a required import-path change is unavoidable.
  - If Stryker is run, use the repository-required `--ignoreStatic` flag.
