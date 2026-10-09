# Test Quality Sentinel

The standard GitHub Actions entry point is
`.github/workflows/test-quality-sentinel.lock.yml`. Its editable source is
`test-quality-sentinel.md`. It runs on opened, updated, reopened and ready PRs
targeting `dev` or `main`, including drafts, human-authored and stacked PRs.
The trusted `pull_request_target` trigger runs the workflow from the base branch;
PR edits cannot replace the workflow or collector in that run. Fork PRs
are excluded by an explicit repository-ID activation condition; this is not a required check
for forks. There is no author-name filter or dependency on another CI result.

The sentinel reviews useful behavioral coverage, excessive business-logic
mocking, internal-only assertions, missing error cases and duplication. It also
reads deleted tests and changed test/CI configuration. It posts an advisory
comment with the reviewed head SHA, scope, score and specific findings. It does
not execute tests, approve/merge PRs, or certify coverage. The existing `checks`
workflow remains the execution gate. A green sentinel job means the review
completed; concerns are in its comment, not a deterministic blocking verdict.

## Runtime and permissions

Uses the `COPILOT_GITHUB_TOKEN` repository secret for Copilot inference,
not application OpenAI/YouTube/database credentials. For this personal
repository, create a fine-grained PAT owned by your user account with
**Account permissions → Copilot Requests: Read**, then add it privately under
**Settings → Secrets and variables → Actions** as `COPILOT_GITHUB_TOKEN`.
The token owner needs an active Copilot license and access to the selected model.
Do not paste the token into PR comments, source files or workflow logs.

The workflow deliberately omits `copilot-requests: write`: that Actions-token
path requires centralized organization Copilot billing and ignores the PAT.
The live Actions-token attempts rejected both the default model and explicit
GPT-5.4. Until the secret is configured, the sentinel fails visibly; there is
no successful-review fallback. See [GitHub's authentication guide](https://github.github.com/gh-aw/reference/auth/).

The agent has read-only contents/PR permissions. The generated safe-output and
conclusion jobs request `issues: write` and `pull-requests: write` for GitHub's
comment machinery; they do not check out or execute candidate code. Issue
failure reports are disabled. All action references are immutable SHAs and
container images have digests. The main Copilot CLI version is pinned to
`1.0.87`, with explicit `copilot/gpt-5.4` model selection. An unpinned
`auto` alias selected an unsupported model during the initial live run. The framework's secondary detection engine is compiler-managed.

The collector is checked out separately at the reviewed immutable commit
`81ea1fd9aee316893c2c4a22de4ea75644be8ca8`. The evidence repository stays
at the event's base SHA. The collector fetches the PR head
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

The pinned collector allows the introduction PR to run even when its target
branch does not contain the collector yet. Updating the executable collector
requires reviewing and publishing its commit first, then updating the workflow's
pin. PR changes to the collector are evidence only until that explicit update.
Nothing here modifies repository security settings.

Compile with the reviewed `gh-aw` v0.89.21 binary:

```sh
mkdir -p .tools
cp /path/to/reviewed/gh-aw .tools/gh-aw
node scripts/compile-test-quality-sentinel.mjs
```

Linux binary SHA-256:
`1c74ff5fc28b1891d32b67f4348a9b7f750946b6d4a721e909187a848868016b`.
Commit both Markdown and generated YAML. Inlining enables full prompt hashing
in the framework's stale-lock check. Review action/container changes on each
compiler upgrade; never hand-edit generated YAML.

The wrapper accepts no CLI arguments and reads only `.tools/gh-aw`.
It verifies the compiler checksum, uses the pinned strict compilation
options, then normalizes the generated gateway mask to a literal `printf`
command. Masking stays enabled. Unexpected masking output fails visibly;
recompilation preserves this normalization without manual YAML edits.

An agent with repository write access could still weaken/delete the Markdown,
generated workflow, evidence collector, triggers or prompts. This workflow
protects the current run from PR edits, but changes merged into the trusted base
can still weaken future runs. Enforcing human review of those paths requires a
separately authorized ruleset/CODEOWNERS policy. No policy was changed here.

## Trigger security review

Switching to `pull_request_target` makes the base-branch workflow the trusted
control plane. The generated activation job excludes forks before accessing
secrets. The agent has read-only permissions, checks out only the base SHA and
the pinned collector, and reads candidate commits as Git data. No new or removed
secrets, actions, containers, or network redirects accompany this change;
`COPILOT_GITHUB_TOKEN` remains the inference credential. The trigger's compiler
security warning is expected and reviewed for these constraints.

The add-mask audit rule flags every masking command, regardless of shell syntax.
The generated mask stays enabled; removing it to clear the audit would expose
the gateway credential. Local Lizard v1.24.1 measures `matchesEntityTag` at five
lines, so the reported 155-line function is a parser false positive.

## Validation and limits

`npm test -- scripts/test-quality-context.test.mjs` uses real disposable Git
repositories, including:

- a precise boolean assertion weakened to `toBeDefined`;
- a renamed/deleted test and newly excluded test directory;
- a legitimate regression-only `.spec.ts` addition;
- docs-only edits, oversized evidence and invalid refs;
- candidate code that throws if executed and unrelated working-tree edits;
- wildcard filenames, ensuring diffs cannot accidentally include other tests;
- an older base missing the collector and a malicious candidate collector,
  verifying that the workflow executable collects evidence without running candidate code.

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
