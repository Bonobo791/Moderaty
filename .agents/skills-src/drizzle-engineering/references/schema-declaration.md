# Schema Declaration

How to declare tables, columns, constraints, indexes, and relations so that drizzle-kit diffs
correctly and the runtime types tell the truth. Engine-level doctrine (STRICT tables, index
selection, WAL) belongs to the sqlite-engineering skill; this file is about the Drizzle layer.

## Contents

- Layout and the config contract
- Columns and modes
- Constraints and indexes
- Self-referencing and standalone foreign keys
- Relations are not optional
- Type inference
- Multi-file schemas

## Layout and the config contract

`drizzle.config.ts` is the contract between your schema and drizzle-kit:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',            // 'postgresql' | 'mysql' | 'sqlite' | 'turso' | ...
  schema: './src/lib/server/db/schema', // file OR folder — folder = all files merged
  out: './drizzle',             // migrations + snapshots + journal live here, COMMITTED
  dbCredentials: { url: process.env.DATABASE_URL! },
  strict: true,                 // interactive confirmations on ambiguous diffs
  verbose: true,                // print generated statements
});
```

Rules:

- Commit everything under `out/` — SQL files, `meta/_journal.json`, and every snapshot. The
  journal and snapshots are how drizzle-kit diffs; losing them means losing history.
- Never put real credentials in the config file. Environment variables only, and production
  credentials never in a repo-readable `.env`.
- `strict: true` makes kit ask before ambiguous operations (like renames). Keep it on anywhere a
  human is present; CI applies already-reviewed files with `migrate`, it does not re-generate.

## Columns and modes

Column builder calls map 1:1 to DDL. Two consequences: **every modifier is a schema commitment**
(drizzle-kit will diff it), and **mode options change the application type without changing the
storage**.

SQLite specifics (the mode traps):

```ts
import { sqliteTable, text, integer, index, uniqueIndex, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  // Timestamp modes: 'timestamp' = SECONDS, 'timestamp_ms' = MILLISECONDS.
  // Both surface as Date in the app, both stored as INTEGER. Pick ms unless you
  // interoperate with something that writes seconds.
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),          // app-level default — reliable across drivers
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),          // app-level trigger on UPDATE
  metadata: text('metadata', { mode: 'json' }).$type<{ plan: string }>(),
}, (t) => [
  // third-arg callbacks return an ARRAY in current drizzle-orm (object form is deprecated)
  index('users_email_idx').on(t.email),
  check('users_role_check', sql`${t.role} in ('admin', 'member')`),
]);
```

Timestamp rules:

- `timestamp` = seconds, `timestamp_ms` = milliseconds. Comparing a seconds column to a
  milliseconds value filters silently wrong — no error, just empty/wrong results. Standardize on
  `timestamp_ms` for new schemas.
- Prefer **app-level defaults** (`$defaultFn`, `$onUpdateFn`) over SQL defaults for timestamps.
  SQL `unixepoch()` returns seconds and has version-dependent bugs against `mode: 'timestamp'`
  columns; `$onUpdateFn` has no SQL equivalent at all. App-level defaults work identically on
  every driver.
- If you do use SQL defaults, the expression must match the mode's unit:
  `sql`(unixepoch() * 1000)` for `timestamp_ms`.
- `defaultNow()` does not exist for SQLite integers — that is a Postgres/MySQL timestamp helper.

Primary keys:

- SQLite: `integer('id').primaryKey({ autoIncrement: true })` for rowid-style IDs;
  `text('id').primaryKey()` with app-generated IDs (nanoid/uuid) when rows are created across
  replicas or before insert.
- Composite PKs go in the third argument: `primaryKey({ columns: [t.a, t.b] })`.

## Constraints and indexes

Declared in the table's third argument (array form):

```ts
(t) => [
  uniqueIndex('orders_user_ref_uidx').on(t.userId, t.reference),
  index('orders_status_created_idx').on(t.status, t.createdAt),
  index('orders_open_idx').on(t.userId).where(sql`${t.status} = 'open'`), // partial index
  check('orders_amount_positive', sql`${t.amount} >= 0`),
  foreignKey({ columns: [t.userId], foreignColumns: [users.id] }).onDelete('cascade'),
]
```

Doctrine (details in sqlite-engineering/references/indexing-tuning.md):

- **Every foreign key column gets an index.** The engine does not auto-index FK columns; unindexed
  FKs turn joins and cascades into scans.
- **Index for query shapes you actually run** — column order is (equality …, range/sort). Do not
  index speculatively; each index is a write tax forever.
- Partial indexes (`.where(sql``)`) are the cheapest correct index for hot subsets
  (`status = 'open'`, `deleted_at IS NULL`).
- Postgres adds: `.using('gin'|'gist'|...)`, `.concurrently()` (never inside a transaction).
- Name every constraint and index explicitly. Generated names differ across regenerations and make
  diffs noisy.

## Self-referencing and standalone foreign keys

Self-references (and circular references between tables) cannot use the inline `.references(() => t.id)`
form — the column isn't initialized yet. Use a standalone `foreignKey` with a type hint:

```ts
import { type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export const categories = sqliteTable('categories', {
  id: integer('id').primaryKey(),
  parentId: integer('parent_id').references((): AnySQLiteColumn => categories.id),
});
```

The same standalone `foreignKey({ columns, foreignColumns })` form resolves circular references
between two tables.

## Relations are not optional

`relations()` declarations power the relational query API (`db.query.users.findMany({ with: ... })`),
which is the primary N+1 defense (see queries-performance.md). Declare both sides:

```ts
export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));

export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}));
```

- Relations cost nothing at runtime until queried — there is no reason to skip them.
- `relationName` is required when two tables relate more than once (e.g. `authorId` and
  `reviewerId` both pointing at users).
- Pass `schema` (including relations) to `drizzle(client, { schema })` or `db.query` is undefined.

## Type inference

Derive app types from the schema — never maintain parallel interfaces:

```ts
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

`$type<T>()` on json columns narrows the runtime type; keep the shape small and versioned, because
the database will contain old shapes after you change `$type`.

## Multi-file schemas

Point `schema:` at a folder; drizzle-kit globs every `.ts` file in it. Conventions:

- One file per domain area (`auth.ts`, `billing.ts`), re-exported from an `index.ts` barrel so the
  app imports `* as schema` from one place.
- Circular imports between schema files are the classic failure — keep FK references one-directional
  where possible, use standalone `foreignKey` when not.
- Deleting a table file deletes the table in the next diff. That is a destructive change — treat it
  with the expand-and-contract discipline in migrations-workflow.md.
