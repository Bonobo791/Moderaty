# Field Failures — Real Agent-Written SQLite Bugs

Distilled from actual multi-reviewer findings (CodeRabbit / Qodo / CodeAnt / Amazon Q) on agent-authored Drizzle + libSQL/SQLite PRs. Each entry: what the agent shipped, why it's wrong, the rule.

Contents: migration journal rewrites · backfill sentinel bugs · unindexed sweep queries · false migrate success · non-atomic external side effects · stale-read races · in-memory filtering

## 1. Rewriting the migration journal

**Shipped:** a PR "replaced migration 0009 and removed migration 0010," reusing an already-existing migration number for a new column, justified by "prod is only at 0007, so the renumber is safe."

**Why wrong:** applied migrations are immutable history. Any environment that applied the old 0009 (a preview deploy, a teammate's dev DB, a branch deploy, CI fixtures) now has a journal hash/sequence that doesn't match, and the migrate tool either errors or silently diverges. "Prod is at 0007" proves nothing about every other environment.

**Rule:** migrations are append-only. To change something an earlier migration did, add a NEW migration (drop column, drop index, rebuild table) — never edit, renumber, reorder, or delete an existing one. If two migrations were never applied anywhere (truly local-only), squashing them is fine — but the burden of proof is on you, and the default answer is: new migration.

## 2. Backfills copying sentinel values

**Shipped:** `UPDATE consents SET email = (SELECT email FROM users WHERE users.id = consents.user_id)` — where already-tombstoned users had `email = '[deleted]'`, so statutory evidence rows got a literal sentinel string as their e-mail. Fixed later with `NULLIF(..., '[deleted]') WHERE email IS NULL`.

**Why wrong:** backfills run against real data, and real data contains tombstones, sentinels, placeholders, legacy nulls. A backfill that doesn't account for them corrupts the very records it's meant to repair.

**Rule:** before writing any backfill, run the SELECT side alone and inspect actual values (especially tombstone/deleted rows). Filter sentinels explicitly. Make the statement idempotent (`WHERE target IS NULL`) so a partial re-run is safe.

## 3. New query pattern, no new index

**Shipped:** a cron sweep filtering `WHERE email IS NOT NULL AND created_at < cutoff LIMIT 50` — but the table only had an index on `user_id`. The LIMIT bounds writes, not reads: without an index the query scans the whole table before finding 50 rows, on every cron tick, forever.

**Why wrong:** agents add queries and indexes in separate mental steps and forget the second. Reviewers caught it; CI didn't.

**Rule:** every new WHERE/ORDER BY shape ships with an EXPLAIN QUERY PLAN check in the same PR. For partial-availability sweeps like `x IS NOT NULL AND time < ?`, a partial index is ideal: `CREATE INDEX idx ON t (created_at) WHERE email IS NOT NULL;` Also make batch jobs deadline-aware — a bounded batch is not a bounded scan.

## 4. "Migrate exited 0" treated as success

**Shipped:** PR verification said "run npm run db:migrate and verify the column exists — drizzle-kit can exit 0 without applying when the DB is unreachable." The agent knew the failure mode and still shipped no verification step in scripts or docs.

**Rule:** every migration PR includes the post-migrate verification as an explicit step: check the actual schema on the target (`PRAGMA table_info(table);` / `SELECT sql FROM sqlite_master;`), not the tool's exit code. Add it to deploy docs or as a smoke script, not just the PR description.

## 5. External side effects before the transaction

**Shipped:** account deletion revoked each channel's Google OAuth token (network call), THEN ran the DB erase transaction. If the transaction fails/rolls back after revocation succeeded, the user's rows remain but their grants are dead — a partial state with no rollback and no retry path (the encrypted token was going to be erased, so revocation can never be retried). A separate race: a stale session resolution could still grant access after the account was tombstoned.

**Why wrong:** only the database is transactional. External calls are not, and ordering them before the commit point means a DB failure leaves the outside world permanently changed.

**Rule — the outbox ordering:**
1. Decide which failure you can survive. If revocation-first is required (here: YouTube ToS), then persist a `pending_revocations` record INSIDE the DB transaction, erase, and retry revocation out-of-band — never "log and lose."
2. If the external call must reflect committed state, run it AFTER commit and accept the retry queue.
3. Any flow mixing external APIs + DB writes must answer in code comments: "if step N fails, what state is the world in, and who retries?"
4. State transitions that invalidate access (tombstones, revocation, plan changes) must be enforced at read time against current state, not cached session snapshots — re-check the authoritative row inside the request's transaction or accept a bounded staleness explicitly.

## 6. `.all()` then filtering in application code

**Shipped (in tests, but the habit leaks to prod):** `select().from(sessions).all()` then `.filter(r => r.userId === id)` in JS — materializing entire tables to count rows.

**Rule:** filtering belongs in SQL (`WHERE`, `COUNT(*)`). `.all()` without LIMIT on an unbounded table is a review finding anywhere it appears. If you need a count, `SELECT count(*) ... WHERE ...` — the database does this in one pass over an index.

## Pre-flight checklist for any DB-touching PR

- [ ] No existing migration file edited, renamed, renumbered, or deleted
- [ ] Backfill SELECT inspected against real/sentinel data; statement idempotent
- [ ] Every new query shape has EXPLAIN QUERY PLAN evidence + index if needed
- [ ] Post-migrate verification targets the actual schema, not exit codes
- [ ] External side effects ordered deliberately; failure states named; retry path exists
- [ ] Access-invalidating transitions enforced against current state at read time
- [ ] No `.all()` + in-memory filtering outside genuinely tiny fixtures
