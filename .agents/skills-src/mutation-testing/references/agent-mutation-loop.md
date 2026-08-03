# Agent Mutation-Feedback Loop

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
-->

Contents: why mutation feedback beats coverage for AI-written tests · the loop · prompt pattern · budget and stopping rules · guardrails · manual adversarial mode.

## Why mutation feedback for AI-written tests

- LLM-generated tests cluster around the same blind spots as the same model's code — the test-homogenization trap. A green, high-coverage suite from one model is weak evidence of correctness.
- Coverage feedback ("line X uncovered") produces execution without assertion. Mutation feedback ("this exact behavioral change went unnoticed") forces discriminating assertions.
- Research support: MuTAP (Dakhel et al., 2024) augments prompts with surviving mutants and reports substantially better bug detection than coverage-guided generation; MUTGEN applies the same mutation-feedback prompting at benchmark scale; Meta's ACH pipeline (LLM fault generator + equivalent-mutant filter + test generator) runs the loop at production scale.

## The loop

1. **Generate or collect** the test suite (agent-written or human-written).
2. **Baseline**: suite green on unmutated code; deterministic (seeded randomness, frozen time, no live network). Do not proceed on a red or flaky suite.
3. **Run** the mutation tool scoped to the target module (see tools-by-language.md).
4. **Classify** every survivor: genuine gap vs equivalent vs no-coverage (see surviving-mutant-triage.md). Discard equivalents before prompting — they poison the loop.
5. **Prompt with the survivors**: for each genuine survivor, describe the mutant concretely and require a test that fails under it and passes on the original.
6. **Validate generated tests** before adding them: syntax/compile clean, passes on the original code, and (sampled) fails under its target mutant. Discard tests that only pass in both worlds — they assert nothing about the mutation.
7. **Re-run** the tool scoped to survivors; record score delta.
8. Repeat until a stopping rule fires.

## Prompt pattern for survivors

Give the model everything it needs, nothing else:

```text
The test suite misses this behavioral fault:

File: src/billing/credits.ts:42
Original:  if (balance < cost) throw new InsufficientCredits();
Mutant:    if (balance <= cost) throw new InsufficientCredits();
Mutation operator: ConditionalBoundary

Write a test that FAILS against the mutant and PASSES against the
original. Use the existing test conventions in tests/billing/. Do not
weaken or edit any existing test. Return only the new test code.
```

Batch 3–10 related survivors per prompt when they share a file; one survivor per prompt when the logic is subtle. Include the existing test file (or its most relevant test) as style context.

## Budget and stopping rules

Mutation re-runs and LLM calls both cost. Stop when any of:

- Score reaches the module's target (80–90% for critical paths; lower elsewhere).
- All remaining survivors are classified equivalent or accepted.
- Two consecutive rounds kill < ~5% of remaining survivors (diminishing returns — remaining survivors likely equivalent or require integration-level tests).
- Compute/token budget exhausted: defer remaining survivors to a tracked list with the classification attached.

Cost controls: scope to changed files, defer full-suite re-validation to the end of each round rather than after every single generated test (immediate per-test re-runs multiply LLM and tool cost for modest gain), and re-run the tool only on survivor IDs where the tool supports it (Stryker `--mutate` glob; `mutmut browse` retests individual mutants).

## Guardrails

- **Both-direction validation is non-negotiable**: a generated test must pass on the original and fail on the mutant. One-direction tests are reward hacking.
- **Don't test the implementation**: reject generated tests that pin incidental structure (exact call counts on internal helpers, private state snapshots) just to kill mutants. Assert observable behavior.
- **Never mutate to fit the tests**: if a survivor looks wrong because the *code* is buggy, that's a real bug — fix the code, then re-run. Mutation testing occasionally finds production bugs, not just test gaps. Report these prominently.
- **Score is a means, not a KPI**: a suite at 85% with behavior-level assertions beats one at 95% asserting implementation details.
- **Keep humans in the loop for threshold changes**: ratcheting a CI `break` threshold or accepting a survivor belongs in review, not in an unattended agent run.

## Manual adversarial mode (no tool available)

When no mutation tool is installed or the language lacks one, run the loop by hand:

1. Pick the 5–10 highest-risk lines in the diff (validation, arithmetic, branching).
2. Apply one mental mutation per line (operator flip, negation removal, off-by-one, deleted call).
3. For each, ask: which test fails? Name it. If none — that's a survivor; write the killing test.
4. Optionally apply the mutation physically, run the suite, confirm red, revert — a poor man's mutation run for a handful of mutants.

This covers the critical path of a PR in minutes and is the default mode for code review.
