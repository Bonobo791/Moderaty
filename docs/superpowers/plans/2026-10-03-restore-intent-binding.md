# Restore Intent Binding Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent interrupted human-action recovery from replaying an unrelated historical user action.

**Architecture:** A nullable `comments.restoreIntentId` binds a restoring claim to one audit row. Human-action transactions set the binding before remote work; recovery validates the exact row and fails closed when no trustworthy binding exists. Explicit legacy Undo creates a fresh restore intent.

**Tech Stack:** SvelteKit, TypeScript, Drizzle, SQLite/libSQL, Vitest.

**Spec:** PR #189 review https://github.com/Bonobo791/Moderaty/pull/189#discussion_r4174937508 and the authorized recovery follow-up.

## Global Constraints

- Fresh branch from main 99a290e, separate from fairness work
- New nullable migration; no production database access or moderation calls
- Migration 0065 reserved; fairness separately owns 0064
- Local check/build/full tests must pass before commit and authorized draft PR against main
- No merge or deployment

## Review Focus

- Legacy restoring row with historical ban: no replay; warning retained
- Matching ID with wrong actor/channel/comment or unsupported verb: no replay
- A later audit cannot replace the bound intent, even with equal or skewed timestamps
- Explicit Undo can reconstruct an unbound legacy restore without reusing an old restore row
- Stale finalization/release cannot clear a newer claim

## Task 1: Bind and validate human-action claims

**Files:** schema.ts, testdb.ts, enforcement.ts and recovery tests; log/queue +page.server.ts and action tests; new migration and Drizzle metadata; pipeline test support and fixtures

**Interface:** `finalizeHumanIntent(channelId, commentId, action, intentId, expected?)` requires the ID of the claim being finalized.

- [x] Add failing real-SQLite regression proving legacy history is never replayed
- [x] Run it and confirm the current code attempts the old ban
- [x] Add nullable restore-intent column, migration, and test DB schema support
- [x] Write/bind audit IDs atomically in queue and Undo claims; reconstruct legacy Undo explicitly
- [x] Recover by exact ID with actor/channel/comment/verb guards; warn on unmatched rows
- [x] Clear the binding only on matching finalize/release; keep stale-claim protection
- [x] Add tests for current claims, all invalid binding classes, legacy resume, rollback, and stale workers
- [x] Run focused tests, then independent code review
- [ ] Run check, build, all test shards, migration verification on disposable local SQLite
- [ ] Commit, push authorized branch, open draft PR against main, verify remote SHA and CI status

## Rollout and legacy recovery

- This draft is independent of the fairness branch and its 0064 migration
- Before merging this recovery PR: merge fairness first, rebase recovery, preserve both journal entries, regenerate snapshot 0065 over snapshot 0064, and rerun checks/migration tests
- Do not deploy recovery ahead of fairness: the timestamp-based migrator could otherwise skip the later-added lower migration
- Existing restoring rows are deliberately left unbound; no historical action is guessed or replayed
- Owners can explicitly retry Undo where offered in the audit log, which creates a new bound restore intent; rows without an available Undo or with invalid non-null bindings require operator investigation
- No production records were inspected, so whether any existing row needs manual recovery is unknown
- All database verification here uses disposable local SQLite only

## Verification record

- Historical-ban regression observed RED against main, then GREEN with explicit binding
- Focused recovery, route, and migration tests: 71 passed; enforcement harness: 55 passed
- Fresh read-only whole-branch review: no confirmed important blockers
- Standalone 65-migration and combined 66-migration disposable SQLite trees apply and rerun idempotently, including incremental main → fairness → recovery sequence
- verify-migrations: both standalone and combined trees pass
- drizzle-kit check: standalone snapshot chain passes
- Aggregate check, build, and full suite pending the shared validation resource window
