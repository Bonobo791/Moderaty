# SQLite Runtimes & Integration

Contents: bootstrap snippet · better-sqlite3 / Node · Drizzle ORM · libSQL & Turso · Python · when SQLite is the wrong choice

## Universal connection bootstrap

Every process/thread that opens the database must run the per-connection pragmas. Bake this into a single `openDb()` function and forbid raw driver access elsewhere:

```
journal_mode=WAL (once, persists) · foreign_keys=ON · busy_timeout=5000 · synchronous=NORMAL
```

## Node: better-sqlite3 (and node:sqlite)

```js
import Database from 'better-sqlite3';
const db = new Database('app.db');
db.pragma('journal_mode = WAL');   // persists
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');
```

- better-sqlite3 is **synchronous** — this is a feature, not a flaw: no async overhead, and transactions are composable functions via `db.transaction(fn)` which handles BEGIN/COMMIT/ROLLBACK and nesting (savepoints) correctly. Use it instead of manual BEGIN strings.
- Prepared statements: prepare once at module scope, reuse — never build SQL strings per call (injection + plan recompile).
- node:sqlite (built-in, Node 22.5+) is viable for simple cases; better-sqlite3 still wins on API maturity.
- One better-sqlite3 instance per process per file. In serverless/Next.js, guard against multiple module instances opening the same file.

## Drizzle ORM

- Drizzle maps to SQLite types well, but the ORM does **not** set pragmas for you — configure the underlying driver (better-sqlite3 or libSQL client) first, then wrap with drizzle.
- Use `integer('created_at', { mode: 'timestamp' })` for unixepoch-style columns; `mode: 'boolean'` maps to 0/1 INTEGER — add the CHECK in raw SQL migration since Drizzle won't emit it.
- Drizzle's `.run()` vs `.all()` vs `.get()` — pick deliberately; `.all()` on unbounded queries materializes everything in memory.
- Migrations: `drizzle-kit generate` then **read the SQL** before applying (see migrations reference); `push` is prototyping-only.
- Relations in Drizzle are query-time conveniences — actual FK constraints must exist in the DDL with `references()`, and enforcement still depends on `PRAGMA foreign_keys=ON`.

## libSQL & Turso

- libSQL is a SQLite fork; Turso is hosted libSQL. Three connection modes: remote HTTP (serverless-friendly, per-request latency), remote WebSocket (long-lived), **embedded replica** (local file synced from Turso — reads are local-fast, writes go remote).
- Embedded replica is the right default for read-heavy apps; but writes still route to the primary — the single-writer rule becomes a *global* single writer. Design write paths accordingly.
- Local WAL pragmas don't apply to remote connections; Turso handles durability server-side. `foreign_keys` still needs enabling on local/embedded connections.
- D1 (Cloudflare) is similar constraints, different API: no long-lived connections, batch API for transactions.

## Python: sqlite3 stdlib

```python
import sqlite3
con = sqlite3.connect('app.db', isolation_level=None)  # autocommit; manage txns explicitly
con.execute('PRAGMA journal_mode=WAL')
con.execute('PRAGMA foreign_keys=ON')
con.execute('PRAGMA busy_timeout=5000')
```

- Python ≤ 3.11 defaults to implicit-transaction weirdness (`isolation_level=''` auto-begins before DML). Prefer `isolation_level=None` + explicit `BEGIN`/`COMMIT`, or Python 3.12+ `autocommit=False` semantics.
- `with con:` commits/rolls back but does NOT close — a common misconception.
- Check `sqlite3.sqlite_version` — OS Python bundles old SQLite (macOS especially); STRICT tables need 3.37+, DROP COLUMN 3.35+, jsonb 3.45+.
- Threads: `check_same_thread=False` + your own write lock, or one connection per thread.

## When SQLite is the wrong choice — say so

Recommend Postgres instead when: multiple app servers must write concurrently (serverless fleets without a write funnel), write throughput exceeds one writer (~thousands of commits/sec sustained), you need row-level security/roles, or the dataset won't fit one disk. For single-server apps, embedded tools, CLIs, edge replicas, and most SaaS under moderate write load, SQLite is the *correct* engineering choice, not a compromise.
