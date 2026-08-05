<!--
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
-->

# Cross-Tenant Security Audit — 2026-08-05

Scope: every Drizzle mutation and every HTTP/cron-reachable read in the
backend, audited against the tenancy key model below. Method: static
inventory of ~60 call sites (file:line + verbatim predicate), verdict per
site, two-tenant behavior tests as the executable pin, and zero-count
runtime invariants in `scripts/verify-tenancy.mjs`.

## Verdict on the seed finding

**"Session renewal/repair UPDATEs without their WHERE (cross-tenant session
rewrite)" — NOT PRESENT on main.**

Both `getSessionUser` UPDATEs are token-scoped and always have been:
`src/lib/server/session.ts:124` (sliding-expiry renewal) and `:128` (org
repair) both carry `.where(eq(sessions.id, token))`; the merged form landed
in `a43eda6` with the WHERE intact. The session id is the unguessable
32-byte token itself, so no cross-tenant rewrite is reachable. Pinned by the
regression test "tenancy audit seed: renewing and repairing user A's session
never touches user B's row" in `src/lib/server/session.test.ts` (passes on
main — the finding was stale, misreported, or from an old branch).

## Tenancy key model

| Table | Tenant key |
|---|---|
| `sessions` | `id` = unguessable token; `userId` |
| `channels` | `orgId` (team) / `userId` (connector); CHECK `channels_org_requires_owner` |
| `comments`, `moderation_actions`, `audit_log`, `rules` | transitive via `channelId` — handlers must pass `ownedChannel` first |
| `memberships`, `invites`, `organizations` | `orgId` + role |
| `users`, `consents` | self / server-only |
| legitimately global | cron picker + lease claim, expired-session sweep, consent-email retention sweep, migration guard, invite preview |

The load-bearing guard is `ownedChannel` (`src/lib/server/ownership.ts:43`):
`channels.orgId = user.orgId`, 404 otherwise — another tenant's channel
never leaks existence.

## Inventory verdicts

### scoped — handler-level boundaries (all covered by cross-tenant tests)

| Site | Predicate / guard |
|---|---|
| queue load + all 4 actions (`queue/+page.server.ts:30,48,54-58,73-80`) | `ownedChannel`, then claim `id+channelId+status='pending'` + `.returning`; audit insert keyed by verified channel |
| log load + undo (`log/+page.server.ts:43,76,77-81,92-96,117-137`) | `ownedChannel`, pair verified by select, conditional claim + `.returning` |
| rules load/add/remove (`rules/+page.server.ts:27,36,63-66`) | `ownedChannel`; delete `id+channelId` + `.returning` |
| dashboard tone/protections/history (`dashboard/+page.server.ts:81-91,118-163`) | `updateOwnChannel` = `id+orgId` + `.returning`; history reset adds lease predicate |
| dashboard deleteAccount → `deletion.ts:79-213` | every predicate keys off the caller's own `userId` or DB-derived org/channel ids; successor promotion `.returning`-checked |
| org routes + `org.ts` (rename/invite/revoke/setRole/remove/leave/switch/accept) | `membershipOf` + `requireRole` before each mutation; session updates `id+userId` + `.returning`; invite burn is a conditional claim; owner-count guarded by subqueries |
| consent page (`consent/+page.server.ts`) | identity from encrypted pending cookie or session; orphan claim guarded `userId IS NULL` + first-user-ever count subquery |
| `legal.hasCurrentConsent` | `userId` always from session/verified identity |
| logout `destroySession` | caller's own cookie token |

### scoped — cron/pipeline (secret-authenticated, global by design)

| Site | Note |
|---|---|
| cron channel picker + lease claim (`api/cron/+server.ts:79-92`) | atomic claim `id+lease-expired` + `.returning`; cross-tenant by design (CRON_SECRET) |
| `pipeline.ts` channel reads/updates (`:107,:510-517,:538`) | `channelId` comes from cron's own DB selection, never client input |
| `moderation_actions` claim/complete (`:362-399`) | `commentId` is the PRIMARY KEY (globally unique YouTube id); ids sourced from the channel-scoped select at `:457-464` |
| comments dedupe select (`:268-273`) | `comments.id` is the PK; a YouTube comment belongs to exactly one channel |

### legitimately global (reviewed, by design)

| Site | Reason |
|---|---|
| `session.ts:65` expired-session sweep | deletes only expired rows (no working credentials); bounds table growth |
| `deletion.ts:225-243` consent-email retention sweep | statutory retention window; cron-only, bounded batch, `DRY_RUN`-gated |
| `org.ts:222-231` invite preview | unauthenticated by design; token is 32-byte random (unguessable) |
| `migrationGuard` | deploy-ordering check, no tenant data |

## Edge notes (not breaches — documented for the record)

1. **Id-only release/commit UPDATEs** (`queue/+page.server.ts:70`,
   `log/+page.server.ts:109-112,:136`): the WHERE is `comments.id` only, but
   each is reachable solely after a channel-scoped claim or pair-verifying
   select succeeded *in the same action invocation*. A second tenant's
   comment id fails the claim first (its `channelId` doesn't match) and 404s.
   Pinned by `queue/actions.test.ts:117` and `log/actions.test.ts:175`.
2. **Shared YouTube channel across two Moderaty accounts**: if two tenants
   connect the SAME YouTube channel, the first run's stored comment ids
   dedupe-skip the second account's fetch (functional, not a leak — no data
   crosses; both parties own the underlying channel).
3. **`org.ts:379` removeMember delete** has no `.returning` — a concurrent
   membership change is a silent no-op, not a tenant issue.
4. **`org.ts:194` revokeInvite** deletes by token alone; authorization is the
   preceding `membershipOf`+`requireRole` on the looked-up invite's org. A
   revoke is idempotent, so check-then-act skew is harmless.

## Runtime invariants added to `scripts/verify-tenancy.mjs`

1. Zero sessions whose `active_org_id` is not an org the session's user
   belongs to (cross-tenant session state).
2. Zero `comments` / `moderation_actions` / `audit_log` / `rules` rows whose
   `channel_id` has no parent in `channels` (orphans from a scoping bug).
3. Zero channels whose `org_id` has zero memberships (unreachable channel).

Runbook: `node --env-file=.env scripts/verify-tenancy.mjs` (dev by default;
point `TURSO_DATABASE_URL` at prod after migrations). Exit 1 with loud FAIL
lines on any violation. READ-ONLY, as before.

## Recommendations (handoffs, NOT implemented here)

- **DB agent**: consider a real FK `comments.channel_id → channels.id` (and
  the same for `moderation_actions`/`audit_log`/`rules`) so Layer-3 orphans
  become impossible structurally instead of probe-detected.
- **Maintainer**: wiring `verify-tenancy.mjs` into CI or a scheduled run is
  a separate decision; the probe is ready for it.
