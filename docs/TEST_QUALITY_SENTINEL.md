# Test Quality Sentinel

The standard GitHub Actions entry point is
`.github/workflows/test-quality-sentinel.lock.yml`. Its editable source is
`test-quality-sentinel.md`. It runs on opened, updated, reopened and ready PRs
targeting `dev` or `main`, including drafts and human-authored PRs. Fork PRs
are excluded by gh-aw's default activation policy; this is not a required check
for forks. There is no author-name filter or dependency on another CI result.

The sentinel reviews useful behavioral coverage, excessive business-logic
mocking, internal-only assertions, missing error cases and duplication. It also
reads deleted tests and changed test/CI configuration. It posts an advisory
comment with the reviewed head SHA, scope, score and specific findings. It does
not execute tests, approve/merge PRs, or certify coverage. The existing `checks`
workflow remains the execution gate. A green sentinel job means the review
completed; concerns are in its comment, not a deterministic blocking verdict.

## Runtime and permissions

Uses native Copilot authentication (`copilot-requests: write`), not application
OpenAI/YouTube/database credentials. GitHub must permit Agentic Workflows and
native Copilot requests for this repository/account. Runtime availability and
usage billing must be verified in the first authorized Actions run; no live AI
request was made during local validation. Missing access fails visibly.

The agent has read-only contents/PR permissions. The generated safe-output and
conclusion jobs request `issues: write` and `pull-requests: write` for GitHub's
comment machinery; they do not check out or execute candidate code. Issue
failure reports are disabled. All action references are immutable SHAs and
container images have digests. The main Copilot CLI version is pinned to
`1.0.87`. The framework's secondary detection engine is compiler-managed.

The collector executes from the event's trusted base SHA, fetches the PR head
as Git data, verifies the fetched SHA and compares from the merge base. It never
checks out, imports or runs candidate files. Credentials are not persisted by
checkout or by the fetch invocation. The agent's default checkout and file
editing tools are disabled; custom instructions are disabled with `bare`.
The compiler's activation/detection jobs may read candidate files as data.

Evidence includes complete before/after bodies and related source. More than
500 changed files, evidence over 2 MB, absent refs and fetch errors fail loudly;
there is no truncated clean-review fallback or reused cache. Reviews above
50 behavioral cases must explicitly report incomplete scope. The prompt also
requires checking for a moved PR head before publishing a verdict.

## Activation and maintenance

The collector must first exist on the target branch. The initial introduction
PR cannot run this base-only collector if its base lacks the file; it fails
loudly rather than executing the proposed collector with credentials. After
the human integrates it, subsequent PRs can run normally. Nothing in this
change modifies repository security settings or activates a workflow remotely.

Compile with the reviewed `gh-aw` v0.89.21 binary:

```sh
gh aw compile test-quality-sentinel --strict --action-mode release \
  --action-tag c35393777e5604a63721d09512263b1383301d4f --no-check-update
```

Linux binary SHA-256:
`1c74ff5fc28b1891d32b67f4348a9b7f750946b6d4a721e909187a848868016b`.
Commit both Markdown and generated YAML. Inlining enables full prompt hashing
in the framework's stale-lock check. Review action/container changes on each
compiler upgrade; never hand-edit generated YAML.

An agent with repository write access could still weaken/delete the Markdown,
generated workflow, evidence collector, triggers or prompts. This workflow
does not protect itself. Enforcing human review of those paths requires a
separately authorized ruleset/CODEOWNERS policy. No policy was changed here.

## Validation and limits

`npm test -- scripts/test-quality-context.test.mjs` uses real disposable Git
repositories, including:

- a precise boolean assertion weakened to `toBeDefined`;
- a renamed/deleted test and newly excluded test directory;
- a legitimate regression-only `.spec.ts` addition;
- docs-only edits, oversized evidence and invalid refs;
- candidate code that throws if executed and unrelated working-tree edits;
- wildcard filenames, ensuring diffs cannot accidentally include other tests.

These tests prove evidence collection and isolation, not AI judgment quality.
Strict compilation proves schema compatibility and pinned workflow generation.
Local review of synthetic weakening and legitimate examples is a rubric check;
it is not a measured live model evaluation. Before treating the reviewer as
effective, validate actual comments on authorized synthetic PRs with weak
internal-only/mock-heavy tests and useful regression/persistence tests. Check
both true positives and false positives; never infer effectiveness from a
green workflow run alone.

Source reviewed on 2026-10-09:
[GitHub's sentinel](https://github.com/github/gh-aw/blob/main/.github/workflows/test-quality-sentinel.md)
and [pinned compiler source](https://github.com/github/gh-aw/tree/c35393777e5604a63721d09512263b1383301d4f).
The adaptation removes Go-specific rules, repository-local telemetry imports,
experimental model allocation, brittle added-line-only extraction and automatic
PR approvals. A large test/production line ratio is context, never a violation
by itself; legitimate regression tests need no production-code changes.
