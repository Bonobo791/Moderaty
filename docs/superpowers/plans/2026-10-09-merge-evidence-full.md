# Merge evidence full-feature implementation plan

> **For agentic workers:** Use superpowers:executing-plans in this session. The owner prohibits subagents.

**Goal:** Enable every applicable credential-free gate check without weakening genuine test failures.

**Architecture:** Keep the pinned action in a read-only PR job. Escalate C3–C6 and C8 to blocking human-review findings, enable automatic failure-time baseline comparison, and retain a separate verifier that rejects all failed head executions. Privileged receipt publication and repository enforcement remain separate owner approval decisions.

**Tech Stack:** Node 24.19, Vitest 5.0.1, GitHub Actions, pinned Merge Evidence Gate.

**Spec:** `docs/merge-evidence-gate.md` and owner's full-features instruction.

## Global constraints

- Modify only gate-specific Moderaty files; preserve existing tests and shared Overlock files.
- No secrets, privileged PR execution, security-setting changes, pushes or PR updates without the required approval.
- Base comparison supports `auto` and `never`, not an always-run mode.

## Review focus

- Malformed JSON must fail with the affected evidence file named.
- Missing diff structure must fail; omitted `unreliable` is valid upstream schema.
- Needs-human findings must block while preserving their receipt and reason.
- Fixture output must use a fresh temporary directory, without arbitrary CLI paths.
- Pre-existing base failures must never make a failing head run pass.

### Task 1: Review fixes and strict evidence

Files: `scripts/merge-evidence/{verify,prepare,examples}.mjs`, new `json.mjs`, tests in `scripts/merge-evidence/tests/verify.mjs`.

- [x] Add failing CLI JSON diagnostic, incomplete-diff and blocking-review tests; run the Node suite to observe failure.
- [x] Implement shared `readJson(path, label)`, validate full diff arrays and reject NEEDS_HUMAN with explicit review diagnostics.
- [x] Remove example-harness CLI paths; use the fixed sibling checkout and fresh system temporary output, with `/usr/bin/git`.
- [x] Run Node tests and actual pinned-action examples.

### Task 2: Full supported checks

Files: `.github/merge-evidence-policy.yml`, `.github/workflows/merge-evidence.yml`, `scripts/merge-evidence/examples.mjs` and gate documentation/results.

- [x] Add real-action cases for focus, rename, dependency omission, snapshots, scope omissions, coverage weakening, pre-existing failure and introduced failure.
- [x] Explicitly configure all C1–C9 severities, `fail-on: needs-human`, `base-comparison: auto` and no scope exemptions.
- [x] Verify action exits, outputs, summaries, per-test evidence and baseline attribution in every case.
- [x] Document all enabled features, bootstrap review blocking and separate permission proposals.
- [ ] Run `npm run check`, `npm run build`, `npm test`; commit only after all pass.
- [ ] Triage current PR findings, report local results and ask before publishing the fixes or editing PR metadata.


## Execution record

- Reviewed findings against pinned source: reliable receipts omit `unreliable`.
  Required complete diff arrays rather than an incompatible explicit false.
- JSON/context, CLI path restriction and review blocking: six reproduced failures
  became passing regressions. Receipt digest and independent checkout/policy
  protection also reproduced their missing rejection before implementation.
- Final Node suite: 25 passed. Real pinned action: 23 scenarios passed expected
  process/verdict/CLI outcomes, including three upstream PASS receipts rejected
  by the independent verifier and pre-existing failures rejected despite PASS.
- Application validation: 4,021 existing tests passed; check zero diagnostics;
  default Netlify build passed. No existing application tests/configuration changed.
- Overlock PR #221's six paths have no overlap.
- Publication, hosted re-analysis, security approvals and second review remain pending.
