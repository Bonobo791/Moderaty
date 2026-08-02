# SQLite Migrations

Contents: ALTER TABLE limits · the 12-step table rebuild · versioning · framework notes · safety checklist

## What ALTER TABLE can and cannot do

| Supported | Not supported |
|---|---|
| `ADD COLUMN` (with constant default) | change column type |
| `DROP COLUMN` (3.35+) | add/change/drop a constraint |
| `RENAME COLUMN` | change PK definition |
| `RENAME TO` (table) | convert to/from STRICT, add/remove WITHOUT ROWID |

`ADD COLUMN` with a volatile default (`DEFAULT (unixepoch())`) is rejected — add nullable, backfill, or rebuild.

## The 12-step table rebuild

For everything unsupported, the official generalized procedure (sqlite.org, "ALTER TABLE" docs):

```sql
PRAGMA foreign_keys = OFF;          -- 1. disable FK enforcement (outside transaction!)
BEGIN;                              -- 2. start transaction
-- 3. create the new table with the desired schema (use a temp name or new name)
CREATE TABLE users_new (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  age INTEGER CHECK (age >= 0)
) STRICT;
-- 4. copy data
INSERT INTO users_new (id, email, age) SELECT id, email, age FROM users;
-- 5. drop old table
DROP TABLE users;
-- 6. rename
ALTER TABLE users_new RENAME TO users;
-- 7. recreate indexes / triggers / views that referenced the old table
CREATE INDEX idx_users_email ON users(email);
COMMIT;                             -- 8-10. commit
PRAGMA foreign_key_check;           -- 11. verify no orphaned FKs
PRAGMA foreign_keys = ON;           -- 12. re-enable
```

Critical details:

- `PRAGMA foreign_keys` is a no-op inside a transaction — toggle it **before** BEGIN and **after** COMMIT.
- Remember indexes, triggers, and views referencing the old table: `DROP TABLE` kills its indexes and triggers silently. Capture them first: `SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'users';`
- Data transformations go in the copy SELECT (cast, trim, split columns, drop rows).
- The whole rebuild is transactional — a failure rolls back cleanly. Never do rebuilds outside a transaction.
- `PRAGMA legacy_alter_table` and `writable_schema` exist; don't touch them in production migrations.

## Versioning

- `PRAGMA user_version = N;` — built-in integer in the DB header, the standard mechanism. Migration runner reads it, applies migrations N+1..M in order, each in its own transaction, updates user_version last.
- Or a `_migrations` table with name/applied_at — better audit trail; user_version is simpler.
- Every migration: idempotent where possible, wrapped in BEGIN/COMMIT, and applied in filename order with no gaps.

## Framework notes

- **Drizzle Kit**: `drizzle-kit generate` diffs schema → SQL; inspect the generated SQL before applying — it does emit table rebuilds for SQLite but verify constraint handling. `drizzle-kit push` is for prototyping only, never production.
- **Alembic**: SQLite requires "batch mode" (`with batch_alter_table('t') as op:`) which implements the rebuild pattern for you.
- **Rails/Laravel/Prisma**: their migrate tools handle SQLite rebuilds internally; still read the generated SQL for destructive operations.
- Raw SQL files + a 20-line runner is often the best option for small apps: `001_init.sql`, `002_add_sessions.sql`, tracked via user_version.

## Safety checklist for every migration

1. Backup first: `VACUUM INTO 'backup-pre-migration.db';`
2. Wrap in a transaction (DDL rolls back in SQLite — use it).
3. FK pragma dance outside the transaction.
4. Re-run `SELECT sql FROM sqlite_master;` after — confirm the final schema is what you intended.
5. `PRAGMA foreign_key_check;` + `PRAGMA integrity_check;` before declaring success.
6. Re-verify query plans for hot queries — a rebuild drops and recreates indexes; a missed `CREATE INDEX` turns seeks into scans silently.
