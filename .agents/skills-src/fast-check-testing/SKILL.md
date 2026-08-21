---
name: fast-check-testing
description: >
  Property-based testing (PBT) with fast-check for TypeScript/JavaScript — turning design
  invariants into executable tests that generate their own inputs, shrink counterexamples,
  and replay deterministically. Use when writing or auditing property-based tests; building
  arbitraries (generated test data); testing stateful systems with model-based testing
  (fc.commands); hunting race conditions (fc.scheduler); deriving generators from schemas
  (zod/valibot); verifying design-level invariants that example tests and mutation testing
  cannot cover — multi-tenant isolation, idempotency, round-trips, "never crashes";
  replaying a failed seed/path; or wiring PBT into Vitest/Jest/CI. Triggers on: fast-check,
  property-based testing, PBT, arbitraries, fc.assert, shrinking, counterexample, seed
  replay, model-based testing, fc.commands, fc.scheduler, race condition test, invariant
  testing, metamorphic testing, generative testing, QuickCheck for JS.
---

# fast-check Property-Based Testing

## Mental model

An example test asserts `f(x) == y` for inputs the author imagined. A property test asserts
`∀ x ∈ Domain: P(x)` and lets the framework generate hundreds of inputs — including empty
strings, `0`, `-0`, `NaN`, `undefined`, invalid dates, prototype-less objects, huge arrays —
then **shrink** any failure to a minimal counterexample. fast-check runs are deterministic:
every failure prints `seed` + `path` for exact replay.

The creative burden shifts from *imagining inputs* to *imagining invariants*. A property that
re-states the implementation is worthless; a property that states a **relationship**
(round-trip, idempotence, isolation, conservation) cannot mirror the code by construction.

Where it sits in a verification stack:

| Layer | Tool | Proves |
|---|---|---|
| Local correctness | Unit tests + mutation testing (Stryker) | A flipped operator / wrong constant is caught |
| Design invariants | **fast-check** | Isolation, idempotency, invariants hold across generated inputs and operation sequences |
| The model itself | Formal modeling (Alloy/TLA+) | The design is right before code exists |

## Setup

```bash
npm install --save-dev fast-check        # v4.x — ESM, Node 20+
```

Vitest (no connector needed):

```ts
import fc from 'fast-check';
import { expect, test } from 'vitest';

test('round-trip: parse(format(x)) === x', () => {
	fc.assert(
		fc.property(fc.integer(), (n) => {
			expect(parse(serialize(n))).toBe(n);
		})
	);
});
```

Connector packages (`@fast-check/vitest`, `@fast-check/jest`) add `test.prop(...)` sugar and
auto-timeout alignment — optional, see references/runner-and-ci.md.

## The core workflow

1. **Pick the target.** Best ROI: serialization boundaries, validation/parsing, state
   machines, authz/isolation checks, retry/reconciliation logic, crypto round-trips,
   anything with a `WHERE tenant_id = ?`-style scoping rule.
2. **Find the property, not the input.** Use the pattern catalog in
   references/property-patterns.md. If you can only think of examples, you haven't found the
   property yet.
3. **Build the arbitrary.** Constrain *by construction* (parameters, `map`, `chain`) rather
   than by rejection (`filter`, `fc.pre`). See references/arbitraries-cookbook.md.
4. **Assert.** `fc.assert(fc.property(...))` sync, `fc.asyncProperty` for async. Keep
   `numRuns` default (100) locally; scale up in CI burn-in jobs.
5. **On failure:** copy the printed `seed`/`path` (and `replayPath` for commands) into a
   replay run, shrink, then convert the minimal counterexample into a permanent regression —
   either an `examples:` entry or a plain example test. Never delete a failing property
   because it's "flaky"; a seed makes it deterministic.
6. **State or concurrency involved?** Switch to model-based testing
   (references/model-based-testing.md) or the scheduler (references/race-conditions.md).

## Quick patterns

```ts
// Round-trip (inverse) — parse/stringify, encrypt/decrypt, encode/decode
fc.assert(fc.property(fc.string(), (s) => decode(encode(s)) === s));

// Idempotence — applying twice = applying once (ingest, sync, migrations)
fc.assert(fc.property(itemsArb, (items) => {
	apply(store, items); const once = snapshot(store);
	apply(store, items); const twice = snapshot(store);
	expect(twice).toEqual(once);
}));

// Never crashes — fuzz the boundary; item-level garbage is skipped, not fatal
fc.assert(fc.property(fc.anything(), (junk) => {
	expect(() => handleItem(junk)).not.toThrow();
}));

// Invariant / conservation — count, length, balance never changes
fc.assert(fc.property(fc.array(fc.integer()), (xs) => {
	expect(sort(xs).length).toBe(xs.length);
}));

// Isolation — no generated access from A ever sees B's data
fc.assert(fc.asyncProperty(usersArb, resourcesArb, queryArb, async (users, resources, q) => {
	const result = await runAs(users.a, q);
	expect(result.every((r) => r.ownerId === users.a.id)).toBe(true);
}));
```

## Reading failures

```
Property failed after 12 tests
{ seed: -476812589, path: "11:3:2", endOnFailure: true }
Counterexample: [""]
```

- `seed` + `path` replay exactly: `fc.assert(prop, { seed: -476812589, path: '11:3:2', endOnFailure: true })`.
- `Counterexample` is already shrunk — it is the *minimal* failing input. Add it to
  `examples: [[""]]` so it runs on every future execution even with a different seed.
- `fc.commands` failures additionally print `replayPath` — all three are needed to replay
  (references/model-based-testing.md).

## References

| File | Read when |
|---|---|
| references/property-patterns.md | You have code but don't know what property to write — pattern catalog (oracle, inverse, idempotence, invariant, metamorphic, fuzzing, business-rule-as-property) |
| references/arbitraries-cookbook.md | Building generators: core arbitraries, composition, constraining by construction, entityGraph relational data, sizing, avoiding filter/fc.pre traps |
| references/model-based-testing.md | Stateful systems: fc.commands, model vs system, modelRun/asyncModelRun/scheduledModelRun, replayPath, sequence sizing |
| references/race-conditions.md | Async interleavings: fc.scheduler, scheduleFunction, waitAll/waitFor, act pattern, scheduledModelRun |
| references/runner-and-ci.md | Runner parameters (numRuns/seed/path/examples/verbose), configureGlobal, @fast-check/vitest & @fast-check/jest, fuzzing mode, CI burn-in strategy, replay discipline |
| references/moderaty-context.md | Working in the Moderaty repo (SvelteKit + drizzle + Turso/libSQL + Vitest + Stryker): approved-deps gate, testdb harness, property catalog mapped to the repo's I1–I13 invariants, tenant-isolation properties, Stryker interplay |

## Non-negotiables

1. **A property that cannot fail is worse than no property.** Sanity-check new properties by
   deliberately breaking the code once (mentally or by hand) and watching them go red — the
   same discipline as mutation-testing kill tests.
2. **Never assert implementation details.** Properties state relationships between inputs
   and outputs. If the property dies on a legitimate refactor, it was asserting the
   implementation.
3. **Generate hostile data, not just valid data.** fast-check's defaults are deliberately
   mean (v4: invalid dates, prototype-less objects). Don't narrow arbitraries to the happy
   path unless the property is explicitly about validated input.
4. **Constrain by construction; avoid `.filter` and `fc.pre` for anything that rejects >
   ~10% of values** — rejection sampling skews distribution toward small values and can hit
   `maxSkipsPerRun`. Details in references/arbitraries-cookbook.md.
5. **Every CI failure must be replayable.** Record seed/path in the failure log (default
   behavior), and convert counterexamples into `examples:` or standalone tests.
6. **Determinism is a prerequisite.** Freeze clocks, seed randomness, mock the network
   *outside* the property (generated inputs inside). A property over non-deterministic
   dependencies is a flaky test with extra steps.
7. **Properties complement, not replace.** Keep example tests for explicit contract values
   (`expect(header).toBe('deleted:<id>')`); use properties for the space around them. Keep
   mutation testing for local correctness — PBT does not kill point mutants reliably.

## Version notes (fast-check v4, current line)

- Unified string arbitrary: `fc.string()` replaces the old char/string family; use
  `fc.stringMatching(regex)` for pattern-constrained text.
- Smarter defaults: `fc.date()` may generate invalid dates; `fc.object()`/`fc.anything()`
  may produce prototype-less objects. Narrow explicitly when the contract requires valid ones.
- `fc.entityGraph` (≥ 4.5) generates relational data with links, arity, uniqueness and
  inverse relations — ideal for org/user/resource graphs. See arbitraries-cookbook.md.
- `fc.chainUntil` (≥ 4.8) for iterative chaining.
- v3 → v4 migration notes and per-release changes: https://fast-check.dev/blog/
