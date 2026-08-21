<!--
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher

Licensed under the PolyForm Shield License 1.0.0; you may not use
this file except in compliance with the License. You may obtain a
copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.

The software is provided "as is", without warranty or condition of
any kind, express or implied. See the License for the specific
language governing permissions and limitations under the License.
A copy of the License is included in the LICENSE file at the
repository root.

Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md
-->

# Property-Based Testing with fast-check

Repo conventions for property-based tests (PBT). The *what to test* catalog
lives in the fast-check-testing skill
(`.agents/skills-src/fast-check-testing/references/moderaty-context.md`, which
maps invariants I1–I13 to properties); this document is the *how to write them
here*. Properties complement example tests and mutation testing — they never
replace either, and **property tests never count toward Stryker kill claims**
(kills stay example-based, proven by survived→killed scoped re-runs).

## Where things live

- Shared arbitraries: `src/lib/server/testarbitraries.ts` — hand-built from the
  drizzle schema and API shapes (no zod). It sits **in** the Stryker mutate
  scope on purpose: a silently weakened arbitrary would weaken every property
  using it, and properties cannot be trusted to kill point mutants in the
  generators themselves. Its construction contracts are pinned by
  `src/lib/server/testarbitraries.test.ts` (its kill basis — keep it at 100%).
- Property tests: `*.pbt.test.ts` next to their sources. The mutation-hardened
  `*.test.ts` files are never touched by property batches.
- Runner config: importing `testarbitraries.ts` sets `numRuns` globally from
  `FC_NUM_RUNS` (default 100; a set-but-invalid value throws loudly). Use
  `FC_NUM_RUNS=10000 npx vitest run <file>` for local burn-in.

## The non-negotiable conventions

1. **Predicates return nothing.** fast-check treats any return value other
   than `undefined`/`true` as a failing verdict, and vitest's `expect()`
   returns an `Assertion` object — so a single-expression arrow like
   `(x) => expect(x).toBe(y)` fails every run no matter what. Always use a
   block-bodied predicate with `expect` inside (this bit us on first contact;
   the repro is in the batch log below).
2. **Fresh state per run, not per test.** One property runs ~100 predicates
   inside a *single* vitest test — `setupTestDb`'s per-test wipe is not enough.
   Call `wipeTables([...])` (from `testdb.ts`) inside the predicate, or build
   the system-under-test per run.
3. **Determinism is a prerequisite.** Time comes in as generated data
   (`pastIsoArb(now)`, explicit `now` parameters) — never read the clock inside
   a predicate, and **never mix `fc.asyncProperty` with vitest fake timers**
   (deadlock risk). Mock the network *outside* the property (stub fetch once,
   feed generated bodies through it); generated inputs stay inside.
4. **Constrain by construction.** No `.filter`/`fc.pre` for anything rejecting
   more than ~10% of values — build the shape you need (`map`, `chain`,
   `uniqueArray`, composed records). Hostile data by default: don't narrow
   arbitraries to the happy path unless the property is explicitly about
   validated input.
5. **Every failure is replayable.** fast-check prints `seed`/`path` (plus
   `replayPath` for `fc.commands`) on every failure — paste them into the PR
   and convert the shrunk counterexample into an `examples:` entry or a
   standalone regression test. Never delete a "flaky" property; the seed makes
   it deterministic.
6. **A property that cannot fail is worse than none.** Every new property gets
   a deliberate-break check (mentally break the logic, or confirm via a Stryker
   survivor flip) documented in its batch log row.

## Stryker interplay

- Stryker always runs with `--ignoreStatic`; verification runs use a fresh
  incremental cache and `--concurrency 1` (concurrency 4 showed false
  survivors in batch C of the mutation program).
- A survivor inside property-covered code means the property is
  under-constrained — triage per the mutation-testing skill (genuine gap →
  example test; equivalent → exclusion with justification).
- `testarbitraries.ts` changes always ship with a scoped Stryker run proving
  the module stays at 100%.

## Batch log

| Batch | Branch / PR | Scope | Outcome |
|---|---|---|---|
| Infrastructure | `pbt-infra` | `testarbitraries.ts` + meta-tests (27), `wipeTables` extraction, this doc | 27/27 meta-tests green; scoped Stryker on `testarbitraries.ts` + `testdb.ts` **100%** — 49+27 killed, 0 survived, 1 justified exclusion (response `kind` string never read by the parser) |
| P1 | `dev` | crypto round-trip + tamper + wrong-key (3 properties), oauthState store/read round-trip & cap + read totality (2), session token uniqueness/format + sliding-cap dichotomy (2) — `crypto.pbt.test.ts`, `oauthState.pbt.test.ts`, `session.pbt.test.ts` | 7/7 properties green (default 100 runs each; full suite 1041 tests green). Burn-in at FC_NUM_RUNS=1000 caught one under-constrained arbitrary: the tamper index could land on a base64 char carrying padding bits ("XX==" quantum), leaving decoded bytes unchanged — counterexample `["",74357335,1]` fixed by excluding the last three chars, pinned as an `examples:` entry. Mental-mutation check per property documented in `// Property audit:` comments (tag-ignored decrypt, uncapped store, missing lazy delete, flipped renewal guard all go red). No source bugs found |
| P2 | `dev` | tenant 404-never-403 across generated tenant pairs and channel shapes (1 property) — `ownership.pbt.test.ts`; `deleteUserRecords` whole-database conservation over generated org graphs (1), `nullExpiredConsentEmails` cutoff-zone sweep + idempotency (1) and 50-row batch bound with generated backlog size (1) — `deletion.pbt.test.ts` | 4/4 properties green (default 100 runs each; full suite 1045 tests green). FC_NUM_RUNS=1000 burn-in green, no counterexamples. Conservation property compares the ENTIRE post-deletion database against an oracle computed from a before-snapshot (tombstone, dissolve/detach, succession with generated join times, other-tenant byte-identity, consents never touched). Lessons: orgGraphArb membership pairs need dedupe before insert (composite PK — documented on the arbitrary); distinct tenants built by prefixing generated hex ids with a non-hex char (constrain by construction, no `.filter`); batched `insert().values([...])` keeps a 1000-run burn-in of an 11-table graph at ~4s. Mental-mutation audits in `// Property audit:` comments (dropped orgId conjunct, 403 leak, skipped detach/tombstone/succession, flipped cutoff predicate, dropped sweep limit all go red). No source bugs found |
| P3 | `dev` | I4 idempotent ingest over generated NewComment pages (whole-database byte-identity across two runs, within-batch duplicate tail, storage ≤500/no-PII oracle folded in) + I11 scoring-failure → human queue over generated failure masks (2 properties) — `pipeline.pbt.test.ts`; I6 validateRule↔recheck dichotomy over `fc.string({maxLength:300})` + keyword case-insensitivity over generated casing (2) — `rules.pbt.test.ts` | 4/4 properties green (default 100 runs each; full suite 1049 tests green). FC_NUM_RUNS=1000 burn-in green (~6s), no counterexamples. Harness: runChannel against the REAL testdb (only network/env seams mocked — youtube, scoreComment, tone, openaiKey, crypto.decrypt, $env; serializeScores and http deadline helpers real); channelRowArb seeded bare (channels has no FKs), toneLevel 1, no rules. Lessons: the env mock must forward `FC_NUM_RUNS: process.env.FC_NUM_RUNS` or testarbitraries' global numRuns config silently stops honoring burn-in in that file; the deterministic scorer is a pure hash of text into [0,0.99] so both idempotency runs decide identically and every decision band is swept; the generated failure mask is per-comment but the scorer is text-keyed, so expectations use the same text-keyed predicate (duplicate texts fail together). Item-level I1 at pipeline scope is redundant with the parser-level fuzz (testarbitraries.test.ts) — the pipeline only ever sees the parser's OUTPUT shape, so NewComment-level data is generated instead of a duplicate property. Mental-mutation audits in `// Property audit:` comments (dropped stored-ids/within-batch dedupe, author-PII writes, untruncated text, escaping scoring throw, auto-approve/reject of failures, dropped recheck/length/compile guards, dropped case folding all go red). No source bugs found |
| P4 | `dev` | I3 reconciliation convergence over generated pass plans (bounded repeated runChannel passes with generated per-pass seam failure masks + observed verification statuses; completion honesty via an enforced ∪ verified-terminal oracle; monotonic completed-set; exact completion-audit multiset) (1), I8 dry-run whole-database conservation with pre-stored comments, keyword rules, and outstanding actions (1), I10 boundedness + cursor instant-monotonicity + resume-without-duplicates over generated multi-page comment sets (1) — `pipeline.reconciliation.pbt.test.ts` | 3/3 properties green (default 100 runs each; full suite 1052 tests green). FC_NUM_RUNS=1000 burn-in green (~14s), no logic counterexamples. Approach for I3: a GENERATED SEQUENCE of pass plans, not `fc.commands` — runChannel is strictly sequential per channel, so a sequence exercises the same state space with a far simpler oracle, and no interleavings exist for `fc.scheduler` to explore. Lessons: the real retry semantics are claim-first — claimPendingActions flips pending→dispatched BEFORE enforcement (I3 DB-before-remote), so a seam failure never leaves a row 'pending' after the first pass and a single fully clean pass converges any outstanding mix (bound: actions + 2 passes, last pass forced clean); verification failures are NOT item-isolated — they abort the run loudly by design (matched, not assumed); reconciliation never rewrites comments — status is fixed at decision time, so the comment-consistency oracle is byte-identity; `ChannelRunResult.partial` is deadline-only — an incomplete scan lives on the channel row (nextPageToken/scanCursor), asserted as such. Two harness counterexamples, both test-side: mock implementations survive `vi.clearAllMocks()` across tests, so per-predicate guarded closures leaked into the next test (fixed with an explicit `resetSeamDefaults()` per predicate); a 1000-run burn-in of multi-pass predicates exceeds vitest's 5s default test timeout (explicit per-test timeout). Expectations for the post-drain re-scan need an independent `simulateWalk` restatement of the seam contract — run 2 stops mid-page at the committed high-water cursor, so raw page counts are wrong. I10 remainder (documented, out of scope): the cron route's channel-selection query (least-recently-run rotation) lives inline in `src/routes/api/cron/+server.ts` and is not property-tested — testing it needs a source extraction, which a test-only batch must not do. No source bugs found |

First-contact lesson (infra batch): three meta-tests failed on values that
should pass — single-expression arrow predicates returned vitest's `Assertion`
object, which fast-check reads as a failing verdict ("Property failed by
returning false"). Convention 1 exists because of this.


## Review deferrals (PR #125 triage, 2026-08-06) — ALL RESOLVED 2026-08-07

The five maintainer-gated fast-check findings were all assigned and fixed in
the 2026-08-07 triage round: (1) unused `SeededAction`/`PassPlan` interfaces
deleted, (2) vacuous `rules.pbt.test.ts` assertion removed, (3) `RENEW_BELOW_MS`
exported from `session.ts` and imported by `session.pbt.test.ts`, (4) S5906
`toHaveLength` assertion adopted, (5) `testarbitraries.ts` channel/user shapes
deduped with identical generation semantics.

_Resolved 2026-08-07 triage:_ the maintainer pasted Codacy's itemization — the
Security high was **not** the test key but `dotenv-cli: ^11.0.0` in
`package.json` (rule: "package dependencies with variant versions may lead to
dependency hijack"). The dependency was added by the "package update" commit
(be0793d) with no script or code using it, so it was **removed** outright
(package.json + package-lock.json) rather than pinned — eliminating both the
variant-version surface and an unused dependency outside the approved list.

## Roadmap (catalog details in the skill reference)

- **Future:** burn-in job with high `FC_NUM_RUNS` — same posture as Stryker
  CI: local/agent-driven unless the maintainer approves a CI gate.
