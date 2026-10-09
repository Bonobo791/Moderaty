# Moderaty merge evidence

Prepared and locally validated October 9, 2026. Design approved by the owner
in the separate Merge Evidence Gate session. Branch:
`task/merge-evidence-gate-2026-10-09`, based on main
`496565f0187fed87238d31e6aae0f06955d2036c`.

The uniquely named `Merge evidence verification` check runs for human and agent PRs targeting
`dev` or `main`, including PR-body edits. It executes `npm test` with the
upstream JSON reporter on Node 24.19.0. Existing `checks.yml`, application
tests, mutation/property tests and dependency manifests are unchanged.

The action and example-harness checkout are pinned to
[`d72ca6de67c38bab028015991203c7eeff4dce90`](https://github.com/axigatelabs/merge-evidence-gate/tree/d72ca6de67c38bab028015991203c7eeff4dce90),
dated September 6, 2026. Reviewed `action.yml`, `src/main.ts`, `src/pipeline.ts`,
the claim/runner/diff/reconciliation sources and the committed action bundle.

## Execution and review

- Install with `npm ci --ignore-scripts`, then explicitly sync/check SvelteKit.
- Reject any replacement or narrowing of the current `vitest run` npm script.
- Remove old root reports and receipts before executing the pinned action.
- Reject missing/old reports, wrong revisions, incomplete/unreliable diffs, zero executed
  tests, any failing test/process, a FAIL verdict and a NEUTRAL abstention.
- Fail on inflated comparable test counts and a checked claim that tests were
  added when the diff contains no test edits.
- Surface deleted/skipped/focused tests and verification-layer changes as
  NEEDS_HUMAN. Both the action and verifier now block these findings;
  there is no contributor-controlled waiver.
- Preserve existing failures: automatic failure-time base comparison is enabled, and
  every nonzero head test exit still blocks, including pre-existing failures.

Receipts appear in the action's job summary and `merge-evidence-receipt`
artifact. A second artifact preserves the receipt, raw per-test results, start
marker and real-action fixture summary for 90 days, including rejected runs.
The verifier compares receipt bytes against the action's SHA-256 output,
checks the actual checkout and independently requires a working Git diff.
Changes to the gate's own scripts and policies also block for owner review.
Concurrent PR-body edits cancel superseded executions. Comment posting and signing are disabled. Permissions are only
`contents: read` and `pull-requests: read`; checkouts do not retain credentials.
No secrets, write-enabled token, `pull_request_target`, self-hosted runner,
production access, deployment or repository security-setting changes are used.

## Reproduce the examples

Check out the upstream revision above in the fixed `gate-tool` directory
alongside the Moderaty checkout; leave its source unchanged. Run from Moderaty after the locked dependency installation:

```sh
node --test scripts/merge-evidence/tests/verify.mjs
node scripts/merge-evidence/examples.mjs
npm run check
npm run build
npm test
```

The harness invokes the real pinned action bundle and actual Vitest 5.0.1 in
disposable git repositories. It uses no GitHub API token, artifact upload,
comment posting or remote moderation. It checks the upstream revision and
bundle contents before execution. The same harness runs in CI.

Local results: 25 verifier/preparation checks passed; all 23 full-feature
real-action scenarios passed their expected outcomes; results are recorded below and in the JSON evidence. Honest human work
and a legitimate added test passed. Failed assertions, failures without a
test claim, inflated counts and a false checked tests-added claim were
rejected. Skipped/deleted/focused tests, weakened CI, unmentioned dependencies,
snapshot/golden changes and unmentioned scope block for review. A no-op
script with an old report was rejected before execution.
`docs/merge-evidence-examples.json` records the scenario results.

Moderaty's unchanged suite passed 4,021 tests across 206 files; check reported
zero errors/warnings, and the default Netlify build passed. A nested worktree
initially caused Rolldown to resolve the unprepared parent checkout's generated
TypeScript config. Moving the worktree alongside that checkout fixed the
environment without changing application/test configuration.

## Limits and approvals

This checks supported command/count/test claims and test-file changes. It
does not measure statement/branch coverage percentages, prove assertion
quality, or interpret every prose claim. In particular the upstream C7 rule
recognizes a checked tests-added checkbox, not every sentence saying tests
were added. Smaller scoped test counts can remain unverifiable. Unsupported
claims require review; they are not confirmed by a PASS receipt.

This is not a tamper-proof security boundary. A contributor can propose
changes to this workflow, its policy, verifier or example harness. Untrusted
test code runs in the same disposable runner and could forge fresh output,
alter test configuration or modify later steps. A changed workflow could
omit the check. Merely adding this job does not make it a required check or
require the owner's review. Separate owner-approved repository protections
would be needed for that enforcement; none were changed here.

Overlock PR #221 owns assertion-weakening auditing in another session. This change
uses only new gate-specific paths; it does not edit `checks.yml`,
`package.json`, `vite.config.ts`, Stryker/Fast Check configuration or existing
tests. Reviewed the six changed paths in PR #221 on October 9: there is no
file overlap with this branch. Root package/test configuration remains untouched.
Recheck final file lists before integration.

PR #218 was opened as an approved draft. Existing checks and Merge evidence
passed at published head `2f82208`; Sonar flagged harness CLI path handling.
GitHub records owner Bonobo791 marking it ready on October 9 at 13:14 UTC;
this session did not change its draft status. Full-feature fixes are local
until separately approved for publication. Hosted re-analysis and second review
remain pending; CodeRabbit was rate-limited and cubic reached its monthly limit. No merge or deployment
is authorized. Proposed PR target follows the existing integration policy:
`dev`, with the branch based on current `main` as requested.


## Full supported checks

| Check | Evidence | Policy |
| --- | --- | --- |
| C1 | Claimed command success versus real exit | Fail |
| C2 | Comparable claimed test counts versus observed totals | Fail |
| C3 | Deleted/renamed-away tests and added skip/focus markers; missing base IDs when available | Blocking owner review |
| C4 | CI, coverage threshold, agent rules and failure-suppression edits | Blocking owner review |
| C5 | Dependency/lockfile changes not mentioned in the body | Blocking owner review |
| C6 | Snapshot/golden changes | Blocking owner review |
| C7 | Checked tests-added claim without test-file edits | Fail |
| C8 | Source paths outside described scope, with no scope exemptions | Blocking owner review |
| C9 | Head failures introduced versus failure-time base execution | Fail |

All checks are explicitly configured. `agents-only: false`, `evidence: run`,
`fail-on: needs-human`, `base-comparison: auto`, receipt upload, digest output,
job annotations and job summaries are enabled. Report and none evidence modes
are mutually exclusive alternatives that weaken execution verification and are
not enabled. The action supports only failure-time baseline comparison; passing
runs do not enumerate base test IDs. Native C5 is satisfied when any changed
dependency filename is mentioned; it does not independently review every
changed dependency. The companion Overlock audit covers assertion weakening
and narrowed collection. Neither gate proves percentage coverage or honest
assertions in adversarial code.

This installation itself changes CI and gate code, so strict policy will
intentionally reject its evidence check for owner review. An ordinary review
approval does not automatically change that check to PASS. No label, PR text,
allowlist or severity downgrade is added as a bypass; the owner must decide
how to adopt the gate under the repository's existing controls.

## Separate security approval proposal

These changes are **not applied**. They require a separate owner decision:

The current active `Main` ruleset (19972799) applies only to the default
branch and contains deletion and non-fast-forward restrictions. Preserve it.
The read-only API does not show PR/review/status-check requirements in that
ruleset. Any separate legacy protections must also be preserved. Confirm the
new uniquely named check context after its first hosted run before requiring it.

1. Require the exact `Merge evidence verification` check on `dev` and `main`,
   alongside existing checks and the separate Overlock check, without removing
   any current requirement. Require approval of the latest revision and protect
   gate paths using code-owner review. Proposed owner entries are:

   ```text
   /.github/workflows/merge-evidence.yml @Bonobo791
   /.github/merge-evidence-policy.yml @Bonobo791
   /.merge-evidence.yml @Bonobo791
   /scripts/merge-evidence/ @Bonobo791
   ```

   Owner-authored PRs cannot be approved by that same GitHub account. Review
   enforcement therefore needs another eligible reviewer or a separately
   approved adoption policy; no bypass actor is proposed here.

2. For signing, use a separate trusted receipt publisher on the default branch.
   Its permissions would be `actions: read`, `contents: read`, `id-token: write`
   and `attestations: write`. It must never check out or execute PR code, load
   candidate scripts, install candidate dependencies, or evaluate artifact text.
   It must bind the receipt to the run ID, workflow, PR, head/base SHAs and digest,
   reject unexpected archive entries/symlinks, and attest only the validated
   receipt. An attestation proves origin and bytes, not the honesty of tests.
   Native `sign: attest` in the test job would grant untrusted code those
   privileges, so that design is excluded. Key signing conflicts with the
   no-credentials constraint and is excluded.

3. Sticky PR comments would need `pull-requests: write` in that isolated
   publisher, separately from signing permissions. Use bounded plain-text
   fields, validated PR/run links and the exact receipt digest. Never grant that
   token to the PR execution job. Until approved, summaries and artifacts
   provide the receipt without comment-write permissions.
