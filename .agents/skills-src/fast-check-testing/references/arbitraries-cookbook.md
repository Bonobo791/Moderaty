# Arbitraries Cookbook

Arbitraries generate inputs AND know how to shrink them. Every composition below preserves
shrinking — that's the reason to use `map`/`chain` instead of generating then transforming.

## Contents

- Core arbitraries quick table
- Composition: map, chain, oneof, tuple, record, option
- Constrain by construction, not by rejection
- Collections: array, uniqueArray, dictionary, map, set
- Text: string, stringMatching, ulid/uuid, lorem
- Relational data: entityGraph
- Recursion: letrec
- Sizing and depth control
- fc.gen, fc.context, fc.sample, fc.statistics
- Gotchas (v4 defaults, -0, NaN, invalid dates, prototype-less objects)

## Core arbitraries quick table

| Arbitrary | Generates | Notes |
|---|---|---|
| `fc.integer({min, max})` | integers | default full 32-bit range incl. negatives, 0 |
| `fc.bigInt()` | bigints | prefer for money/id arithmetic to avoid float loss |
| `fc.float()` / `fc.double()` | floats | includes `NaN`, `±Infinity`, `-0` — narrow with `{min, max, noNaN: true, noDefaultInfinity: true}` when needed |
| `fc.string({minLength, maxLength, unit})` | any unicode string | v4 unified string arbitrary; empty string included |
| `fc.stringMatching(/regex/)` | strings matching regex | v4.6+ supports `maxLength`; unicode properties `\p{...}` supported |
| `fc.boolean()` | true/false | |
| `fc.constant(x)` / `fc.constantFrom(...xs)` | fixed values | enums, status sets |
| `fc.uuid()`, `fc.ulid()`, `fc.emailAddress()`, `fc.webUrl()` | realistic strings | biased toward valid forms |
| `fc.date({min, max, noInvalidDate: true})` | dates | v4: **invalid dates by default** — narrow explicitly |
| `fc.array(arb, {minLength, maxLength, size})` | arrays | |
| `fc.uniqueArray(arb, {selector})` | deduped arrays | selector = uniqueness key |
| `fc.record({a: arbA, b: arbB}, {requiredKeys})` | objects | `requiredKeys: []` makes every key optional |
| `fc.option(arb, {nil})` | value or null/undefined | default nil is `null` |
| `fc.oneof(a, b, ...)` / `fc.oneof({arbitrary, weight}, ...)` | union | shrinks toward earlier alternatives |
| `fc.tuple(a, b)` | fixed-shape arrays | |
| `fc.anything({maxDepth})` / `fc.jsonValue()` | arbitrary JSON-ish data | boundary fuzzing |
| `fc.func(arb)` | random functions | for callbacks |
| `fc.mapToConstant(...)` | enum from cases | compact finite sets |
| `fc.dictionary(keyArb, valueArb)` | objects with arbitrary keys | v4.4+: full property-key range |

## Composition: map, chain, oneof, tuple, record, option

```ts
// map — derive while keeping shrink: e.g. generate parts, build the email
const emailArb = fc
	.tuple(fc.stringMatching(/^[a-z]{1,10}$/), fc.constantFrom('example.com', 'test.dev'))
	.map(([user, domain]) => `${user}@${domain}`);

// chain — output of one arbitrary feeds the next (dependent generation)
const userWithPosts = fc.record({ id: fc.uuid(), name: fc.string({ maxLength: 30 }) }).chain((user) =>
	fc.array(postArb(user.id), { maxLength: 5 }).map((posts) => ({ user, posts }))
);

// chainUntil (v4.8+) — iterate until a predicate holds (e.g. keep drawing until sorted, bounded)
```

Use `chain` when later data depends on earlier data (foreign keys, "pick one of the
generated ids"). Overusing it makes shrinking less effective — prefer independent
arbitraries in one `record` when there's no real dependency.

## Constrain by construction, not by rejection

```ts
// BAD — rejects ~half of draws, skews distribution, may hit maxSkipsPerRun
const positive = fc.integer().filter((n) => n > 0);

// GOOD — constrained by construction
const positive = fc.integer({ min: 1 });

// BAD — fc.pre inside the predicate
fc.property(fc.integer(), fc.integer(), (a, b) => {
	fc.pre(b !== 0); // skips
	return div(a, b) * b === a;
});

// GOOD — generate valid inputs directly
fc.property(fc.integer(), fc.integer({ min: 1, max: 1000 }), (a, b) => ...);
```

Rule of thumb: if the constraint rejects more than ~10% of generated values, restructure
the arbitrary. If rejection is unavoidable, raise `maxSkipsPerRun` and check skip stats
with `verbose` mode. Filters also *silently drop the edge cases you most wanted* — a
`filter(x => x.length > 0)` removes the empty string from the test space entirely.

## Collections: array, uniqueArray, dictionary, map, set

```ts
fc.uniqueArray(fc.uuid(), { minLength: 2, maxLength: 10 });       // distinct ids
fc.uniqueArray(userArb, { selector: (u) => u.id });               // distinct by key
fc.dictionary(fc.string({ maxLength: 8 }), fc.integer());         // arbitrary maps as objects
```

Duplicates are the silent killer of DB-shaped tests: generating rows with non-unique
primary keys turns half your failures into constraint noise. Generate unique ids up front.

## Text: string, stringMatching, ulid/uuid

`fc.string()` hits unicode hard (surrogates, RTL marks, zero-width joiners) — exactly what
you want at input boundaries. For database-shaped data, bound length explicitly:
`fc.string({ minLength: 1, maxLength: 100 })`. Use `fc.stringMatching(/^[a-z0-9-]{3,20}$/)`
for slug-like values — pattern-constrained by construction, shrinkable, and (v4.6+)
length-capped via `maxLength` without filtering.

## Relational data: entityGraph (v4.5+)

Generate linked structures — orgs with members, channels with comments — with links that
actually point at generated entities:

```ts
const graph = fc.entityGraph(
	{ org: { name: fc.string({ maxLength: 20 }) }, user: { email: fc.emailAddress() } },
	{
		org: { members: { arity: 'many', type: 'user', strategy: 'exclusive' } },
		user: { org: { arity: '0-1', type: 'org' } }
	},
	{ unicityConstraints: { user: (u) => u.email } }
);
```

- `arity`: `'0-1'` | `'1'` | `'many'` | `'inverse'` (backlinks via `forwardRelationship`)
- `strategy`: `'successor'` (DAG, links point forward), `'exclusive'` (each target linked
  once), default (anything incl. cycles)
- `initialPoolConstraints` controls roots (e.g. single-root trees)
- Shrinking supported since v4.6.

## Recursion: letrec

For trees/ASTs/nested comments:

```ts
const { tree } = fc.letrec((tie) => ({
	tree: fc.oneof(
		{ depthSize: 'small' },
		fc.record({ value: fc.integer() }),                       // leaf
		fc.record({ value: fc.integer(), children: fc.array(tie('tree'), { maxLength: 3 }) })
	)
}));
```

## Sizing and depth control

- `size: '-1' | 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge' | '+1' | '=0.5'` — global
  size of generated collections (default grows with runs).
- `depthSize` — recursion depth for `letrec`/`anything`.
- Default bias is small-AND-large by design; don't "fix" it.

## fc.gen, fc.context, fc.sample, fc.statistics

- `fc.gen()` inside a predicate: draw extra random values mid-test (migrate fixture-style
  tests incrementally).
- `fc.context()`: attach per-run logs — `ctx.log('after step 2: ...')` shows up in the
  failure report. Invaluable for model-based debugging.
- `fc.sample(arb, 10)`: print example values while designing generators — not for assertions.
- `fc.statistics(arb, classifier)`: verify your generator actually covers the classes you
  think it does (`fc.statistics(userArb, (u) => u.role)` prints a coverage table). Run it
  once when writing the arbitrary.

## Gotchas (v4 defaults)

- **Invalid dates**: `fc.date()` generates `Invalid Date` unless `noInvalidDate: true`.
  If your code must reject invalid dates, that's a property; if it can't receive them,
  narrow the arbitrary.
- **Prototype-less objects**: `fc.object()`/`fc.anything()` may produce `Object.create(null)`
  — breaks `hasOwnProperty` calls and naive spreads. That's hostile-by-design; narrow with
  `fc.record` for structured contracts.
- **`-0`, `NaN`, `±Infinity`**: `float`/`double` include them. `Object.is` distinguishes
  `-0` from `0`; `toEqual` does not. Know which equality your property needs.
- **Shrinking loses type guarantees you add outside the arbitrary**: transformations in the
  predicate don't shrink; transformations in `map` do.
- **`fc.configureGlobal` is process-global** — set it once in test setup, never per test.
