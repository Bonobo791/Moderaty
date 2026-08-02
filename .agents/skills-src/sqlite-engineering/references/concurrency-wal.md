# SQLite Concurrency, WAL & Locking

Contents: journal modes · the single-writer rule · SQLITE_BUSY handling · transaction discipline · WAL operational issues · corruption avoidance

## Journal modes

| Mode | Readers during write | Writers | Use |
|---|---|---|---|
| `DELETE` (default) | blocked | one | only for throwaway/temp DBs |
| `WAL` | **never blocked** | one | the default for every real app |
| `WAL2` (3.42+, uncommon builds) | never blocked | one, better tail latency | only if the build provides it |
| `MEMORY` / `OFF` | — | — | never for durable data |

Set once: `PRAGMA journal_mode=WAL;` — it persists in the DB file. Pair with `PRAGMA synchronous=NORMAL;` (FULL gives no extra durability under WAL, just latency).

## The single-writer rule

- SQLite allows any number of concurrent readers but exactly one writer, database-wide (not per-table). A second writer gets `SQLITE_BUSY`.
- Architecture implication: **serialize all writes through one connection + a queue/mutex** in the application. Reader connections can be pooled freely under WAL.
- Write transactions must be short. A write transaction that does network calls, sleeps, or awaits user input while open blocks every other writer — flag this pattern in code review.
- Batch: one transaction inserting 10k rows is ~100–1000x faster than 10k auto-committed inserts. Wrap bulk work in explicit `BEGIN`/`COMMIT`.

## SQLITE_BUSY is control flow, not a crash

1. `PRAGMA busy_timeout = 5000;` per connection — the driver sleeps/retries internally.
2. Still handle the error at the application layer: retry with jittered backoff, and make retryable operations idempotent.
3. `SQLITE_BUSY_SNAPSHOT` (WAL-specific): a deferred read transaction tried to upgrade to write after the snapshot went stale. Fix by using `BEGIN IMMEDIATE` for any transaction that will write.

## Transaction discipline

- `BEGIN DEFERRED` (default) takes no lock until first statement; `BEGIN IMMEDIATE` takes the write lock up front; `BEGIN EXCLUSIVE` blocks even readers (non-WAL).
- Rule: if a transaction reads-then-writes (check-then-act), use `BEGIN IMMEDIATE` — otherwise two connections can both read, both try to upgrade, and one deadlocks into SQLITE_BUSY.
- DDL is transactional in SQLite: schema changes roll back cleanly. Use it.
- Long-lived *read* transactions pin old WAL pages and prevent checkpointing — the `-wal` file grows unboundedly. Keep read transactions short too.

## WAL operational issues

- Files: `db.sqlite`, `db.sqlite-wal`, `db.sqlite-shm`. Copy/backup all three, or checkpoint first — copying just the main file loses recent commits.
- Checkpoint tuning: default `wal_autocheckpoint=1000` pages. Write-heavy apps may want it higher (bigger WAL, fewer pauses) plus a periodic `PRAGMA wal_checkpoint(TRUNCATE);` during idle time.
- Readers on a different machine cannot work — WAL requires shared memory (`-shm`), so **no NFS/SMB/network filesystems**. SQLite on network storage risks silent corruption; keep the file on local disk.
- Turso/libSQL note: remote libSQL replicates WAL frames server-side; the local WAL guidance applies to embedded replicas and local files.

## Corruption avoidance

- Never `cp`/rsync a live database without the backup API (`VACUUM INTO 'backup.db';` or the online backup API).
- Don't put the DB on network mounts or in synced folders (Dropbox/iCloud) — file-locking emulation corrupts.
- One process model is fine; multi-process access works on local disk with proper locking but multi-writer processes still serialize — see single-writer rule.
- After any suspicious event (kill -9 during write, disk full), run `PRAGMA integrity_check;`.
- Disk-full during a write is a real corruption vector: monitor disk headroom on WAL-heavy workloads.
