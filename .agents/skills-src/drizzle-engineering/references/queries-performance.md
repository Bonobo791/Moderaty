# Queries and Performance

Query shapes that stay fast: eliminating N+1, batching writes, preparing hot paths, paginating
correctly, and keeping raw SQL safe. Index selection itself is engine doctrine — see
sqlite-engineering/references/indexing-tuning.md.

## Contents

- Two APIs, two jobs
- N+1 elimination
- Writes: multi-row, upsert, batch
- Prepared statements and placeholders
- Pagination
- Counting
- Raw SQL safety (non-negotiable)
- Select explicitly

## Two APIs, two jobs

**Core API** (`db.select().from().where()...`) — SQL-shaped, composable, what you use for filters,
joins with explicit column lists, aggregations, and all mutations:

```ts
const rows = await db
  .select({ id: posts.id, title: posts.title, authorName: users.name })
  .from(posts)
  .innerJoin(users, eq(posts.authorId, users.id))
  .where(and(eq(posts.published, true), gte(posts.createdAt, since)))
  .orderBy(desc(posts.createdAt))
  .limit(20);
```

**Relational query API** (`db.query.*`) — Prisma-shaped nested fetching, built on `relations()`.
Its value is not ergonomics; it is **one round trip per level instead of one per row**:

```ts
const result = await db.query.users.findMany({
  where: eq(users.role, 'admin'),
  with: {
    posts: { where: eq(posts.published, true), limit: 5, orderBy: desc(posts.createdAt) },
  },
});
```

Requires: `relations()` declared AND `drizzle(client, { schema })` given the full schema. If
`db.query` is undefined, one of those is missing.

Rule of thumb: nested read graphs → relational API; precise column control, aggregations, writes →
core API.

## N+1 elimination

The canonical Drizzle performance bug:

```ts
// BAD: 1 + N queries, N network round trips
const posts = await db.select().from(posts);
for (const post of posts) {
  post.author = await db.query.users.findFirst({ where: eq(users.id, post.authorId) });
}
```

Fixes, in order of preference:

1. **Relational `with`** (above) — right answer for nested shapes.
2. **A single JOIN** via core API, then reduce in JS if you need nesting.
3. **`inArray` batched lookup** when you must fetch in two steps:
   `db.select().from(users).where(inArray(users.id, authorIds))` — 2 queries total, not N+1.
4. **`Promise.all` over independent queries** only when the queries are truly independent — and
   remember SQLite is single-writer; parallel writes don't exist (see transactions-drivers.md).

If a loop contains `await db...`, the design is wrong.

## Writes: multi-row, upsert, batch

**Multi-row insert** — one statement, one round trip:

```ts
await db.insert(users).values([{...}, {...}, {...}]);
```

**Upsert:**

```ts
await db.insert(users)
  .values({ id, email, name })
  .onConflictDoUpdate({
    target: users.email,                       // the unique column(s)
    set: { name: excludedName },               // what to update
    // setWhere: sql`...`, targetWhere: sql`...`  — partial-conflict refinements
  });

// referencing the proposed row (Postgres "excluded"):
set: { name: sql.raw(`excluded.${users.name.name}`) }

// helper for "update every inserted column":
import { getTableColumns, buildConflictUpdateColumns } from 'drizzle-orm';
set: buildConflictUpdateColumns(users, getTableColumns(users)),
```

`onConflictDoNothing({ target })` for insert-if-absent. `buildConflictUpdateColumns` silently
updates columns you didn't mean to — exclude immutable columns (id, createdAt) explicitly.

**Batch API** (driver-dependent: libSQL/Turso, D1, Neon HTTP) — multiple statements in one call,
executed atomically by the backend:

```ts
await db.batch([
  db.insert(auditLog).values({...}),
  db.update(counters).set({ n: sql`${counters.n} + 1` }).where(eq(counters.id, 1)),
]);
```

Use batch for atomic multi-statement writes on HTTP drivers where a real transaction either isn't
available or costs extra round trips. Know your driver: on better-sqlite3/node-postgres a real
`db.transaction` is strictly better.

## Prepared statements and placeholders

For queries executed in a hot path, prepare once, execute many:

```ts
const byId = db.select().from(users).where(eq(users.id, sql.placeholder('id'))).prepare('user_by_id');
await byId.execute({ id: 1 });
await byId.execute({ id: 2 });
```

- Prepare at module scope, not per request.
- Name every prepared statement — unnamed ones defeat driver-level caches and observability.
- Prepared ≠ magic: the win is skipping re-parse/re-plan per execution plus driver statement
  caching. On edge/HTTP drivers with per-request connections the win shrinks; don't contort code
  for it there.

## Pagination

- **Offset** (`.limit(n).offset(m)`) is fine for small, stable datasets; degrades to scanning m+n
  rows and drifts under concurrent writes.
- **Keyset/cursor** is the correct default for feeds and large tables:

```ts
.where(lt(posts.createdAt, cursor)).orderBy(desc(posts.createdAt)).limit(pageSize + 1)
```

Fetch one extra row to know whether a next page exists. The cursor column must be indexed and
unique enough — add the PK as tiebreaker (`(createdAt, id)`) or pages will skip/duplicate rows.

## Counting

```ts
import { count } from 'drizzle-orm';
const [{ value }] = await db.select({ value: count() }).from(users).where(...);
```

`db.$count(users, whereClause)` is shorthand. Counts on large tables are scans unless the predicate
matches an index — a "cheap count for the UI" can be the most expensive query on the page.

## Raw SQL safety (non-negotiable)

The `sql` template is the escape hatch and the injection surface:

```ts
// SAFE — values interpolate as bound parameters, columns as escaped identifiers:
sql`select * from ${users} where ${users.id} = ${id}`          // → ... where "users"."id" = $1

// DANGEROUS — sql.raw injects the string VERBATIM:
sql`where name = ${sql.raw(userInput)}`                        // SQL injection. Never.
```

Rules:

1. `sql.raw()` accepts only string literals you wrote. If any part came from a request, config, or
   another system, it does not go through `sql.raw`. (Its one legitimate use: referencing the
   `excluded.` pseudo-table in upserts with a column name from your own schema.)
2. Dynamic identifiers (table/column names from user input) don't exist in safe code. If a feature
   truly needs them, allowlist against known schema names — and keep drizzle-orm patched:
   identifier-escaping vulnerabilities (e.g. CVE-2026-39356, fixed in 0.45.2 / 1.0.0-beta.20) have
   made `sql.identifier()`/`.as()` with attacker input exploitable. Upgrade first, allowlist anyway.
3. Type the result: `sql<number>`count(*)`` in a select object, or the field is `unknown`.

## Select explicitly

- `.select()` (no args) returns every column — fine for prototypes, wrong for hot paths and wide
  tables. List the columns you need; it's a smaller payload, a stable contract, and enables
  covering-index plans.
- `returning()` (SQLite/Postgres) gets the written row back in the same round trip — use it instead
  of insert-then-select.
- Read your own SQL in development (`{ logger: true }` in `drizzle()` options) and paste hot
  queries into `EXPLAIN QUERY PLAN` when performance matters. Drizzle's honesty means the SQL you
  see is the SQL you get — look at it.
