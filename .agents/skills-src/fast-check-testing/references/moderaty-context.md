# Moderaty Context — Applying fast-check in the Moderaty Repo

Project: **Moderaty** (`Bonobo791/Moderaty`) — YouTube comment auto-moderation SaaS.
SvelteKit 2 + Svelte 5 + TypeScript (strict), Vitest 4, drizzle-orm + @libsql/client on
Turso, Stryker mutation testing, Netlify deploy. Read this when writing property tests
*in that repo*; the general guidance lives in the other reference files.

## Contents

- Adoption gate: approved dependencies
- Test harness: reuse testdb.ts
- Property catalog mapped to the repo invariants (I1–I13)
- High-value property sketches
- Stryker interplay (repo-specific rules)
- Workflow integration
- Installing this skill in the repo

## Adoption gate: approved dependencies

The execution plan restricts dependencies: runtime = `drizzle-orm`, `@libsql/client`,
adapter, `recheck`; dev = `drizzle-kit`, `vitest`, Stryker packages. **`fast-check` is
maintainer-approved as a dev-only dep** (installed, plain `fc.assert` in vitest tests is
the house style); the `@fast-check/vitest` connector is NOT approved — stay with the
plain API unless the maintainer says otherwise. Note also: no zod in the repo, so
schema-derived generators (zod-fast-check) are unavailable; build arbitraries by hand from
the drizzle schema shapes (see arbitraries-cookbook.md — `fc.record` per table row type is
usually enough).

## Test harness: reuse testdb.ts

`src/lib/server/testdb.ts` already provides the correct foundation:

- Real in-memory libSQL (`file::memory:?cache=shared`) with the app schema and
  `PRAGMA foreign_keys = ON` — matches production Turso FK behavior.
- `vi.mock('$lib/server/db', ...)` routes the app db onto the in-memory instance.
- `setupTestDb(tables)` wipes the given tables before each test — for property tests,
  state must ALSO be fresh per generated run: either wipe inside the predicate or create
  the system-under-test per run (model-based `setup` function).
- Fixtures: `seedUser(id)`, `seedConsent(userId, ...)`, `TEST_OWNER`, `postForm(fields)`.

Rules: never point property tests at the Turso dev/prod databases (agents are forbidden
from prod DB changes regardless); never weaken the wipe discipline to make sequences pass.

## Property catalog mapped to the repo invariants

The AGENTS.md invariants are written as properties already — "always", "never", "only".
This table is the mapping; sketches below.

| Invariant/rule | Property | Pattern |
|---|---|---|
| I1 — external data optional; bad item skipped+counted, bad response throws | ∀ generated API payload: valid items processed, malformed items skipped and counted, batch never aborts on item garbage | Fuzzing + conservation |
| I3 — DB before remote | After any generated crash point, `action_pending` rows drive reconciliation to convergence | Model-based |
| I4 — idempotency | Ingesting the same generated comment set twice = once (dedupe by `comments.id`) | Idempotence |
| I6 — user regexes validated by recheck | ∀ generated pattern string: rejected loudly, or validated-safe and compiles; never accepted-unsafe | Fuzzing + oracle (recheck) |
| I8 — dry run | ∀ generated operation sequence under `DRY_RUN=true`: zero durable writes except `audit_log` dry-run rows | Model-based |
| I10 — bounded runs | ∀ generated fleet state: one cron invocation touches ≤1 channel, ≤100 comments; checkpoint never regresses, never skips | Invariant + monotonicity |
| I11 — AI failure → human queue | ∀ generated scoring failure: comment lands in review queue `decidedBy='none'`; never auto-approved/rejected | Metamorphic/fault-injection |
| User isolation | ∀ users A,B ∀ queries: B never reads A's channel — 404, never 403 (no existence leak) | Isolation |
| Deletion | After `deleteUserRecords`: personal channels/rules/comments/audit/memberships/sessions gone; team channels detached (`user_id` NULL + sentinel); user row tombstoned `google_sub='deleted:<id>'`; consents e-mail retained ONLY in `consents` | Conservation + invariant |
| Comment storage | ∀ ingested text: stored length ≤ 500; `author_name`/`author_channel_id` never persisted | Business rule as property |
| crypto.ts (AES-256-GCM) | `decrypt(encrypt(x, k), k) === x`; wrong key/tampered ciphertext/tag always throws | Round-trip + negative case |
| oauthState / session | state round-trips; tampered or expired state rejected; session tokens unique across generated batches; sliding expiry never extends past cap | Round-trip + invariant |

## High-value property sketches

**User/channel isolation** (the repo rule: "another user's channel always reads as 404 —
never leak existence"):

```ts
import fc from 'fast-check';
import { setupTestDb, testDb, seedUser } from './testdb';

setupTestDb(['channels', 'users']);

test('no generated query from user B ever observes user A channel', () => {
	fc.assert(
		fc.asyncProperty(
			fc.uuid(), fc.uuid(),
			fc.record({ title: fc.string({ maxLength: 50 }) }),
			async (userA, userB, channel) => {
				fc.pre(userA !== userB);
				await seedUser(userA);
				await seedUser(userB);
				const channelId = await seedChannelFor(userA, channel);
				// every access path B might use:
				expect(await loadChannelForUser(channelId, userB)).toBeNull(); // 404 path
				const list = await listChannelsForUser(userB);
				expect(list.some((c) => c.id === channelId)).toBe(false);
			}
		)
	);
});
```

Extend by generating the access path too (`fc.constantFrom('load', 'list', 'action',
'delete')`) so new routes get swept in as they're added to the set.

**I1 fuzz the pipeline boundary**: generate YouTube-shaped responses with
`fc.record({ items: fc.option(fc.array(fc.anything())) })` plus `fc.anything()` for
wholly-malformed responses; assert valid items processed + malformed items counted-skipped
+ no throw at item level, and assert throw at response level.

**I4 idempotent ingest**:

```ts
fc.assert(fc.asyncProperty(commentsArb, async (comments) => {
	await ingest(db, channelId, comments); const once = await dumpComments(db);
	await ingest(db, channelId, comments); const twice = await dumpComments(db);
	expect(twice).toEqual(once); // dedupe by comments.id; cursors/checkpoints included in dump
}));
```

**crypto round-trip**:

```ts
fc.assert(fc.property(fc.string({ maxLength: 1000 }), keyArb, (plaintext, key) => {
	expect(decrypt(encrypt(plaintext, key), key)).toBe(plaintext);
}));
// negative: any single-byte tamper of the ciphertext fails GCM verification
fc.assert(fc.property(ciphertextArb, byteIndexArb, (ct, i) => {
	expect(() => decrypt(tamper(ct, i), key)).toThrow();
}));
```

## Stryker interplay (repo-specific rules)

- **Stryker always runs with `--ignoreStatic`** (AGENTS.md rule); scoped runs via
  `npx stryker run --mutate "<glob>"` or `node scripts/stryker-pr-scope.mjs`; fresh
  worktrees need `npx svelte-kit sync` first.
- Properties live in `*.test.ts` next to sources and run under the same Vitest suite —
  Stryker's vitest runner exercises them like any test. A survivor inside property-covered
  code means the property is under-constrained; triage per the mutation-testing skill.
- The repo rule "every test must fail if the real logic is wrong" applies doubly to
  properties: hand-verify each new property can go red (mentally break the logic, or
  confirm via a Stryker survivor flip). Do not count property tests toward kill claims —
  kills remain example-based and proven by survived→killed flips on scoped re-runs.
- fast-check's determinism (seed/path in every failure) satisfies the repo's
  reproducibility expectations; paste the seed line into the PR when a property catches
  something during development.

## Workflow integration

- One branch per phase, commits as `step N: <name>`, PR stops for human merge — property
  test batches follow the same cadence as Stryker kill batches. Source changes never ride
  along with test-only batches.
- Every review finding gets a failing test BEFORE its fix — a property that reproduces the
  finding's *class* (plus the pinned counterexample via `examples:`) is the strongest form.
- Agent layers: backend agent owns `src/lib/server` tests; property tests on schema
  *structure* belong to database engineering; UI properties to frontend. Route accordingly.

## Installing this skill in the repo

Repo-local skills live in `.agents/skills-src/<name>/` and are installed by copying to
`~/.agents/skills/<name>/` (plus the `skill_prehook.py` hook pattern used by the existing
skills). To adopt: copy this skill's directory to `.agents/skills-src/fast-check-testing/`,
install, and edit in the repo from then on — the packaged `.skill` is the seed, not the
living copy.
