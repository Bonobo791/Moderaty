# SQLite Schema Design

Contents: STRICT tables · keys · constraints as invariants · types & time · normalization & JSON · anti-patterns

## STRICT tables

```sql
CREATE TABLE users (
  id         INTEGER PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  is_admin   INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
```

- Allowed types: `INTEGER`, `REAL`, `TEXT`, `BLOB`, `ANY`. Anything else is a syntax error — by design.
- STRICT turns the database into an actual type enforcer instead of a suggestion box. Prefer it for all new schemas; flag non-STRICT legacy tables in reviews.
- Default expression functions must be constant: `unixepoch()`, `CURRENT_TIMESTAMP`, literals.

## Primary keys

- `INTEGER PRIMARY KEY` aliases the rowid — fastest possible lookup, no extra index. This is the default choice.
- `AUTOINCREMENT` only prevents rowid reuse (costs an extra sqlite_sequence lookup per insert). Rarely needed; don't reach for it by habit.
- `WITHOUT ROWID` when the natural key is (a) the dominant lookup path and (b) small — e.g. `PRIMARY KEY (date, symbol)` on a time-series table. Avoid WITHOUT ROWID with large/text surrogate keys: every secondary index stores the full PK, bloating the file.
- Never expose rowid as a public/API identifier; use a separate `uuid TEXT UNIQUE` if external identity is needed.

## Constraints are the schema's real value

SQLite enforces all of these cheaply — use them aggressively:

- `NOT NULL` on everything except genuinely optional columns.
- `UNIQUE` for natural keys (emails, slugs); `UNIQUE (a, b)` for junction tables.
- `CHECK` for enums, ranges, and format guards: `CHECK (status IN ('draft','published','archived'))`, `CHECK (price_cents >= 0)`.
- `FOREIGN KEY ... ON DELETE CASCADE / RESTRICT / SET NULL` — but remember enforcement requires `PRAGMA foreign_keys=ON` per connection.
- Foreign key indexes are NOT automatic. Index the child-side FK column or every join and CASCADE delete table-scans.

## Types and time

| Concept | Recommended | Avoid |
|---|---|---|
| Timestamps | `INTEGER NOT NULL DEFAULT (unixepoch())` | `DATETIME` (non-STRICT), locale-formatted strings |
| Human-readable time | TEXT ISO-8601 UTC `YYYY-MM-DDTHH:MM:SSZ` | mixed timezones, `MM/DD/YYYY` |
| Booleans | `INTEGER ... CHECK (x IN (0,1))` | TEXT 'true'/'false' |
| Money | integer minor units (cents) | REAL/FLOAT — binary rounding |
| Enums | TEXT + CHECK | unvalidated free text |

ISO-8601 TEXT sorts chronologically; unixepoch INTEGER is smaller and faster for range math. Pick one per project and stay consistent.

## Normalization & JSON

- Normalize to 3NF by default. Denormalize only with a measured query that needs it, and maintain the duplicated value with a trigger or in the same transaction.
- JSON1 (`json_extract`, `->>`) is fine for: sparse/optional attributes, audit/event payloads, data whose shape is owned by an external API.
- JSON is wrong for: anything you filter, join, sort, or aggregate on regularly. Extract hot fields into real columns (an expression index on `json_extract(...)` is the middle path).
- Prefer `jsonb` storage functions (3.45+) for heavy JSON workloads.

## Anti-patterns to flag in reviews

1. **EAV tables** (entity/attribute/value) — unqueryable without self-join chains; use JSON or real columns.
2. **God tables** — 40+ nullable columns mixing concerns; split along write patterns.
3. **No constraints anywhere** — schema as documentation only; bugs land in data.
4. **BLOB for files** — store files on disk/object storage, paths in DB, unless blobs are small (< ~100 KB) and transactional consistency with rows matters.
5. **Text FK columns without indexes** — every CASCADE becomes a scan.
6. **`SELECT *` in shipped code** — hides schema drift and defeats covering indexes.
