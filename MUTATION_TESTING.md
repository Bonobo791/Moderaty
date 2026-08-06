## Mutation Testing Engineer (role)

The mutation testing engineer owns test-suite *quality* — the "Every test
must fail if the real logic is wrong" rule made measurable. Coverage shows
what the suite executes; mutation testing shows whether the suite fails when
the code is wrong. Follow the skill at
`.agents/skills-src/mutation-testing/SKILL.md` (mental mutation testing for
review-time reasoning; Stryker for every applied mutant). **Stryker applies
and verifies ALL mutants in this repo** — never hand-edit source to simulate
a mutation as a workflow step. Killing a mutant means writing a behavior
test that flips it survived→killed on a scoped re-run; that re-run IS the
both-directions confirmation (the exception — a mutant Stryker's operator
set cannot express — is documented in the skill and must be justified in the
PR). StrykerJS: `@stryker-mutator/core` +
`@stryker-mutator/vitest-runner`, configured by `stryker.config.json` at the
repo root (`npx stryker run` for whole-module audits, a scoped `--mutate`
glob or `node scripts/stryker-pr-scope.mjs` for PR-scale work — StrykerJS
has no `--since` flag, that is Stryker.NET; the script prints the changed
src files as a `--mutate` scope, filtered like the config, and an empty
result means skip the run — the script's `EXCLUDED_FILES` must mirror the
config's mutate globs whenever the policy exclusions change),
`npx stryker run --incremental` to reuse the cache; the `json`
reporter in config gives machine-readable survivors for the agent loop). The
mutate scope covers `src/**/*.ts` minus tests, the dev-seed helper, the
static legal page loaders, and `src/lib/auto-refresh.svelte.ts` (policy
exclusion: vitest compiles `.svelte.ts` for SSR, where `$effect` is a no-op,
so its mutants are unreachable in this harness; its SSR no-op contract is
test-pinned and the client behavior is e2e territory). In
a fresh checkout or worktree run `npx svelte-kit sync` first — Stryker's
vitest runner needs the generated `.svelte-kit/tsconfig.json`. Verify
survivors by hand before writing kill tests — the score is a lead, not a
verdict. CI does not run Stryker (the report-only
`.github/workflows/mutation.yml` pass was removed by maintainer decision —
runs are local/agent-driven); wiring any CI gate, including a ratcheted
`thresholds.break`, remains a separate, maintainer-approved step.

Property-based testing (fast-check) runs under the fast-check-testing
skill; repo conventions live in `docs/property-testing.md` and shared
arbitraries in `src/lib/server/testarbitraries.ts`. Properties complement
example tests and never count toward Stryker kill claims.