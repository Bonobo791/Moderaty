# Moderaty test-integrity audit

Reviewed and validated locally on October 9, 2026. The task branch starts at main
commit `496565f0187fed87238d31e6aae0f06955d2036c`.

## What runs

`.github/workflows/overlock.yml` audits every pull request to `dev` and `main`,
including drafts, with no author filter or changed-path filter. It checks the
complete diff between the PR's merge base and its exact head commit. An empty
diff or an analysis error fails the job. The report identifies both commits,
the diff hash, file/commit counts, engine version and policy version.

The job uses a read-only token, GitHub-hosted runner, disabled checkout
credential persistence, and no application secrets. It does not run Moderaty's
package scripts, tests, migrations, build, or external services. Existing
`checks.yml` continues to run the application check, build and test commands.

After installation on a base branch, the job reads its audit scripts and
dependency lock from that branch's exact PR base commit. Changes to those
scripts in the candidate do not take effect in that run. The first installation
has no baseline policy: the workflow prints a bootstrap warning and validates
the new candidate policy in the same unprivileged runner. Review that initial
policy before trusting subsequent results. Removing or changing the workflow
itself remains possible until GitHub enforces the review rules below.

## Pinned dependencies

The [Overlock composite action](https://github.com/rxova/overlock/blob/dabf34a8b0595bd11f5be8b5b59ef3c6b01ca24c/action.yml)
is pinned to `dabf34a8b0595bd11f5be8b5b59ef3c6b01ca24c` (September 30, 2026).
The action calls Moderaty's adapter through its supported `cli-path` input.
PR comments are disabled, so it needs no `pull-requests: write` permission.

The independently published engine is `overlock@0.10.4`, installed with
`npm ci --ignore-scripts` from `.github/overlock/package-lock.json` in a temporary
directory outside the candidate checkout. The lock records the tarball's SHA-512
integrity. The adapter verifies the reviewed `dist/index.js` and
`dist/evaluation.js` SHA-256 hashes before importing either file. The engine has
no runtime dependencies. SHA-256 digest buffers use `timingSafeEqual` against
the public pinned digests. The action's default `latest` install path is unused.
Moderaty's root package manifest and lock stay unchanged.

## Enforcement policy

The adapter uses Overlock's actual rule output before suppression, allowances
or severity configuration. It ignores `overlock.config.json`, the `overlock`
package key, `overlock-ignore` directives, `Overlock-Allow` trailers, PR-body
allowances, and requested severity downgrades. It writes no ledger or evaluation
files and does not exclude `.overlock` or any other directory from the diff.

Skips, focused tests, weakened/narrowed/removed assertions, narrowed test data,
narrowed suite collection, disabled test gates and lowered thresholds block
the run. High-severity deleted-test findings also block. Medium deleted-test
findings, such as a complete relocation, remain visible for review. Expected
literal changes and other medium/low findings also remain visible.

The adapter aliases only the patch headers for `vite.config.ts` to a recognized
Vitest config path, then restores the real path in findings. Upstream already
checks Vite thresholds through its generic config fallback; the alias adds
include/exclude scope checking. No config code executes.

Added Vitest `it/test/describe/suite.skipIf(...)` or `.runIf(...)` declarations
also block through a supplemental detector. It flags direct declarations even
when the condition currently allows execution, since a later environment can
skip them. Declarations spanning added and unchanged lines are included, along
with argument-only changes inside existing multiline declarations. Old and
new condition spans are compared, so deletion-only changes also require review
and unrelated edits after the closing parenthesis do not change the verdict. The span
scanner handles nested parentheses, quoted strings and comments without
executing code. Regex/division and template expressions are conservatively
scoped to the rest of the hunk, so unrelated edits there can require review.
Dynamic aliases and indirect helper calls still require review.

Supplemental JSON comparisons cover the actual `stryker.config.json`: lowered
or removed `high`, `low` or `break` thresholds; removed positive mutation
patterns; removal of explicit mutation scope or its config; and added
exclusions. Replacing a positive pattern requests review
even when a maintainer intends an equivalent rewrite. Invalid config or an
unsupported config object fails loudly. A config with object-valued `mutate`
entries requires a reviewed adapter update before it can pass.

Starting main has no Stryker threshold object. This task does not introduce a
new mutation-score requirement or change existing Stryker/Fast Check tests.

## Local verification

Install and run the dedicated probes:

```sh
npm ci --prefix .github/overlock --ignore-scripts --no-audit --no-fund
node --test scripts/overlock/audit.probe.mjs
```

Audit a committed task branch:

```sh
node scripts/overlock/audit.mjs check --base <40-character-base-commit-SHA> --json
```

The audit reads committed objects, not uncommitted edits. A GitHub run uses the
exact PR head checkout. Local changes need a local commit before this command
can judge them. The adapter and probes use `/usr/bin/git` directly, matching
the supported Ubuntu runner. Local verification requires that executable;
candidate changes to `PATH` cannot substitute their own Git program.

On October 9, 2026:

- All 48 dedicated probes passed after review fixes. They include deleted files/cases, skip/only/todo,
  conditional skip/run declarations,
  weakened/removed assertions, reduced objects/data, runner filters, coverage
  reductions, disabled CI, and Stryker threshold/scope changes.
- Benign controls passed for new cases, stronger assertions, formatting, exact
  null assertions, test relocation, higher thresholds and expanded scope.
- A real temporary git repository proved that configuration, commit/PR
  allowances and hostile package scripts cannot clear a skip or execute the
  application. Invalid bases and empty diffs failed.
- A review regression first demonstrated that an executable supplied through
  `PATH` ran in place of Git. Calling `/usr/bin/git` directly made the same
  probe retain the blocking verdict without executing the hostile program.
- Five new review regressions failed for multiline conditional declarations
  and removed Stryker scope/config, then passed after the detector fixes. An
  additional benign control accepts unrelated edits beside an unchanged
  conditional declaration.
- Five condition-only review probes failed before the next fix, then passed
  for skip/run, nested calls, quoted parentheses and comments. A benign control
  still accepts unrelated body edits after a complete multiline condition.
- Tampered `index.js` and `evaluation.js` each fail before import. Disabling
  integrity verification in a temporary copy caused both tamper probes to
  fail. Fixture template strings were rewritten without changing their cooked
  text, detector assertions or deliberate weakening cases.
- Deletion-only `runIf` narrowing and an unrelated trailing comment on the
  condition's closing line each failed their expected verdict before the
  span-comparison fix, then passed. The earlier condition-change controls
  remain blocking.
- The pinned composite action's analysis shell step accepted a legitimate
  change (status 0), rejected a skipped-test change (status 1), and failed on
  empty analysis (status 2). Its final failure step exited 1 for a failed report.
  These were local action-contract runs, not hosted GitHub Actions runs.
- Against the original 32 controls, deliberately replacing the detector with an always-green result caused 21
  probe failures. An always-blocking result caused 5 failures. Removing the
  Vite alias caused 2 failures; removing the conditional-skip detector caused
  2 failures. No committed test or production file was weakened.
- `npm run check`, `npm run build`, and the existing 4,021 tests in 206 files passed.

These fixtures establish behavior for the labeled examples, not a general
detection rate. The audit does not execute application behavior or assess intent.
Hosted Overlock, application validation, SonarCloud, CodeQL and Semgrep passed
on PR #221 at commit `cc49bc5`. Further review changes remain local pending
owner approval to push. Scanner/review limitations are recorded on the PR;
these checks do not establish integration readiness.

## Require the owner's permission for CI changes

GitHub can require owner approval before changes reach `dev` or `main`.
`CODEOWNERS` alone only requests reviews; pair it with an enforced ruleset or
branch protection rule on both branches. This task does not apply those settings
or change the shared ownership file.

Add these entries at the end of `.github/CODEOWNERS`, preserving existing owners
for other files. Confirm `@Bonobo791` is the intended approving account:

```text
/.github/                  @Bonobo791
/scripts/overlock/          @Bonobo791
/scripts/stryker*           @Bonobo791
/package.json              @Bonobo791
/package-lock.json         @Bonobo791
/vite.config.ts            @Bonobo791
/stryker.config.json       @Bonobo791
```

Protecting all of `.github/` covers the ownership file, workflow definitions,
local actions, and isolated tool locks. The last matching ownership pattern
wins; do not add a later pattern that transfers these files to an agent.

For both branches, require pull requests, at least one approval, and review
from code owners. Dismiss stale approvals after new commits and restrict review
dismissal where available. Require the `Overlock audit` status check and existing
validation checks. Disable direct/force pushes and grant agent integrations no
bypass permission. Ensure administrators cannot bypass the rules during routine
agent work. Review the initial workflow before making its status required.

Use an agent GitHub App or separate bot identity with no administration access.
An integration acting with the owner's own account/administrative credentials
can exercise that owner's authority; GitHub cannot treat it as a different
person. GitHub also does not permit PR authors to approve their own PRs, so
owner-authored PRs need a separate review path.

See current GitHub documentation for [code ownership](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners),
[ruleset review requirements](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
and [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
checked October 9, 2026.

## Remaining escape routes and false positives

An agent can still propose edits that disable/delete the workflow, change its
events or conditions, swallow its exit code, select a different comparison
base, replace the action revision, or alter policy selection/bootstrap behavior.
Protecting the workflow in GitHub is essential; a workflow cannot enforce its
own continued existence. The baseline adapter and lock prevent candidate policy
edits from taking effect once the audit is installed, but approved changes to
the baseline can still weaken future runs.

Overlock uses diff heuristics. Matching relocated cases by title/body does not
prove they still test the same behavior. Dynamic or aliased skips/assertions,
custom helper implementations, computed thresholds, changes in test fixtures,
and arbitrary script logic can escape recognized patterns. Expected-value
changes can also be wrong while producing only a medium finding. Review these
findings and retain real behavior tests and mutation testing.

Legitimate assertion refactors or equivalent mutation-pattern rewrites may
block. No PR can approve its own suppression. Restore the tested behavior or
obtain a separately reviewed policy change; do not lower the overall gate to
make a single PR green.

## Other testing sessions

This branch adds only `.github/workflows/overlock.yml`, `.github/overlock/`,
`scripts/overlock/`, and this document. It changes no existing application code,
tests, package files, CI workflows, ownership files or test configuration.
Merge Evidence Gate and the protected-handle Playwright session can use their
own workflows and directories. A later `CODEOWNERS` change or required-check
configuration affects those sessions too and needs owner coordination.
