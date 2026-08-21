# Model-Based Testing with fc.commands

For stateful systems, single calls aren't the interesting space — **sequences** are.
Model-based testing generates random sequences of operations ("commands"), applies each to
both a simplified model and the real system, and asserts they never diverge. It finds bugs
like "delete while write in flight", "second migrate corrupts checkpoint", "suspend tenant
mid-batch" — bugs that need a specific interleaving no human writes a test for.

## Contents

- The pattern (model, command, runner)
- Full example
- Designing the model (and what NOT to do)
- Runners: modelRun / asyncModelRun / scheduledModelRun
- Generating commands and sizing sequences
- Replaying failures: replayPath
- Pinning known-bad sequences as regression tests

## The pattern

Three pieces:

1. **Model** — a drastically simplified version of the system (a counter, a Map, a set of
   expected rows). It exists to answer "what should be true now?" cheaply.
2. **Commands** — one class per operation: `check(model)` (is this legal now?), `run(model,
   real)` (do it on both, assert consistency), `toString()` (readable failure reports).
3. **Runner** — executes a generated command sequence against a fresh model+system pair.

## Full example

```ts
import fc from 'fast-check';

type Model = { size: number };

class PushCommand implements fc.Command<Model, List> {
	constructor(readonly value: number) {}
	check = (m: Readonly<Model>) => true;
	run(m: Model, r: List): void {
		r.push(this.value);
		++m.num; // wait — model updated AFTER system, and only on success
	}
	toString = () => `push(${this.value})`;
}

class PopCommand implements fc.Command<Model, List> {
	check = (m: Readonly<Model>) => m.num > 0; // guards keep sequences legal
	run(m: Model, r: List): void {
		expect(typeof r.pop()).toBe('number');
		--m.num;
	}
	toString = () => 'pop';
}

const allCommands = [
	fc.integer().map((v) => new PushCommand(v)),
	fc.constant(new PopCommand())
];

test('list behaves like a counter model under any operation sequence', () => {
	fc.assert(
		fc.property(fc.commands(allCommands, { size: '+1' }), (cmds) => {
			const s = () => ({ model: { num: 0 }, real: new List() });
			fc.modelRun(s, cmds);
		})
	);
});
```

For a DB-backed system, `real` is a thin client over the real code paths and the model is
a `Map` of expected state; `run` asserts the system's reads match the model after each
command — not just at the end. Per-command assertion is what shrinks a 40-step failure to
the 3 steps that matter.

## Designing the model (and what NOT to do)

- **Simplify aggressively.** The model tracks *one* concern (count, ownership, lifecycle
  state) — not the whole system. One property suite per concern beats one god-model.
- **Never mirror the implementation.** A model that re-implements the logic compares the
  code to itself. If writing the model requires reading the system's source, you have the
  wrong model.
- **Derive parameters at run time, not generation time.** A command "read comment N" should
  store `N` and resolve `ids[N % ids.length]` in `run()` (with `check` ensuring ids is
  non-empty) — generated ids would dangle after shrinking. Improve `toString()` to print
  the resolved value.
- **Update the model only after the system call succeeds** — a throwing system call must
  leave model and system consistent (assert the error contract, then mirror the failure in
  the model only if the system really changed state).
- **Reset state per run.** The `s = () => ({ model, real })` setup must produce a pristine
  system (fresh in-memory db, wiped tables) — sequence N must not see sequence N-1.

## Runners

| Runner | Use when |
|---|---|
| `fc.modelRun(setup, cmds)` | synchronous commands |
| `await fc.asyncModelRun(setup, cmds)` | async commands (DB, HTTP) — implement `fc.AsyncCommand` |
| `await fc.scheduledModelRun(s, cmds, scheduler)` | async commands whose interleavings matter — pair with `fc.scheduler()` inside the property; see race-conditions.md |

## Generating commands and sizing sequences

```ts
fc.commands(allCommands, { size: 'small' })   // 0–10 commands
fc.commands(allCommands, { size: '+1' })      // one size class above default
fc.commands(allCommands, { maxCommands: 200 }) // explicit cap
```

`commands(...)` is not just `array(oneof(...))` — it shrinks *executed* commands (guarded
out commands are dropped), which is what makes counterexample sequences readable.
Realistic DB integration runs are slow: `numRuns: 100` × `size: 'small'` ≈ 10 s is a sane
PR gate; scale up in nightly jobs.

## Replaying failures: replayPath

Command failures print three coordinates:

```
{ seed: 670108017, path: "96:5", endOnFailure: true }
Counterexample: [PlayToken[0],NewGame,Refresh /*replayPath="AAAAABAAE:VF"*/]
```

Replay needs ALL of them:

```ts
fc.assert(
	fc.property(
		fc.commands(allCommands, { replayPath: 'AAAAABAAE:VF' }),
		(cmds) => fc.modelRun(s, cmds)
	),
	{ seed: 670108017, path: '96:5', endOnFailure: true }
);
```

`replayPath` encodes which commands actually executed (vs. guarded out) so replay jumps
straight to the minimal executed sequence.

## Pinning known-bad sequences as regression tests

Keep a regression entry per historical failure — wrap the run in a helper taking
`{seed, path, replayPath}` and drive it from a table (`test.each`). Warning: pinned
seeds/paths can become un-replayable if the underlying arbitraries change (fast-check
upgrade, new command added) — treat them as best-effort regression, and always keep the
*semantic* reproduction as a normal example test when the bug class matters.
