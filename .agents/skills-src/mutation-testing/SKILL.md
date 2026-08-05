---
name: mutation-testing
description: 'Mutation testing engineering — verify that a test suite actually catches bugs, not just executes lines. Use when auditing or hardening test-suite quality, reviewing test coverage claims ("we have 90% coverage"), hunting surviving mutants, writing tests that kill specific mutants, setting up or configuring mutation tools (Stryker/StrykerJS/Stryker.NET, mutmut, Cosmic Ray, PIT/pitest, Infection, cargo-mutants, go-mutesting/Gremlins, mutant, muter, Mull), wiring mutation testing into CI (incremental PR runs, thresholds, --since/--in-diff), interpreting mutation scores, handling equivalent/timeout/no-coverage mutants, or closing the mutation-feedback loop on AI-generated tests. Triggers on: mutation testing, mutation score, surviving mutants, killed mutants, equivalent mutants, are my tests actually good, test suite quality, weak assertions, mutation coverage, mutant.'
---

<!--
Moderaty — YouTube Comment Auto-Moderation Tool
Copyright (C) 2026 Andrew Philip Weilbacher

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
for more details: <https://www.gnu.org/licenses/>.

Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

(Placed after the front matter, not before it: skill loaders require the
YAML front matter to start on line 1.)
-->

# Mutation Testing

## Mental model

Line/branch coverage measures which code the suite *executes*. Mutation testing measures whether the suite *fails when that code is wrong*. A mutant is a one-token change to production code (`>` → `>=`, `+` → `-`, `true` → `false`, deleted call). Run the full suite against each mutant:

- **Killed** — at least one test fails. The suite would catch this bug. Good.
- **Survived** — all tests pass despite the change. A genuine test gap or an equivalent mutant. Act on it.
- **Timed out** — mutant caused an infinite loop. Counts as killed in most tools; investigate if frequent (flaky timing or real performance sensitivity).
- **No coverage** — no test executes the mutated line. Counts as undetected; add a behavior test or exclude the file.
- **Error/unviable** — mutant does not compile or crashes setup. Excluded from the score.

Mutation score = killed / (total − equivalent). Equivalent mutants change syntax but not behavior (`i <= n-1` vs `i < n`); they can never be killed and detecting them automatically is undecidable — expect to flag them by hand. Published equivalent-mutant rates vary widely with the operator set and codebase — from under 10% to around a quarter (Yao, Harman & Jia's manual analysis of 4,181 mutants is the classic study) — so 100% is a mathematical ceiling, not a target.

## Score interpretation

| Score | Reading |
|---|---|
| < 40% | Critical gaps. Focus on validation, state transitions, error handling first. |
| 40–60% | Typical first baseline. Fix survivors in core business logic; skip cosmetics. |
| 60–75% | Solid. Approaching the practical ceiling; pursue only high-value survivors. |
| 75–85% | Strong. Most survivors are equivalent or cosmetic. |
| > 85% | Exceptional — or suspicious. Check for tests overfitted to the implementation. |

Benchmark per module, not per repo. 65% on a logging utility is fine; 65% on a payment calculation is not. Target 80–90% only on security-sensitive and money paths.

## Core workflow

1. **Baseline**: full suite green on unmutated code. Never mutation-test a red suite — results are meaningless.
2. **Scope**: pick critical business logic first (validation, pricing, authz, state machines, serialization boundaries). Exclude tests, generated code, type definitions, barrels, config defaults.
3. **Run**: use the language tool from [references/tools-by-language.md](references/tools-by-language.md). Enable per-test coverage analysis and parallelism. For PR-scale work, mutate only changed files (`--since`, `--in-diff`, or a git-diff-driven `--mutate` glob).
4. **Triage survivors** using [references/surviving-mutant-triage.md](references/surviving-mutant-triage.md): genuine gap vs equivalent vs no-coverage. Priority order: boundary conditions → missing assertions on outputs → error classification → everything else.
5. **Kill mutants**: write a test that passes on the original and fails under the exact mutation. Confirm both directions. A test written to kill one mutant that can't fail on the original is worse than useless.
6. **Re-run** scoped to survivors; confirm kills; update the threshold.
7. **Ratchet**: set the CI `break` threshold at current-score-minus-buffer and raise it over time. Never jump to a high threshold in one step — the team (or the agent harness) will route around it.

## In the Moderaty repo — Stryker runs ALL mutants

StrykerJS is the tool for every mutation run in this repo: `@stryker-mutator/core` + `@stryker-mutator/vitest-runner`, configured by `stryker.config.json` at the repo root (vitest runner, `mutate` globs covering `src/**/*.ts` minus tests/dev-seed/legal pages, `coverageAnalysis: perTest`, `incremental`, `progress`/`clear-text`/`html`/`json` reporters — the `json` report at `reports/mutation/mutation.json` is the machine-readable survivor list for the agent loop).

**Never hand-edit source to simulate a mutation as a workflow step.** Stryker applies and verifies every mutant. The both-directions discipline (passes on original, fails under mutation) is satisfied by the re-run: a kill test is proven when the mutant flips survived→killed on a scoped Stryker re-run — not by applying the mutation by hand, running vitest, and reverting. The single exception: a mutant Stryker's operator set cannot express (rare). Then, and only then, apply it by hand with the file committed, confirm red, revert immediately, and justify it in the PR.

- Fresh checkout or worktree: run `npx svelte-kit sync` first. Stryker's vitest runner needs the generated `.svelte-kit/tsconfig.json`; without it the run crashes with a rolldown "Tsconfig not found" error.
- Scoped audit: `npx stryker run --mutate "src/lib/server/<module>.ts" --ignoreStatic` (plus `--reporters clear-text` for terminal-only output).
- PR-scale: a git-diff-driven `--mutate` scope — StrykerJS has NO `--since` flag (that is Stryker.NET). Use the shared scope script (same filter as CI — CLI `--mutate` OVERRIDES the config's mutate globs): `SCOPE=$(node scripts/stryker-pr-scope.mjs)` then `npx stryker run --mutate "$SCOPE" --ignoreStatic`. An empty `$SCOPE` means no mutable src files changed — skip the run, never pass `--mutate ""`. Every CLI Stryker invocation passes `--ignoreStatic` explicitly (repo invocation policy; the config setting alone does not satisfy it).
- Repeat runs: the config's `incremental: true` already caches; `--incremental` forces it on the CLI.
- CI: none. The report-only `.github/workflows/mutation.yml` pass was removed by maintainer decision — Stryker runs are local/agent-driven. It never failed on survivors when it existed.
- Verify survivors by hand before writing kill tests — the score is a lead, not a verdict.
- Wiring a ratcheted `thresholds.break` CI gate is a separate, maintainer-approved step; do not add it ad hoc.

## Mental mutation testing (review-time reasoning)

For code review or quick reasoning about a small diff, mutate mentally: for every changed line, ask "would any test fail if I flipped this operator / deleted this call / inverted this condition?" If the answer is no for a behavior-bearing line, that is a suspected surviving mutant — do NOT reach for a hand-applied mutation to confirm it. Run `npx stryker run --mutate "<that file>"` and read the survivor report; if the line's mutant survives, write the kill test and re-run until it flips killed.

## Agent mutation-feedback loop

When generating or hardening tests with an LLM/agent (yours or a user's), surviving mutants are the highest-signal feedback available — research (MuTAP, MUTGEN, Meta's ACH) shows feeding survivors back into test generation beats coverage feedback by a wide margin, and LLM-generated suites systematically share the generator's blind spots (the test-homogenization trap). Run the closed loop in [references/agent-mutation-loop.md](references/agent-mutation-loop.md) whenever asked to "make tests better", verify AI-written tests, or use mutation testing for bug detection.

## CI strategy

- **PR gate**: mutate changed files only; target < 2–5 min. Fail the build only on *new* survivors or a `break` floor.
- **Nightly/weekly**: full sweep on main enforcing the `break` threshold globally; upload the HTML/JSON report as an artifact.
- Commit or cache the incremental state file so subsequent runs skip unchanged mutants.
- Tool-specific YAML: [references/tools-by-language.md](references/tools-by-language.md).

## Anti-patterns

- Chasing 100% or setting `break: 100` initially — impossible bar (equivalent mutants); gets the gate disabled.
- Mutating test files, generated code, migrations, or vendored code.
- Full-repo mutation run on every PR — 30-minute feedback kills adoption.
- Ignoring no-coverage mutants — they are uncovered files sitting inside the mutate scope.
- Treating score as the only quality metric; it complements review, integration, and E2E tests.
- Writing tests that assert the implementation instead of the behavior — kills mutants today, blocks refactors tomorrow.
- Flaky suites: surviving mutants then mean nothing. Stabilize determinism (seeded randomness, frozen clocks, no network) before trusting results.
- Applying a mutant to disk (mutmut `apply`) without the file committed and without reverting immediately after.
