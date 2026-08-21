# Surviving-Mutant Triage

<!--
Moderaty — YouTube Comment Auto-Moderation Tool
Copyright (C) 2026 Andrew Philip Weilbacher

Licensed under the PolyForm Shield License 1.0.0; you may not use this file
except in compliance with the License. You may obtain a copy of the License at
<https://polyformproject.org/licenses/shield/1.0.0>. The software is provided
"as is", without warranty or condition of any kind, express or implied. See the
License for the specific language governing permissions and limitations under
the License. A copy of the License is included in the LICENSE file at the
repository root.

Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
-->

Contents: classification flow · equivalent-mutant heuristics · operator-to-gap map · priority tiers · kill-test recipe · when to accept a survivor.

## Classification flow

For each surviving mutant, in order:

1. **No coverage?** If the tool reports the line is never executed, the mutant is a coverage gap, not an assertion gap — add any behavior test that reaches it, or remove the file from the mutate scope.
2. **Equivalent?** Does the mutation truly change observable behavior for *every* reachable input? If not, mark it equivalent (tool pragma/ignore list) and exclude it from the score with a one-line justification. Never write a test for an equivalent mutant — it can only be satisfied by asserting implementation details.
3. **Genuine gap.** Classify by what the mutation attacked (operator-to-gap map below), then decide priority.

## Equivalent-mutant heuristics

Common shapes of unkillable mutants:

- Rewritten bounds that are unreachable: loop condition `i < n` where `i == n` never occurs → `i <= n` mutant is equivalent.
- Constants equal in context: mutating `0` → `1` in an initializer that is always overwritten before read.
- Dead code paths: the mutated branch is unreachable given invariants enforced elsewhere (e.g. a guard clause upstream).
- Pure-performance behavior: cache management, `break`→`continue` where both are correct but one is slower. Behavior-identical, timing-different.
- Logging/observability text: message content, log levels, metric labels — usually no behavioral assertion exists *and none should*; exclude instead of testing.
- Symmetric operations: `a.union(b)` vs `b.union(a)` where the result is order-independent.

Expect a meaningful share of survivors in a mature triage to be equivalent — a rough working estimate is 15–25%, highly dependent on the operator set and codebase. Flag them in the tool's config (mutmut `# pragma: no mutate`, Stryker `mutator.excludedMutations` or per-file ignores, PIT `<excludedMutations>`, cargo-mutants `#[mutants::skip]`) with a reason, so they never pollute the score again.

## Operator-to-gap map

| Mutation observed | Missing test |
|---|---|
| `>` ↔ `>=`, `<` ↔ `<=` | Boundary value test (the exact edge input) |
| `&&` ↔ `||` | One case per branch of the compound condition |
| `!cond` / removed negation | A case where the condition is false |
| `+` ↔ `-`, `*` ↔ `/` | Assertion on a computed value, not just non-null |
| Return `null` / `""` / `0` / empty collection | Assertion on the return value's content |
| Deleted method call | Assertion on that call's side effect (mock verification or state check) |
| `true` ↔ `false` return | Both polarities exercised with observable difference |
| Integer literal ±1 | Off-by-one probe: first/last element, empty vs single-item |
| `break` ↔ `continue` | Multi-iteration case where early exit changes the result |
| Removed `else` branch | Input that routes into the `else` |

## Priority tiers

Kill first (high business risk, usually easy kills):

1. Input validation — boundaries, null/empty, type coercion.
2. Business rules — pricing, eligibility, state machines, quota/credit arithmetic.
3. Error classification — status codes, error types, retry/abort decisions.
4. Security-sensitive paths — authn/authz checks, sanitization, token/session handling, rate limits.

Kill when practical:

5. Data transformations for API responses — mapping, aggregation, rounding.
6. Conditional routing — feature flags, tenant/partner-specific logic.

Accept or exclude (don't write tests):

7. Logging format, dashboard cosmetics, metric labels.
8. Configuration defaults (ports, timeouts, buffer sizes) — cover at integration level if at all.
9. Equivalent mutants (after flagging).

## Kill-test recipe

For one surviving mutant:

1. Read the mutant's diff (`mutmut show N`, Stryker HTML report, `mutants.out/diff/`, PIT survivor tab).
2. Construct the *minimal* input where original and mutant diverge — usually the boundary value.
3. Write a test that asserts the original behavior on that input.
4. Verify both directions: test **passes on original**, **fails under the mutant** (apply the mutant with the tool, run just that test, revert).
5. Re-run the tool scoped to that mutant to register the kill.
6. Generalize opportunistically: the same boundary usually protects adjacent lines — parametrize the test across the neighboring edge values.

## When to accept a survivor

Accept, flag, and move on when the mutant is: equivalent (flag it), in tier 7–9 code (exclude from scope), or the kill cost exceeds the risk (e.g. requires a heavyweight integration rig to detect a cosmetic difference in a low-traffic path). Record accepted survivors with a one-line rationale in the tool config or a comment — an unexamined survivor list is noise; an examined one is a decision log.
