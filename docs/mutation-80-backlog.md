<!--
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
-->

# Mutation 80% Backlog

Living tracker for the push to an **overall mutation score ≥ 80%** across the
mutate scope (`stryker.config.json` `mutate` globs). Agreed with the
maintainer:

- **Measure:** overall score ≥ 80%, with per-module tiers — 80–90% on critical
  paths (pipeline, tenancy/session/org, crypto, rules, youtube, cron/deletion);
  pure plumbing may stay lower. Not a strict per-file floor.
- **CI:** report-only. `thresholds.break` remains a deferred,
  maintainer-approved step and is NOT wired by this work.
- **Equivalents:** justified equivalent-mutant exclusions are acceptable, each
  with a one-line justification in `stryker.config.json`, verified by hand.

## Baseline (2026-08-05, branch `mt-80-baseline`, commit `2d397ae`)

Full run: `npx stryker run --ignoreStatic` (6m54s, config with
`coverageAnalysis: perTest`, `incremental`, `ignoreStatic: true`).

| Metric | Count |
|---|---|
| Killed | 2361 |
| Timeout (detected) | 6 |
| Survived | 886 |
| No coverage | 222 |
| Ignored | 422 |
| **Valid mutants** | **3253** |
| **Mutation score** | **72.76%** |
| **Net kills needed for 80%** | **236** |

Ignored mutants include the static mutants suppressed by `ignoreStatic` and the
fully-ignored landing content modules (`src/lib/landing/legal.ts`,
`faq.ts`, `plans.ts`, `pricing-faq.ts` — pure copy/data, excluded by policy).

## Batch plan

| Batch | Branch | Files | Survivors+NoCov | Status |
|---|---|---|---|---|
| A | `mt-80-schema` | `src/lib/server/db/schema.ts` | 170+0 | pending |
| B | `mt-80-auth` | `google.ts`, auth `login/callback/+server.ts`, auth `callback/+server.ts`, `oauthState.ts`, `channelConnect.ts`, `legal.ts` | 235+34 | pending |
| C | `mt-80-moderation` | `pipeline.ts`, `rules.ts`, `youtube.ts`, `moderation.ts`, `tone.ts` | 236+65 | pending |
| D | `mt-80-tenancy-routes` | `org.ts`, `deletion.ts`, `session.ts`, `crypto.ts`, `ownership.ts`, `hooks.server.ts`, `db/index.ts`, `db/migrationTestUtils.ts`, dashboard/org/queue/log/rules/consent/connect-channel page servers, `api/cron/+server.ts`, `org/switch/+server.ts`, `invite/[token]/+page.server.ts`, `logout/+page.server.ts`, `(app)/+layout.server.ts` | ~200+50 | pending |
| E | `mt-80-plumbing` | `http.ts`, `consentText.ts`, `migrationGuard.ts`, `testdb.ts`, `testcookies.ts`, `relative-time.ts`, landing `links.ts`/`json-ld.ts`/`queue-script.ts`, `api/health/+server.ts`, auth `+server.ts` pair, `login/+page.server.ts`, `auto-refresh.svelte.ts` | ~75+45 | pending |
| Final | `mt-80-final` | full re-baseline, this doc updated, AGENTS.md role section updated | — | pending |

Batch A alone (schema.ts, 170 valid survivors) is worth ~5 points of overall
score if killed or excluded with justification. Batches are ordered by
leverage; each is one PR with a full triage of its survivors.

## Per-file baseline

Sorted by survived + no-coverage, descending. `Score` = detected / valid.

| File | Mutants | Killed | Survived | NoCov | Timeout | Ignored | Score |
|---|---|---|---|---|---|---|---|
| `src/lib/server/db/schema.ts` | 170 | 0 | 170 | 0 | 0 | 0 | 0.0% |
| `src/lib/server/youtube.ts` | 286 | 171 | 78 | 35 | 1 | 1 | 68.8% |
| `src/lib/server/pipeline.ts` | 452 | 352 | 77 | 21 | 2 | 0 | 82.1% |
| `src/lib/server/org.ts` | 331 | 268 | 51 | 8 | 0 | 4 | 84.0% |
| `src/lib/server/rules.ts` | 218 | 134 | 48 | 25 | 2 | 9 | 73.9% |
| `src/lib/server/channelConnect.ts` | 115 | 58 | 42 | 12 | 0 | 3 | 58.0% |
| `src/routes/api/auth/google/login/callback/+server.ts` | 100 | 55 | 41 | 4 | 0 | 0 | 57.3% |
| `src/lib/server/legal.ts` | 117 | 69 | 40 | 1 | 0 | 7 | 63.3% |
| `src/routes/api/auth/google/callback/+server.ts` | 122 | 78 | 36 | 8 | 0 | 0 | 68.4% |
| `src/lib/server/google.ts` | 83 | 39 | 35 | 9 | 0 | 0 | 52.7% |
| `src/routes/(app)/channels/[id]/queue/+page.server.ts` | 115 | 76 | 31 | 7 | 0 | 1 | 71.0% |
| `src/routes/(app)/dashboard/+page.server.ts` | 135 | 101 | 28 | 5 | 0 | 1 | 78.3% |
| `src/lib/server/http.ts` | 101 | 71 | 11 | 18 | 1 | 0 | 86.7% |
| `src/lib/server/moderation.ts` | 58 | 34 | 20 | 4 | 0 | 0 | 63.0% |
| `src/routes/(app)/org/+page.server.ts` | 90 | 66 | 17 | 6 | 0 | 1 | 79.5% |
| `src/lib/server/deletion.ts` | 113 | 88 | 16 | 3 | 0 | 6 | 84.6% |
| `src/lib/server/tone.ts` | 51 | 37 | 13 | 1 | 0 | 0 | 74.0% |
| `src/routes/(app)/channels/[id]/log/+page.server.ts` | 118 | 102 | 13 | 2 | 0 | 1 | 88.7% |
| `src/routes/api/cron/+server.ts` | 74 | 56 | 12 | 3 | 0 | 3 | 82.4% |
| `src/routes/connect-channel/+page.server.ts` | 46 | 34 | 11 | 0 | 0 | 1 | 75.6% |
| `src/routes/consent/+page.server.ts` | 91 | 75 | 11 | 4 | 0 | 1 | 87.2% |
| `src/lib/server/db/migrationTestUtils.ts` | 30 | 19 | 10 | 0 | 0 | 1 | 65.5% |
| `src/lib/server/session.ts` | 67 | 52 | 9 | 0 | 0 | 6 | 85.2% |
| `src/lib/server/oauthState.ts` | 39 | 27 | 8 | 3 | 0 | 1 | 77.1% |
| `src/lib/server/db/index.ts` | 33 | 25 | 8 | 0 | 0 | 0 | 75.8% |
| `src/lib/consentText.ts` | 30 | 11 | 7 | 2 | 0 | 10 | 61.1% |
| `src/hooks.server.ts` | 28 | 22 | 6 | 0 | 0 | 0 | 78.6% |
| `src/routes/(app)/channels/[id]/rules/+page.server.ts` | 49 | 25 | 6 | 17 | 0 | 1 | 80.6% |
| `src/lib/server/migrationGuard.ts` | 16 | 13 | 3 | 0 | 0 | 0 | 81.3% |
| `src/lib/server/crypto.ts` | 18 | 14 | 3 | 1 | 0 | 0 | 82.4% |
| `src/lib/server/testdb.ts` | 54 | 22 | 3 | 1 | 0 | 28 | 88.0% |
| `src/routes/api/auth/google/+server.ts` | 18 | 14 | 3 | 1 | 0 | 0 | 82.4% |
| `src/routes/api/auth/google/login/+server.ts` | 16 | 12 | 3 | 1 | 0 | 0 | 80.0% |
| `src/lib/server/testcookies.ts` | 13 | 10 | 3 | 0 | 0 | 0 | 76.9% |
| `src/lib/relative-time.ts` | 53 | 46 | 2 | 0 | 0 | 5 | 95.8% |
| `src/routes/invite/[token]/+page.server.ts` | 16 | 13 | 2 | 0 | 0 | 1 | 86.7% |
| `src/routes/(app)/org/switch/+server.ts` | 13 | 11 | 2 | 0 | 0 | 0 | 84.6% |
| `src/routes/api/health/+server.ts` | 8 | 6 | 2 | 0 | 0 | 0 | 75.0% |
| `src/lib/landing/queue-script.ts` | 65 | 19 | 1 | 0 | 0 | 45 | 95.0% |
| `src/lib/landing/json-ld.ts` | 6 | 5 | 1 | 0 | 0 | 0 | 83.3% |
| `src/lib/server/ownership.ts` | 6 | 5 | 1 | 0 | 0 | 0 | 83.3% |
| `src/routes/(app)/+layout.server.ts` | 17 | 16 | 1 | 0 | 0 | 0 | 94.1% |
| `src/routes/logout/+page.server.ts` | 19 | 10 | 1 | 7 | 0 | 1 | 90.9% |
| `src/lib/landing/links.ts` | 5 | 0 | 0 | 5 | 0 | 0 | — |
| `src/lib/auto-refresh.svelte.ts` | 4 | 0 | 0 | 4 | 0 | 0 | — |
| `src/routes/login/+page.server.ts` | 4 | 0 | 0 | 4 | 0 | 0 | — |
| `src/lib/landing/legal.ts` | 201 | 0 | 0 | 0 | 0 | 201 | — |
| `src/lib/landing/faq.ts` | 28 | 0 | 0 | 0 | 0 | 28 | — |
| `src/lib/landing/plans.ts` | 33 | 0 | 0 | 0 | 0 | 33 | — |
| `src/lib/landing/pricing-faq.ts` | 22 | 0 | 0 | 0 | 0 | 22 | — |

## Triage log

Per-batch survivor triage (genuine gap → kill test; equivalent → exclusion +
justification; no-coverage → coverage test) is recorded here as batches land.

_(empty — Batch A not started)_

## Working rules for every batch

- One branch per batch from up-to-date `main`, own worktree; never develop on
  the default branch.
- Never hand-edit source to simulate a mutant; a kill is proven only by a
  survived→killed flip on a scoped re-run.
- Every behavior test must fail under its mutant; equivalents are excluded
  with justification, never tested.
- Scoped runs always pass `--ignoreStatic` explicitly and run from a worktree
  that has `npx svelte-kit sync` done.
- No PR opens while `npm run test` / `npm run check` / codacy are red.
