# Transactions and Drivers

How `db.transaction` actually behaves per driver, and why "it's in a transaction" is not the same
as "it's safe." The engine-level concurrency model (single writer, WAL, busy_timeout, BEGIN
IMMEDIATE) is covered in sqlite-engineering/references/concurrency-wal.md — this file is the
Drizzle-facing half.

## Contents

- The transaction API
- Nested transactions and savepoints
- SQLite behavior config
- Driver notes and their traps
- Transaction discipline

## The transaction API

```ts
const result = await db.transaction(async (tx) => {
  await tx.update(accounts).set({ balance: sql`${accounts.balance} - 100` }).where(eq(accounts.id, from));
  await tx.update(accounts).set({ balance: sql`${accounts.balance} + 100` }).where(eq(accounts.id, to));
  return newBalance;                       // transaction resolves to the callback's return value
});
```

- **Throw (or `tx.rollback()`) → rollback; return → commit.** No manual cleanup; there is nothing
  to "remember to close."
- Use `tx`, never the outer `db`, inside the callback. One stray `db.` call escapes the transaction
  silently — it runs on another connection/statement outside your atomic unit. This is the most
  common Drizzle transaction bug. Pass `tx` down to helper functions.
- Everything you need from the transaction must come back via `return` — side effects on outer
  variables work but are a readability trap.
- External side effects (HTTP calls, emails, queue publishes) inside a transaction callback cannot
  roll back. Read from the DB inside, act on the outside world after commit — or use an outbox
  table written in the same transaction (see sqlite-engineering/references/failure-modes.md,
  "only the database is transactional").

## Nested transactions and savepoints

```ts
await db.transaction(async (tx) => {
  await tx.transaction(async (tx2) => { ... });   // becomes a SAVEPOINT
  tx2.rollback();                                  // rolls back only to the savepoint
});
```

Nested `transaction` calls map to savepoints — useful for "try this sub-operation, tolerate its
failure" logic without aborting the outer unit of work.

Dialect-specific config:

- **Postgres**: `{ isolationLevel: 'read committed' | 'repeatable read' | 'serializable' }` —
  choose deliberately for read-write invariants; the default (read committed) does not protect
  read-then-write decisions.
- **SQLite**: `{ behavior: 'deferred' | 'immediate' | 'exclusive' }` — maps to BEGIN variants.

## SQLite behavior config

```ts
await db.transaction(async (tx) => { ... }, { behavior: 'immediate' });
```

- `deferred` (default) acquires the write lock lazily on first write. A transaction that reads,
  then writes, can discover at write time that another writer got there first — and on some drivers
  that means an immediate `database is locked` error, not a wait.
- `immediate` takes the write lock at BEGIN: readers keep working (WAL), writers queue. **For any
  read-then-write transaction, use `immediate`** — it converts a mid-transaction failure into an
  ordered wait.
- `exclusive` blocks even readers in journal modes that allow them. Rarely right on WAL.

## Driver notes and their traps

| Driver | Notes |
|---|---|
| `better-sqlite3` | Synchronous, single-process, single connection — transactions are real and cheap. But it serializes nothing for you across connections/processes; "database is locked" surfaces immediately when the engine is busy. Don't run concurrent transactions on separate connections to the same file without retry logic. |
| `libsql` / Turso (`@libsql/client`) | Transactions over HTTP/WebSocket cost round trips; multi-statement atomic writes may be better as `db.batch`. Embedded replicas: writes forward to primary — latency per statement adds up, so keep transactions short. The driver's lock behavior historically throws `database is locked` immediately rather than honoring busy_timeout; retry with backoff at the call site for write contention. |
| Cloudflare D1 | **No SQL transactions over the Workers binding** — `db.transaction` fails because D1 rejects `BEGIN`. Use `db.batch` (atomic at the backend) and apply migrations via `wrangler d1 migrations apply`, never at runtime. |
| `node-postgres` / `postgres.js` | Real transactions, full isolation levels. Hold transactions briefly — each holds a pooled connection; long transactions under load = pool exhaustion. |
| Neon HTTP (`neon-http`) | Single-statement-per-request semantics: no interactive transactions in the HTTP driver; use `db.batch` or the WebSocket driver (`neon-serverless`) when you need real transactions. |

General: know whether your driver gives you a real transaction, an emulated one, or none, BEFORE
designing around `db.transaction`. The import path for programmatic migration is also
driver-specific (`drizzle-orm/<driver>/migrator`).

## Transaction discipline

1. **One write transaction touches as little as possible, for as short as possible.** SQLite has
   exactly one writer; every millisecond in your transaction is a millisecond every other writer
   waits (or errors).
2. **No awaits on the outside world inside a transaction** — no network, no user input, no slow
   computation. Gather inputs first, then transact.
3. **Reads before writes, or `immediate`** — a deferred transaction that upgrades mid-flight is a
   lock-failure lottery.
4. **Multi-row mutations are always transactional** — multi-row `values([...])` and `db.batch` are
   atomic on their own; a loop of single inserts is not unless wrapped.
5. **Retry lock errors with jittered backoff** at the boundary (and prefer fixing the cause:
   shorter transactions, `immediate` behavior, WAL mode — see concurrency-wal.md).
6. **State checks at write time, inside the transaction** — re-read the row you decided about
   (`UPDATE ... WHERE status = 'pending'` returning, then check rows affected) rather than trusting
   a read from before the transaction began. TOCTOU applies to ORM code too.
