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

First-contact lesson (infra batch): three meta-tests failed on values that
should pass — single-expression arrow predicates returned vitest's `Assertion`
object, which fast-check reads as a failing verdict ("Property failed by
returning false"). Convention 1 exists because of this.

## Roadmap (catalog details in the skill reference)

- **P3 — pipeline fuzz:** I1 malformed item/response handling, I4 idempotent
  ingest, I11 scoring failure → review queue, comment storage ≤500 / no
  author PII persisted.
- **P4 — model-based/async:** I3 reconciliation convergence (`fc.commands`),
  I8 dry-run zero durable writes, I10 bounded cron (`fc.scheduler`).
- **Future:** burn-in job with high `FC_NUM_RUNS` — same posture as Stryker
  CI: local/agent-driven unless the maintainer approves a CI gate.
