# Runner, Replay, and CI

## Contents

- Runner functions
- Runner parameters
- Global configuration
- Framework connectors (@fast-check/vitest, @fast-check/jest, others)
- Replay discipline
- Fuzzing mode
- CI strategy
- Interplay with mutation testing

## Runner functions

| Runner | Use |
|---|---|
| `fc.assert(property, params?)` | the default — throws on failure with seed/path + shrunk counterexample |
| `fc.check(property, params?)` | returns a `RunDetails` object instead of throwing — for custom reporters, statistics harvesting |
| `fc.sample(arb, n)` | print n generated values — design-time only, never in assertions |
| `fc.statistics(arb, classifier)` | coverage table of a generator — run once when designing an arbitrary |
| `fc.asyncProperty(...)` / `fc.asyncAssert(...)` | async predicates |

## Runner parameters

```ts
fc.assert(prop, {
	numRuns: 100,                    // default 100; raise for burn-in, lower for slow DB tests
	seed: -476812589,                // replay
	path: '11:3:2',                  // jump to the failing branch of the shrink tree
	endOnFailure: true,              // required with path for exact replay
	examples: [[''], [null]],        // always-run inputs (regression pinning)
	verbose: true,                   // log every generated value (debugging)
	interruptAfterTimeLimit: 5000,   // stop generating after ms (results still valid)
	skipAllAfterTimeLimit: 4000,     // stop skipping after ms (for fc.pre-heavy props)
	maxSkipsPerRun: 100,             // guard against over-filtering
	maxNumRuns: 1000                 // hard cap even if global says more
});
```

`numRuns` sizing: 100 (default) is a real check, not a smoke test — biased defaults hit
edge values early. 1_000+ for pre-merge burn-in of new properties; 10_000+ only in nightly
jobs or one-off local hunts.

## Global configuration

```ts
// test setup file (loaded once per process)
import fc from 'fast-check';
fc.configureGlobal({
	numRuns: process.env.CI ? 100 : 50,
	interruptAfterTimeLimit: 10_000
});
```

Burn-in knob: `numRuns: Number(process.env.FAST_CHECK_NUM_RUNS ?? 100)` in
`configureGlobal` gives `FAST_CHECK_NUM_RUNS=10000 npm test` for free. Never commit
`Number.POSITIVE_INFINITY` — infinite runs belong in dedicated local/fuzzing processes
(single-threaded JS: one infinite property starves the rest).

## Framework connectors

Connectors add `test.prop` sugar and auto-align fast-check's time limit with the runner's
test timeout. Optional — plain `fc.assert` inside `test()` works everywhere.

```ts
// @fast-check/vitest
import { test, fc } from '@fast-check/vitest';

test.prop({ a: fc.string(), b: fc.string() })('a+b contains b', ({ a, b }) => {
	expect(a + b).toContain(b);
});
```

- `@fast-check/vitest`, `@fast-check/jest`, `@fast-check/ava` — same shape.
- `test.prop({ ... })` takes a record of arbitraries (or positional args).
- Without the connector, set `interruptAfterTimeLimit` yourself to the runner's timeout
  minus slack — otherwise the runner kills a still-passing property as "timeout".

## Replay discipline

1. Failure output always includes `seed` (+ `path`, + `replayPath` for commands). CI must
   surface this line — don't swallow stderr.
2. First response to a red property: replay locally with the printed coordinates
   (`{ seed, path, endOnFailure: true }`) before changing any code. If it doesn't replay,
   you have nondeterminism in the test (clock, network, shared state) — fix THAT first.
3. Once understood: pin the counterexample permanently via `examples:` (pure values) or a
   standalone example test (when the setup is heavy). The property then guards the space;
   the example guards the known bug.
4. Seeds couple to the generator implementation. After a fast-check major upgrade or an
   arbitrary change, re-validate pinned seeds or drop them in favor of `examples:`.

## Fuzzing mode

fast-check doubles as a fuzzer: huge `numRuns` + a never-fail wrapper that reports crashes:

```ts
fc.configureGlobal({ numRuns: 1_000_000 });
fc.assert(fc.property(inputArb, fc.pre(...), (x) => safeRun(x))); // crash = bug
```

Replay/shrink a fuzz find on demand: `fc.assert(prop, { numRuns: 1, examples: [[crashingInput]] })`.
Run fuzzing in a separate process/npm script — not in the PR suite.

## CI strategy

- **PR gate**: default numRuns, properties scoped like unit tests; keep the whole PBT layer
  under ~1–2 min. DB-backed model tests: 100 runs × small sequences ≈ 10 s each — budget
  them.
- **Nightly**: `FAST_CHECK_NUM_RUNS=10000` burn-in + any fuzzing scripts. Upload failure
  artifacts (the stderr seed line is the artifact).
- **Flakiness protocol**: a property that fails on a new seed is a FINDING, not flake —
  replay it, shrink it, pin it, fix the code. "Rerun CI until green" converts properties
  back into wishes.
- **Determinism audit before trusting any PBT suite**: frozen clocks (or time as a
  generated input), no network, per-test fresh state. fast-check cannot shrink noise.

## Interplay with mutation testing

Mutation testing (Stryker et al.) proves the suite catches small local bugs; PBT proves
design invariants. They compose, with honest limits:

- A property CAN kill mutants (a flipped operator inside a round-trip fails), but that's a
  bonus, not the design goal — don't count property tests toward mutation-score targets and
  don't write them to satisfy Stryker.
- A mutant surviving inside property-covered code is a strong signal the property is
  tautological or under-constrained — triage it like any survivor.
- Both disciplines share the same root rule: a test that cannot go red is worthless.
  Verify new properties by hand-breaking the code once, exactly like a kill test.
