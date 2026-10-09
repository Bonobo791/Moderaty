# Moderaty merge evidence

Prepared and locally validated October 9, 2026. Design approved by the owner
in the separate Merge Evidence Gate session. Branch:
`task/merge-evidence-gate-2026-10-09`, based on main
`496565f0187fed87238d31e6aae0f06955d2036c`.

The new `Merge evidence / execution` job runs for human and agent PRs targeting
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
- Reject missing/old reports, wrong revisions, unreliable diffs, zero executed
  tests, any failing test/process, a FAIL verdict and a NEUTRAL abstention.
- Fail on inflated comparable test counts and a checked claim that tests were
  added when the diff contains no test edits.
- Surface deleted/skipped/focused tests and verification-layer changes as
  NEEDS_HUMAN. A green execution job does **not** approve these findings.
- Preserve existing failures: base comparison is disabled, and every nonzero
  head test exit blocks regardless of whether the PR claimed success.

Receipts appear in the action's job summary and `merge-evidence-receipt`
artifact. Comment posting and signing are disabled. Permissions are only
`contents: read` and `pull-requests: read`; checkouts do not retain credentials.
No secrets, write-enabled token, `pull_request_target`, self-hosted runner,
production access, deployment or repository security-setting changes are used.

## Reproduce the examples

Check out the upstream revision above outside the Moderaty checkout; leave it
unchanged. Run from Moderaty after the locked dependency installation:

```sh
node --test scripts/merge-evidence/tests/verify.mjs
node scripts/merge-evidence/examples.mjs /absolute/path/to/merge-evidence-gate /fresh/output/directory
npm run check
npm run build
npm test
```

The harness invokes the real pinned action bundle and actual Vitest 5.0.1 in
disposable git repositories. It uses no GitHub API token, artifact upload,
comment posting or remote moderation. It checks the upstream revision and
bundle contents before execution. The same harness runs in CI.

Local results: 19 verifier/preparation checks passed; all ten real-action
scenarios passed their expected verdict/rejection checks. Honest human work
and a legitimate added test passed. Failed assertions, failures without a
test claim, inflated counts and a false checked tests-added claim were
rejected. Skipped/deleted tests and weakened CI required review. A no-op
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

Overlock owns assertion-weakening auditing in another session. This change
uses only new gate-specific paths; it does not edit `checks.yml`,
`package.json`, `vite.config.ts`, Stryker/Fast Check configuration or existing
tests. No Overlock task/branch was visible during the coordination check.
Recheck the other session's final file list before integration.

Pending gates: owner approval to push; separate draft-PR approval; exact-head
GitHub CI and complete review triage; scoped fixes for valid findings;
owner-approved readiness; second review/check pass. No merge or deployment
is authorized. Proposed PR target follows the existing integration policy:
`dev`, with the branch based on current `main` as requested.
