# Property Patterns — How to Find the Property

The hard part of PBT is never the API; it's finding the invariant. This catalog is ordered
by how often each pattern pays off in real codebases. Run down the list against the unit
under test and ask each question out loud.

## Contents

- Oracle (reference implementation)
- Inverse / round-trip
- Idempotence
- Invariant / conservation
- Metamorphic relations
- Fuzzing ("never crashes, never corrupts")
- Different paths, same destination (commutativity)
- Business rule as property
- State machine invariants
- Isolation / scoping
- Anti-patterns

## Oracle (reference implementation)

*Question: is there a slower, dumber, obviously-correct way to compute the same thing?*

Compare the optimized/tricky implementation against a naive one written in the test:

```ts
fc.assert(fc.property(fc.array(fc.integer()), (xs) => {
	expect(quantileOptimized(xs, 0.5)).toBeCloseTo(naiveMedian(xs), 10);
}));
```

Oracles can be an older version of the function, a library, or a SQL query checked against
an in-memory re-derivation. The oracle must be *independently written* — copying the
implementation into the test tests nothing.

## Inverse / round-trip

*Question: can I undo it?*

`deserialize(serialize(x)) ≈ x`, `decrypt(encrypt(x, k), k) === x`,
`parse(render(x)) === x`. Note `≈`: define the equivalence class explicitly when
serialization is lossy (dates → ISO strings lose millisecond edge cases; floats lose
precision; key order changes). A good trick: round-trip twice and compare the serialized
forms — `serialize(parse(s))` is usually stable even when the object form is not.

## Idempotence

*Question: is doing it twice the same as doing it once?*

Essential for ingest, sync, webhook handlers, migrations, retry-driven workers:

```ts
fc.assert(fc.asyncProperty(eventsArb, async (events) => {
	await ingest(db, events); const once = await dump(db);
	await ingest(db, events); const twice = await dump(db);
	expect(twice).toEqual(once);
}));
```

`dump` must capture everything the operation is allowed to affect — counters, cursors,
derived rows — or the property silently under-tests.

## Invariant / conservation

*Question: what quantity must never change?*

Collection size under sort/map, total balance under transfers, ownership count under moves,
"every output row traces to an input row". Also *monotonicity* invariants: a checkpoint
cursor never moves backwards; a version counter never decreases.

## Metamorphic relations

*Question: if I change the input in a known way, how must the output change?*

For functions with no oracle and no inverse — scoring, ML, ranking, formatting:

- `x ≡ x' ⇒ f(x) ≈ f(x')` (irrelevant fields don't matter: renaming a label never changes
  the verdict)
- `x ≤ x' ⇒ f(x) ≤ f(x')` (more severe content scores ≥, never <)
- `f(concat(a, b))` relates to `f(a), f(b)` in a stated way (dedupe counts, distinct sets)

This is the standard escape from "the test just mirrors the implementation": the property
is a relation between runs, not a restatement of the code.

## Fuzzing ("never crashes, never corrupts")

*Question: what should happen for garbage input — and is that what happens?*

The weakest but broadest property: feed `fc.anything()` / `fc.jsonValue()` to a boundary
and assert the *error contract*: it throws a typed validation error, or it skips-and-counts,
but it never crashes the batch, never writes a partial row, never returns 5xx for a 4xx
problem. Fuzzing properties earn their keep at API boundaries, parsers, and anything
touching external data.

## Different paths, same destination (commutativity)

*Question: do independent operations commute?*

`add(a); add(b)` = `add(b); add(a)`. Applying events in any order yields the same final
set (CRDTs, dedupe, set-union semantics). Batch size must not change the result:
processing 100 items as 1×100 or 10×10 yields identical state.

## Business rule as property

*Question: can the spec sentence be quantified?*

"Users only ever see their own data" → ∀ user, ∀ query: results ⊆ user's rows.
"Nothing is stored longer than 500 chars" → ∀ input: `stored.length ≤ 500`.
"Free tier never exceeds 3 channels" → ∀ operation sequence: `channels.count ≤ 3`.
Spec sentences with "always", "never", "only", "at most" are properties wearing a disguise.

## State machine invariants

*Question: which transitions are legal, and what holds in every state?*

Per-state invariants (a `pending` row always has `pendingAction` set), transition legality
(`approved → pending` never occurs), and terminal-state absorbing behavior. For sequences
of operations, graduate to model-based testing (model-based-testing.md).

## Isolation / scoping

*Question: can actor A ever observe or mutate actor B's data?*

The multi-tenant property. Generate multiple tenants, resources, and operations; assert
every read/write stays in scope. Prefer asserting the *negative* case too: cross-tenant
access returns "not found" (never "forbidden" — existence must not leak). Generate the
tenant pair randomly so the test can't pass by only exercising a same-tenant path.

## Anti-patterns

- **Property = implementation re-typed.** `expect(f(x)).toBe(f(x))` in disguise. If writing
  the property requires reading the function body, stop — use a pattern from this catalog
  instead.
- **Tautological invariants.** `expect(result).toBeDefined()` passes on almost any garbage.
  The property must be able to fail (break the code once by hand and watch it go red).
- **Over-specific generators.** Arbitraries constrained to valid happy-path input prove the
  happy path works. Include the hostile space unless the property explicitly assumes
  validated input (and say so in the test name).
- **One giant property.** Ten small named properties beat one "everything holds" blob —
  failures name themselves.
- **Snapshot assertions inside properties.** Snapshots freeze whatever the code does today,
  including bugs; properties must be computed, not recorded.
