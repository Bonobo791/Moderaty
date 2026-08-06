# Race Condition Testing with fc.scheduler

JS is single-threaded but async interleavings are nondeterministic: two in-flight promises
can resolve in either order, and code that assumes resolution order breaks in production
under load. `fc.scheduler()` generates **random orderings** of your async tasks and replays
them deterministically — turning "it raced once in prod" into a seeded, shrinkable test.

## Contents

- The recipe
- Scheduler API
- waitAll vs waitFor vs waitOne
- The act pattern (React and general contexts)
- scheduledModelRun for stateful async systems
- What this catches (and what it can't)

## The recipe

1. Wrap the test in `fc.assert(fc.asyncProperty(fc.scheduler(), async (s) => { ... }))`.
2. Replace direct calls with scheduled versions: `s.scheduleFunction(fn)` or
   `s.schedule(promise)`.
3. Fire the operations without awaiting order.
4. Release the scheduler: `await s.waitAll()` (or `waitFor`/`waitOne`).
5. Assert the invariant that must hold regardless of resolution order.

```ts
test('queue resolves in call order', async () => {
	await fc.assert(
		fc.asyncProperty(fc.scheduler(), async (s) => {
			const seen: number[] = [];
			const call = (v: number) => Promise.resolve(v);
			const queued = queue(s.scheduleFunction(call)); // order randomized by s
			const p1 = queued(1).then((v) => seen.push(v));
			const p2 = queued(2).then((v) => seen.push(v));
			await s.waitFor(Promise.all([p1, p2]));
			expect(seen).toEqual([1, 2]); // must hold for EVERY interleaving
		})
	);
});
```

A failure means: there exists an interleaving where the invariant breaks — with a seed to
replay it. A pass means: for all generated interleavings, the invariant held.

## Scheduler API

| Method | Purpose |
|---|---|
| `s.schedule(promise, label?)` | take over resolution of a promise |
| `s.scheduleFunction(fn)` | wrap a function so its results resolve under scheduler control |
| `s.scheduleSequence(seq)` | schedule steps with known *relative* order, unknown interleaving with others |
| `s.waitAll()` | run until no scheduled task remains |
| `s.waitFor(promise)` | run until the given promise settles |
| `s.waitOne()` | release exactly one pending task |
| `s.count()` / `s.pending()` | introspect scheduled work |

## waitAll vs waitFor vs waitOne

- `waitAll` — use when every scheduled task must complete (teardown, drain).
- `waitFor(promise)` — use when the assertion depends on one specific promise; avoids
  hanging on tasks that legitimately never resolve (e.g. a pending second request that the
  system correctly ignores).
- `waitOne` — use to step interleavings manually ("release A's write, then B's read").

## The act pattern (React and general contexts)

When scheduled tasks must run inside a wrapper (React's `act`, fake timers, a db
transaction), pass the wrapper at wait-time or schedule-time:

```ts
await s.waitAll(act); // wrap everything at wait level — preferred
// or per task: s.schedule(promise, label, metadata, act)
```

Do NOT bake `act` into `fc.scheduler({ act })` — manual replay via `fc.schedulerFor` forgets
it. Wait-level wrapping is replay-safe. The pattern isn't React-specific: any
context-setting wrapper (fake timers, locale, connection scoping) composes the same way.

## scheduledModelRun for stateful async systems

Combine commands and scheduling when the system is both stateful and async:

```ts
fc.asyncProperty(fc.scheduler(), fc.commands(allCommands), async (s, cmds) => {
	const setup = () => ({ model: newModel(), real: newRealSystem() });
	await fc.scheduledModelRun(setup, cmds, s);
});
```

Commands become scheduled tasks; the scheduler shuffles their async completion. This is the
tool for "reconciliation must converge no matter when the crash/retry happens" properties.

## What this catches (and what it can't)

Catches: assumed ordering (`await a; await b` where the code actually fires both), stale
closures over async gaps, check-then-act gaps in JS-level logic, queue/buffer ordering bugs,
double-resolve/double-fire.

Cannot catch: true OS-thread parallelism (none in JS), races *inside* external systems
(Postgres isolation anomalies — those need database-level tests or formal modeling), timing
bugs that require real time to pass (use fake timers under the scheduler, or accept that
some TTL bugs are example-test territory).

Determinism prerequisite: everything the property touches must resolve under the scheduler
or be mocked — a real network call inside a scheduled test reintroduces nondeterminism.
