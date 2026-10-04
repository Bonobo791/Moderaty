# Restore Intent Binding Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent interrupted human-action recovery from replaying an unrelated historical user action.

**Architecture:** A nullable `comments.restoreIntentId` binds a restoring claim to one audit row. Human-action transactions set the binding before remote work; recovery validates the exact row and fails closed when no trustworthy binding exists. Confirmed owner recovery creates a fresh restore intent for an unverifiable claim.

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
- Confirmed owner recovery can record a new legacy restore without reusing an old restore row; ordinary Undo rejects unverifiable claims
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
- The audit log lists unverifiable restoring claims independently of audit pagination, including rows without audit history; an organization owner can explicitly confirm a new restore request without borrowing historical intent
- Ordinary Undo resumes only verified restore claims; valid pending approve/reject/delete/ban intents cannot be replaced by owner recovery, and stale recovery forms are fenced on their observed binding
- Recovery validates the current connector and then rereads the exact comment claim as its last awaited database operation before dispatch, skipping claims replaced since the initial snapshot
- The October 4 post-merge fix adds durable dispatch ownership for human intents and decided-state corrections; its recovery limits are described below
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

## October 4 post-merge remote ordering fix

- Nullable `comments.humanDispatchToken` and `humanDispatchState` reserve one comment for a human write or a corrective write. Routes and cron cannot dispatch the same intent concurrently; finalization requires the dispatch owner as well as the exact audit binding.
- Human mutations use one bounded HTTP attempt. Transparent retries after a transport failure could otherwise report a later success while the earlier write still runs remotely.
- Predispatch credential/channel failures and settled validation, authorization, or quota refusals can release a fresh claim safely. A known successful remote call followed by a database failure keeps its exact intent and releases only the settled reservation, so cron can finish recording it.
- A timeout, transport failure, uncertain server response, or process crash keeps the durable reservation. There is no expiring takeover: YouTube provides no fencing token or cancellation proof. Unknown outcomes pause newer human actions and staged enforcement and require manual investigation before any operator clears the reservation.
- The audit log displays active and uncertain writes independently of pagination, including corrections on already-decided comments. These rows cannot offer a new restore/Undo while their prior write may still land; unverifiable legacy claims without a reservation retain confirmed owner recovery.
- History rescans preserve reserved decisions, their action rows, audit history, and credit balance. They record the scan visit so a paused page does not repeatedly reclassify the same reserved comment.
- This does not provide provider exactly-once delivery or replace the existing automated moderation outbox. Previously dispatched automated writes retain their existing convergence behavior.
