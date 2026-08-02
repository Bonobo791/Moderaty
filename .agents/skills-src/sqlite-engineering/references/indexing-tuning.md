# SQLite Indexing & Query Tuning

Contents: EXPLAIN QUERY PLAN · composite index design · partial/expression/covering indexes · statistics · slow-query patterns · maintenance

## EXPLAIN QUERY PLAN is the only source of truth

```sql
EXPLAIN QUERY PLAN
SELECT id, title FROM posts WHERE status = 'published' ORDER BY created_at DESC LIMIT 20;
```

Read the output for:

| Output | Meaning | Verdict |
|---|---|---|
| `SCAN posts` | full table scan | fine for tiny tables, red flag otherwise |
| `SEARCH posts USING INDEX idx_... (status=?)` | index seek | good |
| `SEARCH ... USING COVERING INDEX` | never touches the table | best case |
| `USE TEMP B-TREE FOR ORDER BY` | in-memory sort | fix with index whose columns match ORDER BY |
| `USE TEMP B-TREE FOR GROUP BY/DISTINCT` | same | same |

Run it against a database with realistic data volume — SQLite's planner is cost-based; plans change as tables grow.

## Composite index design

Column order rule: **equality columns first, then the first range/sort column.**

```sql
-- Query: WHERE tenant_id = ? AND status = ? AND created_at > ? ORDER BY created_at
CREATE INDEX idx_posts_lookup ON posts (tenant_id, status, created_at);
```

- Leftmost-prefix: `(a, b, c)` serves `WHERE a=?`, `WHERE a=? AND b=?`, `WHERE a=? AND b=? AND c=?` — not `WHERE b=?` alone.
- One well-ordered composite index beats three single-column indexes. SQLite can use multiple indexes per query (index intersection) but rarely plans it well.
- Index order serves both directions: an ASC index handles `ORDER BY x DESC` too. Mixed direction (`a ASC, b DESC`) needs the index declared that way.
- Match ORDER BY to the index to eliminate the temp B-tree sort: index `(status, created_at)` serves `WHERE status=? ORDER BY created_at`.

## Specialized indexes

```sql
-- Partial: index only hot rows (small, fast)
CREATE INDEX idx_active_sessions ON sessions (user_id, expires_at) WHERE revoked = 0;

-- Expression: index what you actually query
CREATE INDEX idx_email_lower ON users (lower(email));
SELECT * FROM users WHERE lower(email) = lower(?);   -- now indexable

-- Covering: include everything the query SELECTs → no table access
CREATE INDEX idx_feed ON posts (status, created_at) -- query selects only id/title? include them:
-- SQLite has no INCLUDE clause; add columns to the key instead
CREATE INDEX idx_feed_cover ON posts (status, created_at, title);
```

## Statistics and the planner

- Run `ANALYZE` (populates sqlite_stat1/4) after bulk loads or major data-shape changes; otherwise the planner guesses from table sizes.
- `PRAGMA optimize;` periodically in long-lived apps — refreshes stats only when worthwhile.
- Verify index adoption with `SELECT * FROM sqlite_stat1;` and re-run EXPLAIN QUERY PLAN after ANALYZE.

## Classic slow-query patterns

1. **Function on the indexed column** — `WHERE date(created_at) = ?` kills the index. Rewrite as a range: `WHERE created_at >= ? AND created_at < ?`, or add an expression index.
2. **Leading-wildcard LIKE** — `LIKE '%foo'` always scans. `LIKE 'foo%'` can use an index (with `COLLATE NOCASE` caveats). For real substring search use FTS5, not LIKE.
3. **N+1 from ORM code** — join or `WHERE id IN (...)` batch instead of per-row queries.
4. **Implicit type mismatch in STRICT** — comparing TEXT column to integer bind skips index. Match bind types to column types.
5. **COUNT(*) on huge tables per request** — cache, approximate, or maintain a counter table.
6. **OFFSET pagination** — `OFFSET 50000` reads 50,020 rows. Use keyset pagination: `WHERE created_at < ? ORDER BY created_at DESC LIMIT 20`.
7. **OR across different columns** — often becomes two scans; consider `UNION ALL` of two indexed seeks.
8. **Correlated subqueries per row** — rewrite as joins or window functions (SQLite ≥ 3.25 has full window support).

## Full-text search

Use FTS5 for any text search feature: `CREATE VIRTUAL TABLE posts_fts USING fts5(title, body, content='posts', content_rowid='id');` Keep it in sync with triggers or in the same transaction as the content write. Rank with `bm25()`.

## Write cost & maintenance

- Every index slows INSERT/UPDATE/DELETE and grows the file. Index for measured read patterns, not imagined ones.
- Bloat: set `PRAGMA auto_vacuum = INCREMENTAL` at creation time (must precede table creation), and run `PRAGMA incremental_vacuum(N);` after large deletes. Full `VACUUM` rewrites the file and needs ~2x disk — schedule it, don't improvise it.
