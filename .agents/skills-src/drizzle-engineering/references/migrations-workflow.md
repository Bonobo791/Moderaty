# Migrations Workflow

The drizzle-kit lifecycle: how schema changes become reviewed, ordered, recoverable database
history. Engine-level migration doctrine (forward-only, 12-step rebuilds, backup before migrate)
lives in sqlite-engineering/references/migrations.md — this file is the Drizzle-specific
operational layer.

## Contents

- Command map
- The golden rule: generate for prod, push for dev
- Review every generated file
- Custom migrations: DDL vs DML
- Expand-and-contract for destructive changes
- Applying migrations: CLI, programmatic, D1
- Journal immutability and drift recovery
- Rollback strategy (there is no down)

## Command map

| Command | What it does | When |
|---|---|---|
| `drizzle-kit generate` | Diffs TS schema vs last snapshot → new SQL migration + snapshot | Every schema change destined for any shared env |
| `drizzle-kit generate --custom --name=x` | Creates an EMPTY migration file for hand-written SQL | Data backfills, renames, seed data, anything kit can't diff |
| `drizzle-kit migrate` | Applies pending migrations from `out/` using the journal | Applying reviewed history to a database |
| `drizzle-kit push` | Diffs and applies DIRECTLY, no files | Local dev loop only. Never shared envs |
| `drizzle-kit pull` / `introspect` | Reverse-engineers TS schema from a live database | Adopting an existing database |
| `drizzle-kit check` | Validates migration files/journal consistency | CI gate; after resolving drift |
| `drizzle-kit up` | Upgrades snapshots after a drizzle-kit version bump | After upgrading drizzle-kit |
| `drizzle-kit export` | Exports schema as a single SQL file | Docs, reviews, external tooling |
| `drizzle-kit studio` | Browser data browser connected to the database | Inspection — treat as READ access, point it at prod only with read-only credentials |

## The golden rule

**`generate` produces history; `push` produces amnesia.**

- Dev loop: `push` freely against your local/disposable database. When the shape settles, delete
  any scratch migrations, `generate` one clean migration, and rebuild the dev database from replay.
- Anything shared (staging, prod, teammates' databases): only migrations produced by `generate`,
  reviewed, committed, and applied by `migrate`.
- Mixing the two against one database causes drift: push applies changes the journal doesn't know
  about, and the next `generate` diffs against a lie.

## Review every generated file

drizzle-kit diffs snapshots, not intent. Before committing, read the SQL and check:

1. **Drops** — every `DROP TABLE`/`DROP COLUMN` is a data-loss decision. Is it intended? If it
   appeared because you renamed something, it's wrong: kit can't see renames on its own (with
   `strict: true` it asks interactively, but non-interactive runs — CI, agents — get drop+add).
2. **Renames misread as drop+add** — fix by writing the `ALTER TABLE ... RENAME COLUMN` yourself
   in a `--custom` migration (or edit the generated file BEFORE it is applied anywhere).
3. **`NOT NULL` without `DEFAULT` on an existing table** — fails or corrupts on populated tables.
   Expand-and-contract instead.
4. **Table rebuilds (SQLite)** — adding/dropping constraints triggers the 12-step recreate pattern.
   Check that kit generated the full create-copy-drop-rename sequence, and that it wrapped it
   safely. Verify `PRAGMA foreign_keys` handling around the rebuild.
5. **Order** — statements must respect FK dependencies. Kit usually orders correctly; verify when
   multiple tables change at once.

## Custom migrations: DDL vs DML

```sh
npx drizzle-kit generate --custom --name=backfill-user-slugs
```

- **DDL** (structure) lives in auto-generated files — kit diffs structure, so structure should
  always be generated.
- **DML** (data: backfills, corrections, seeds) lives in `--custom` files you write by hand.
- Order: generate the DDL migration first, then create the custom DML migration so it sorts AFTER
  the DDL it depends on (journal order = filename sequence = application order).
- Write DML idempotently (`UPDATE ... WHERE slug IS NULL`, `INSERT ... ON CONFLICT DO NOTHING`) so a
  partially-applied migration can be reconciled by re-running the statement manually.
- Custom migrations still get a snapshot and journal entry — once applied anywhere, they are
  immutable like everything else.

## Expand-and-contract for destructive changes

Never mutate a shape that live code depends on in one step. Five steps, each its own deploy:

1. **Expand** — add the new column/table/index alongside the old (generated migration).
2. **Dual-write** — deploy code writing to both old and new shapes.
3. **Backfill** — custom DML migration copying old → new (idempotent, batched for large tables).
4. **Migrate reads** — deploy code reading only the new shape; confirm old shape is write-dead.
5. **Contract** — drop the old shape (generated migration) — only after every running instance is
   on the new code. Serverless warm instances and rolling deploys keep old code alive longer than
   intuition says.

The same pattern covers: renames (add new → move → drop old), type changes, splitting/merging
columns, and moving data between tables.

## Applying migrations

**CLI (default):**

```sh
npx drizzle-kit migrate    # uses dbCredentials from drizzle.config.ts
```

Run it as a deliberate step — a human with the write credential, or a CI deploy job. Not at app
startup in production.

**Programmatic (boot scripts, tests, ephemeral environments):**

```ts
import { migrate } from 'drizzle-orm/libsql/migrator';   // path is driver-specific:
// drizzle-orm/node-postgres/migrator, drizzle-orm/better-sqlite3/migrator,
// drizzle-orm/d1/migrator, drizzle-orm/neon-http/migrator, ...

await migrate(db, { migrationsFolder: './drizzle' });
```

Acceptable at startup ONLY for databases the process owns (local dev, per-test databases, embedded
replicas that replay on boot). For shared/production databases, startup application means every
instance races to migrate and any deploy auto-mutates prod — the failure mode this skill exists to
prevent.

**Cloudflare D1:** D1 has its own migration runner; use wrangler, not drizzle's `migrate`:

```sh
npx drizzle-kit generate
npx wrangler d1 migrations apply <db-name> --local
npx wrangler d1 migrations apply <db-name> --remote
```

## Journal immutability and drift recovery

- `out/meta/_journal.json` + the snapshots are the diff base. Applied migrations and their
  snapshots are **immutable history** — never edit, rename, or delete one that any environment has
  applied.
- The database tracks applied migrations in `__drizzle_migrations`. Journal files and this table
  must agree. `drizzle-kit check` validates the files; compare with the table when something
  smells.
- **"column already exists" / drift** usually means: someone pushed out of band, a migration was
  edited after applying, or a half-applied migration was re-run. Recovery, in order of preference:
  1. Finish or revert the half-applied statements by hand, then mark the row in
     `__drizzle_migrations` consistently (or remove it if truly unapplied).
  2. If the database is disposable: drop it and replay all migrations from clean.
  3. If the database is NOT disposable: restore the pre-migration backup/snapshot, then re-apply
     correctly. Never "fix" by editing old migration files to match reality — that rewrites history
     and breaks every other environment.
- After any manual reconciliation, run `drizzle-kit check`, re-generate to confirm zero diff, and
  document what happened in the commit message.

## Rollback strategy (there is no down)

drizzle-kit has no down migrations. Before applying anything irreversible, decide the rollback:

1. **Forward fix** (default): a new migration restoring the previous shape. Works for additive
   changes; too slow for "prod is on fire".
2. **Backup/snapshot before migrate** (mandatory for prod): dump or snapshot the database
   immediately before applying. For Turso: a point-in-time-restore window exists (plan-dependent)
   and restores to a NEW database — you cut over to it. For file SQLite: copy the file (WAL:
   checkpoint first). For D1: export. Test the restore path once before you need it.
3. **Expand-and-contract as prevention**: if old code can keep running against the old shape,
   "rollback" is just rolling back the deploy — no database action needed. This is why destructive
   changes never ship in one step.

Verify after every application: journal/table agreement, schema inspection, smoke query. "migrate
exited 0" is not verification.
