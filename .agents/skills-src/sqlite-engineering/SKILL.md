---
name: sqlite-engineering
description: Senior-level SQLite database engineering — schema design with STRICT tables and constraints, index strategy, EXPLAIN QUERY PLAN tuning, WAL-mode concurrency, transactional DDL migrations, and runtime integration (better-sqlite3, Drizzle ORM, libSQL/Turso, Python sqlite3). Use whenever designing a new SQLite schema, reviewing or fixing slow queries, handling SQLITE_BUSY/locking errors, planning schema migrations, choosing indexes, or deciding SQLite vs client-server Postgres. Also trigger on "sqlite schema", "sqlite index", "sqlite slow", "sqlite migration", "WAL mode", "Turso", "libSQL", "better-sqlite3".
---

# SQLite Engineering

SQLite is not a "toy Postgres" — it has different strengths (zero-latency embedded reads, transactional DDL, single-file portability) and different failure modes (single writer, locking errors, silent type coercion, limited ALTER). Engineer for those explicitly.

## Non-negotiable defaults

Apply these to every new SQLite database unless a documented reason says otherwise:

```sql
PRAGMA journal_mode = WAL;        -- persists on the database file
PRAGMA foreign_keys = ON;         -- PER CONNECTION — off by default, silently ignores FK violations otherwise
PRAGMA busy_timeout = 5000;       -- PER CONNECTION — retry instead of instant SQLITE_BUSY
PRAGMA synchronous = NORMAL;      -- safe under WAL, big write speedup
```

- New tables: use `STRICT` tables (SQLite ≥ 3.37). They kill type-affinity coercion bugs at the cost of explicit typing. See [references/schema-design.md](references/schema-design.md).
- `PRAGMA foreign_keys` and `busy_timeout` are **per-connection** — set them in the connection bootstrap code of every process/thread, never assume a prior statement set them.
- One writer at a time, ever. Serialize writes through a transaction queue; readers scale freely under WAL. See [references/concurrency-wal.md](references/concurrency-wal.md).

## Engineering workflow

1. **Design** — normalize to 3NF, encode invariants as constraints (NOT NULL, UNIQUE, CHECK, FK), choose rowid vs WITHOUT ROWID deliberately. Details: [references/schema-design.md](references/schema-design.md).
2. **Build** — pick types deliberately (STRICT columns, INTEGER unixepoch or TEXT ISO-8601 for time, 0/1 CHECK for booleans). Get DDL transactional for free: wrap multi-statement changes in BEGIN/COMMIT.
3. **Tune** — never guess. Run `EXPLAIN QUERY PLAN` on every query that ships. Add composite/partial/expression indexes to match actual WHERE + ORDER BY shapes; every index taxes writes. Details: [references/indexing-tuning.md](references/indexing-tuning.md).
4. **Migrate** — ALTER TABLE is limited; use the 12-step table rebuild for anything beyond ADD/DROP/RENAME COLUMN. Migrations are **forward-only**: never edit, renumber, or delete a migration that may be applied anywhere. Version with `PRAGMA user_version` or a migrations table. Details: [references/migrations.md](references/migrations.md).
5. **Integrate** — connection bootstrap differs per runtime (better-sqlite3, Drizzle, libSQL/Turso, Python). Details: [references/runtimes.md](references/runtimes.md).

## Failure modes observed in the field

Real agent-written database code keeps failing the same review findings. Before writing migrations, backfills, cron sweeps, or flows mixing external API calls with DB transactions, read [references/field-failures.md](references/field-failures.md) — rewritten migration journals, backfills copying tombstone sentinels, unindexed sweep queries, drizzle-kit exiting 0 without applying, and non-atomic external-side-effect ordering are all covered there with fixes.

## Decision rules that override generic SQL instincts

| Generic instinct | SQLite reality |
|---|---|
| "Just ALTER the column type" | Not supported — table rebuild required. See migrations reference. |
| "Foreign keys just work" | Silently ignored until `PRAGMA foreign_keys=ON` per connection. |
| "Add connection pool" | Pointless for the writer (single-writer); use one write connection + queue, WAL handles readers. |
| "Retry is someone else's job" | SQLITE_BUSY and SQLITE_LOCKED are normal control flow — set busy_timeout AND retry with backoff. |
| "TEXT columns accept anything" | In non-STRICT tables, inserting an integer into TEXT stores an integer. Type affinity ≠ validation. |
| "Postgres query patterns transfer" | No right join (pre-3.39), no stored procedures, different window/CTE edge cases, `IS` vs `=` for NULL-safe equality. |
| "Fix the old migration file" | Applied migrations are immutable history. Add a new migration; never renumber or rewrite. |
| "Migrate command exited 0" | Not proof. Verify the schema change exists on the target DB (e.g. drizzle-kit exits 0 on unreachable DB). |
| "Do the API call, then the transaction" | External side effects can't roll back. Order deliberately and record pending work for retry. |

## Auto-loading this skill (prehook)

To make any harness inject this skill deterministically on database-flavored prompts — instead of relying on the agent choosing to load it — wire `assets/hooks/skill_prehook.py` as a UserPromptSubmit hook. Setup per harness (Claude Code, Cursor, generic): [references/prehook.md](references/prehook.md).

## Verification habit

- After creating schema: `SELECT sql FROM sqlite_master;` to confirm what was actually created.
- After adding an index: `EXPLAIN QUERY PLAN <the real query>` — confirm SEARCH, not SCAN, and no temp B-tree unless expected.
- After migrations: `PRAGMA foreign_key_check;` and `PRAGMA integrity_check;` before declaring success.
- Check the actual SQLite version (`SELECT sqlite_version();`) before using STRICT, DROP COLUMN, RIGHT JOIN, jsonb — feature availability spans 3.35–3.50+ and OS Python/Node bundles vary widely.
