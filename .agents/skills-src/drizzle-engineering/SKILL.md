---
name: drizzle-engineering
description: >
  Senior-level Drizzle ORM engineering — schema declaration, type-safe queries, transactions,
  drizzle-kit migration workflows, and production safety across PostgreSQL, MySQL, and
  SQLite/libSQL/Turso/D1 drivers. Use whenever working with Drizzle: defining pgTable/sqliteTable/mysqlTable
  schemas, columns, indexes, constraints, or relations; writing select/insert/update/delete/upsert
  queries or joins; using db.transaction, prepared statements, the relational query API
  (db.query.*), batch API, or the sql`` template operator; running drizzle-kit
  generate/migrate/push/pull/check/up/studio/export; editing drizzle.config.ts; wiring drizzle-zod
  validation; or debugging drizzle problems — N+1 queries, 'column already exists', migration drift,
  'database is locked', timestamp mode bugs, or failed rollbacks. Triggers on: drizzle, drizzle-orm,
  drizzle-kit, drizzle schema, drizzle migration, drizzle relations, onConflictDoUpdate, sql.placeholder.
---

# Drizzle Engineering

Drizzle maps TypeScript to SQL with almost no abstraction tax. That is its strength and its hazard:
**Drizzle will faithfully execute whatever you declare — including your mistakes.** It does not stop
you from pushing a destructive diff to prod, running 500 queries in a loop, or interpolating a user
string into raw SQL. This skill encodes the discipline that keeps a thin ORM safe.

## Pair with the engine skill

This skill covers the **ORM layer** — declarations, query shapes, kit workflows. It deliberately does
NOT cover engine-level rules (STRICT tables, WAL mode, PRAGMAs, lock semantics, EXPLAIN QUERY PLAN,
index selection). When the task touches SQLite/libSQL/Turso itself, load the **sqlite-engineering**
skill as well. The layers: sqlite-engineering decides *what the database should do*;
drizzle-engineering decides *how to make Drizzle do it safely*.

## Non-negotiable defaults

1. **The TypeScript schema is the source of truth.** Never hand-edit the database out of band; drift
   between schema and database corrupts every future diff. (One exception: manual reconciliation
   when recovering from a partially applied migration — follow the documented procedure in
   references/migrations-workflow.md.)
2. **`generate` for anything shared or production; `push` for local dev only.** Generated migrations
   are reviewed, committed history. `push` bypasses review and can silently produce destructive diffs.
3. **Read every generated migration before applying it.** drizzle-kit diffs snapshots, not intent.
   Renames look like drop+add. A `NOT NULL` add without default on a populated table fails at runtime,
   not at generate time.
4. **DDL goes in generated migration files; DML goes in `--custom` migration files, ordered after the
   DDL they depend on.** Never mix data backfills into auto-generated files.
5. **Destructive changes use expand-and-contract**, never drop-in-place: add new shape → migrate
   writes → backfill → migrate reads → remove old shape. See references/migrations-workflow.md.
6. **Applied migrations are immutable history.** Never edit a migration or snapshot that any
   environment has applied. Fix forward with a new migration.
7. **Every mutation that spans more than one row change is atomic.** Use `db.transaction` where the
   driver supports it; on drivers that reject SQL transactions (D1), use a single atomic statement
   or the driver's batch API (`db.batch`). A partial write is worse than no write.
8. **Never `sql.raw()` or interpolate anything user-controlled into SQL.** Values go through
   parameters; identifiers are hardcoded or allowlisted. See references/queries-performance.md.
9. **Production is written by a controlled process, not by convenience.** Migrations are applied by a
   deliberate human/CI step with least-privilege credentials — never by app startup in prod, never by
   an agent holding a write token. Verify after applying: schema, journal state, and a smoke query.
10. **No unconditional `UPDATE`/`DELETE`.** If a mutation has no `.where()`, you must be able to say
    out loud why touching every row is correct.

## The workflow

```text
declare/change schema (TS) → drizzle-kit generate → REVIEW the SQL → apply (migrate)
→ verify (schema + journal + smoke query) → commit schema + migration + snapshot together
```

- Schema declaration rules, column modes, indexes/constraints API, relations, multi-file layout:
  **references/schema-declaration.md**
- Full kit command reference, custom DML migrations, expand-and-contract, drift recovery, rollback
  strategy, D1/programmatic application: **references/migrations-workflow.md**
- Query shapes, N+1 elimination, prepared statements, upserts, batch, pagination, raw-SQL safety:
  **references/queries-performance.md**
- Transaction API, savepoints, driver behaviors and their traps (better-sqlite3, libsql/Turso, D1,
  node-postgres, neon-http): **references/transactions-drivers.md**
- Boundary validation with drizzle-zod: **references/validation-zod.md**

## Failure modes — instinct vs. reality

| Instinct | Reality |
|---|---|
| "`push` is one command, why generate files?" | Push has no review step and no history. One bad diff and prod is altered with no record of what changed. Push is a dev-loop tool. |
| "generate exited cleanly, ship it" | Generation proves the diff is expressible, not that it is safe. Read the SQL: look for DROP, NOT NULL without DEFAULT, and renames misread as drop+add. |
| "The migration failed halfway — fix the file and re-run" | Applied migrations are immutable. A half-applied migration must be reconciled (finish manually, mark journal, or restore), never silently edited. See migrations-workflow.md. |
| "Rename the column in the schema" | Drizzle sees drop old + add new — data loss. Expand-and-contract or an explicit `ALTER TABLE ... RENAME` in a custom migration. |
| "Just DROP the old column, we deployed already" | Old code may still be running (rolling deploys, serverless warm instances). Contract only after every live instance reads the new shape. |
| "`await` each insert in a loop" | That is N+1 with extra latency per round trip. Use multi-row `values([...])`, `db.batch`, or a single relational query. |
| "The relational query API is optional sugar" | It is the N+1 fix. Without `relations()` defined, `db.query.*` doesn't exist and teams fall back to per-row loops. |
| "`db.transaction` means I'm safe" | Only if the driver and behavior config actually serialize writers. SQLite drivers differ wildly — some throw `database is locked` immediately instead of waiting. See transactions-drivers.md. |
| "`sql.raw` is fine, the input is internal" | Injection vectors get reused. `sql.raw` accepts only hardcoded strings; everything else is a parameter or an allowlisted identifier. Keep drizzle-orm patched — identifier-escaping CVEs have shipped. |
| "Rollback = run the down migration" | There is no down. Rollback is a new forward migration, a restore from backup/snapshot/PITR, or nothing. Plan it before you apply. |
| "timestamp is timestamp" | SQLite `timestamp` mode is seconds, `timestamp_ms` is milliseconds, both surface as `Date`. Mixing them corrupts comparisons and filters silently. Pick one per column and match the default expression. |

## Verification habit

After any migration or schema-touching change, prove state before claiming done:

1. The migration journal and the database agree (`drizzle-kit check` / inspect `__drizzle_migrations`).
2. `.schema` (or information_schema) matches what the TS schema declares.
3. A smoke query against the changed shape returns sane data.
4. The app still boots against the migrated database.

"Migrate exited 0" is not proof. Only inspection is proof.
