# Mutation Testing Tools by Language

<!--
Moderaty — YouTube Comment Auto-Moderation Tool
Copyright (C) 2026 Andrew Philip Weilbacher

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
for more details: <https://www.gnu.org/licenses/>.

Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
-->

Contents: selection table · JS/TS (StrykerJS) · Python (mutmut, Cosmic Ray) · Rust (cargo-mutants) · Java/JVM (PIT) · Go · PHP (Infection) · .NET · Ruby · Swift · C/C++ · universal CI pattern.

## Selection table

| Language | Tool | Install | Notes |
|---|---|---|---|
| JS / TS | StrykerJS | `npm i -D @stryker-mutator/core` + runner plugin | De facto standard; Jest/Vitest/Mocha/Karma; `--since`, `--incremental` |
| Python | mutmut | `pip install mutmut` | Runner-agnostic (exit code); v3 rewrote config keys and the results CLI — see below |
| Python | Cosmic Ray | `pip install cosmic-ray` | Plugin distributors spread work across workers; heavier than mutmut |
| Rust | cargo-mutants | `cargo install cargo-mutants` | `mutants.out/` results dir; `--in-diff` for PRs; `#[mutants::skip]` |
| Java / JVM | PIT (pitest) | Maven/Gradle plugin | Mutates bytecode (fast, no source view); PR-diff runs need Arcmutate's git integration (the old `scmMutationCoverage` goal is removed) |
| Go | go-mutesting (avito-tech fork) or Gremlins | `go install` | Fork is the maintained one |
| PHP | Infection | `composer require --dev infection/infection` | AST-based; `--only-covered`, MSI thresholds |
| C# / .NET | Stryker.NET | `dotnet tool install -g dotnet-stryker` | Run from test project dir |
| Scala | Stryker4s | sbt plugin | Same Stryker family |
| Ruby | mutant | `gem install mutant` | RSpec/Minitest; strictest philosophy (aims 100% on mutated scope) |
| Swift | muter | brew/spm | Uses `xcodebuild` |
| C / C++ | Mull | binary release | LLVM-level mutants |

Choose by: test-runner integration (drives the existing suite unmodified), changed-file scoping, parallelism, readable HTML/JSON report. All listed tools have these.

**Mutant-status semantics are tool-specific.** The SKILL.md status list (killed / survived / timed out / no coverage / error) is the generic model; check your tool's exact definitions before gating on them. For example, StrykerJS reports `NoCoverage` separately from `Survived`, counts `Timeout` as detected, and excludes compile/runtime errors from the score; other tools bucket these differently. The score formula likewise varies (some tools count timeouts as killed, some exclude them).

## JavaScript / TypeScript — StrykerJS

```bash
npm i -D @stryker-mutator/core @stryker-mutator/vitest-runner   # or jest-runner / mocha-runner
npx stryker init
```

Production-ready `stryker.conf.json` (Vitest + TS):

```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "packageManager": "npm",
  "testRunner": "vitest",
  "reporters": ["html", "json", "clear-text", "progress"],
  "coverageAnalysis": "perTest",
  "mutate": ["src/**/*.ts", "!src/**/*.test.ts", "!src/**/*.spec.ts", "!src/**/index.ts"],
  "checkers": ["typescript"],
  "thresholds": { "high": 85, "low": 70, "break": 60 },
  "concurrency": 4,
  "timeoutMS": 10000,
  "timeoutFactor": 1.5,
  "incremental": true
}
```

Levers that matter:

- `coverageAnalysis: "perTest"` — the single biggest speedup; runs only tests covering each mutant. Never `"off"`.
- `thresholds.break` — score below → exit 1 → CI gate. Set floor = current − buffer, ratchet up.
- `npx stryker run --since main` — mutate only files changed vs base branch (PR mode).
- `npx stryker run --incremental` — caches results in `reports/stryker-incremental.json` (the default `incrementalFile`); cache that file in CI for reuse — committing it to the repo just adds bloat and merge noise. (`.stryker-tmp/` is the scratch sandbox dir, not the cache.)
- `npx stryker run --mutate "src/billing/**/*.ts"` — scope hardening to one module.
- `ignoreStatic: true` — skip mutants only executed at module load (large perf penalty, low value).
- `mutator.excludedMutations` — drop noisy operators (e.g. `ObjectLiteral`, `StringLiteral` on logging-heavy files).
- Jest: `enableFindRelatedTests: true` compounds with `perTest`.

CI (PR gate + weekly sweep):

```yaml
- name: Mutation test changed files
  if: github.event_name == 'pull_request'
  run: npx stryker run --since main
- name: Full mutation sweep
  if: github.event_name == 'schedule'
  run: npx stryker run
- uses: actions/upload-artifact@v4
  if: always()
  with: { name: stryker-report, path: reports/mutation/ }
```

## Python — mutmut

mutmut 3.x (current) rewrote the config keys and the results CLI. If you are pinned to mutmut 2.x, the old keys (`paths_to_mutate`, `tests_dir`) and commands (`mutmut results`, `mutmut show`, `mutmut apply`, `mutmut result-ids`) still apply — pin and label the version either way.

Config (`pyproject.toml` — paths are arrays; `setup.cfg` — strings):

```toml
[tool.mutmut]
source_paths = ["src/"]
pytest_add_cli_args_test_selection = ["tests/"]
```

```ini
[mutmut]
source_paths=src/
pytest_add_cli_args_test_selection=tests/
```

Workflow (3.x):

```bash
mutmut run                 # resumable; state lives in the mutants/ dir (delete for a clean full run)
mutmut browse              # interactive TUI: killed/survived summary, per-mutant diffs,
                           # retest individual mutants, write a mutant to disk
# to validate a kill both directions: write the mutant to disk from `mutmut browse`
# (the source MUST be committed first), write the failing test, then:
git checkout -- src/file.py  # revert immediately — never leave applied mutants on disk
```

Quirks and controls:

- `# pragma: no mutate` — whitelist a line (version strings, logging, intentional perf trade-offs like `break`→`continue`).
- `mutmut_config.py` with `pre_mutation(context)` — skip mutants programmatically (e.g. skip all `log.*` lines, skip a file) or change the test command per mutant.
- Only needs an exit code from the runner, so any test command works; `hammett` runner is dramatically faster than pytest if adoptable.
- WARNING for agents: writing a mutant to disk (2.x `mutmut apply`, 3.x via `mutmut browse`) physically corrupts the working tree. Always verify `git status` is clean before applying, and revert in the same session.

Cosmic Ray: prefer when mutant volume needs distributing across machines (plugin-based executors); config in a TOML session file, `cosmic-ray exec session.toml`, `cr-report`.

## Rust — cargo-mutants

```bash
cargo install cargo-mutants
cargo mutants                 # results in mutants.out/ (mutants.json, diffs, logs)
cargo mutants --file 'src/billing/**'
cargo mutants --in-diff git.diff   # PR mode: git diff origin/main.. > git.diff
cargo mutants --list          # preview mutants without running
```

- Exit code is non-zero when uncaught (missed) mutants exist → native CI gate.
- Config: `.cargo/mutants.toml`. Skip untestable code with `#[mutants::skip]` (or `#[cfg_attr(test, mutants::skip)]` to keep it a dev-dependency). Document *why* at each skip.
- `skip_calls = ["with_capacity", ...]` — never mutate arguments of named calls (default already skips `with_capacity`).
- Speed: incremental builds dominate runtime — faster `cargo build` = multiplicatively faster runs. Use the Mold linker on Linux; `--jobs N` for parallelism; sharding supported for CI fan-out. Skip slow doctests: `cargo mutants -- --all-targets` off, or scope with `--test-workspace`/`--test-package` when tests live elsewhere.
- Do not run with `#![deny(warnings)]`-style lints active — mutated trees fail to build on `unused_variable` without saying anything about tests. Pass `RUSTFLAGS` for lint checks outside mutation runs.
- Functions that only affect performance (caches) can't be killed by behavior tests: make the side effect observable (counters) or `#[mutants::skip]` with a rationale.

## Java / JVM — PIT (pitest)

```bash
# Full run
mvn clean test-compile org.pitest:pitest-maven:mutationCoverage
```

- Mutates bytecode, not source — fast on large codebases, but no mutated-source view in reports.
- PR-diff runs: the deprecated `scmMutationCoverage` Maven goal was fully removed from current PIT. Use Arcmutate's Git integration (the commercial successor for diff-scoped runs), or pin and clearly label a pre-removal pitest-maven version if you depend on the old goal.
- Persist `target/pit-history.xml` as a CI artifact for incremental reuse.
- Timeouts: infinite-loop detection = `normalTime * timeoutFactor (1.25) + timeoutConstant (4000ms)`. Classloading order causes false timeouts (JAXB/XML-heavy code) — raise `timeoutConstant`.
- Defaults already skip calls to common logging packages (`avoidCallsTo`); add project logging wrappers to that list.
- `<excludedMutations>` for known equivalent-prone operators; `<excludedClasses>` for generated code; multi-module: PitMP aggregator or `<aggregateReport>true</aggregateReport>`.
- JUnit 5 needs the pitest-junit5-plugin dependency.

## Go

go-mutesting (use the avito-tech fork; original is unmaintained) or Gremlins:

```bash
go install github.com/avito-tech/go-mutesting/cmd/go-mutesting@latest
go-mutesting ./internal/billing/...
```

Both are slower and less ergonomic than Stryker/mutmut — scope tightly to packages and run in CI on diffs only.

## PHP — Infection

```bash
composer require --dev infection/infection
vendor/bin/infection --threads=4 --only-covered --show-mutations
```

- Reports MSI (Mutation Score Indicator) and Covered MSI; gate with `--min-msi=75 --min-covered-msi=85`.
- `infection.json5`: `source.directories`, `exclude` globs, per-mutator `ignore` lists, `--filter` for changed-file scoping.
- `--git-diff-filter=AM --git-diff-base=origin/main` for PR-diff runs.

## .NET — Stryker.NET

```bash
dotnet tool install -g dotnet-stryker
cd MyProject.Tests && dotnet stryker
```

Config `stryker-config.json` mirrors StrykerJS (`mutate` globs, `thresholds.break`, `since` diff mode, `baseline` for incremental PR gating).

## Ruby — mutant

`gem install mutant`; integrates RSpec/Minitest. Philosophy is 100% score *on the mutated scope* — control scope with `--include`/`--ignore-subject` instead of accepting survivors. Best-fit for small, high-criticality gems and services.

## Swift — muter

Runs through `xcodebuild`; `muter --files-to-mutate ...` to scope. CI on macOS runners only.

## C / C++ — Mull

LLVM-IR-level mutants; integrates via `mull-cxx` and compiled test binaries. Strongest where sanitizers already pass.

## Universal CI pattern

1. PR pipeline: `git diff` → tool's diff/incremental mode → fail only on new survivors or a low `break` floor. Upload HTML/JSON report as artifact (`if: always()`).
2. Scheduled pipeline (nightly/weekly): full sweep on the default branch, enforces the real `break` threshold, tracks score over time.
3. Cache the tool's state file in CI between runs (CI cache, not the repo) — `reports/stryker-incremental.json` (StrykerJS), `mutants/` (mutmut 3.x), `target/pit-history.xml` (PIT).
