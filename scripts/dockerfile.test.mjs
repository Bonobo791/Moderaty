// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

// Regression tests for the SonarQube Dockerfile findings (docker:S6505 and
// docker:S6472) on the Coolify build:
//
//   - S6505: package install must not run third-party lifecycle scripts —
//     `npm ci --ignore-scripts`. The SvelteKit plugin regenerates .svelte-kit
//     itself during `vite build` (sync.all in the kit vite plugin's config
//     hook), and every install-script package in the lockfile (esbuild — its
//     binary ships as a platform optionalDependency — and fsevents, macOS
//     only) works without its script, so the flag must never be dropped.
//
//   - S6472: the TURSO_* credentials must NOT travel as Dockerfile ARG /
//     ENV instructions (they would be visible in build args, logs, and build
//     cache). They must reach the migrate gate only as BuildKit secret
//     mounts (`RUN --mount=type=secret,id=…,env=…`), with Coolify's "Use
//     Docker Build Secrets" operator setting pinned in the runbook — a build
//     without the secrets fails loudly (secret not found), never silently.
//
// Every assertion fails if the real Dockerfile or the runbook regresses
// (e.g. someone reintroduces `ARG TURSO_AUTH_TOKEN`, or drops
// `--ignore-scripts` to "fix" a broken build).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const runbook = readFileSync(new URL('../docs/COOLIFY_BUNNY.md', import.meta.url), 'utf8');

describe('Dockerfile (docker:S6505 — no third-party install scripts)', () => {
	it('installs dependencies with --ignore-scripts', () => {
		expect(dockerfile).toMatch(/npm ci --ignore-scripts/);
	});
});

describe('Dockerfile (docker:S6472 — no secrets via ARG/ENV)', () => {
	it('declares no TURSO_* ARG instructions', () => {
		expect(dockerfile).not.toMatch(/^ARG TURSO_/m);
	});

	it('declares no TURSO_* ENV instructions', () => {
		expect(dockerfile).not.toMatch(/^ENV TURSO_/m);
	});

	it('passes TURSO_DATABASE_URL to the migrate gate as a BuildKit secret mount', () => {
		expect(dockerfile).toMatch(
			/--mount=type=secret,id=TURSO_DATABASE_URL,env=TURSO_DATABASE_URL/
		);
	});

	it('passes TURSO_AUTH_TOKEN to the migrate gate as a BuildKit secret mount', () => {
		expect(dockerfile).toMatch(
			/--mount=type=secret,id=TURSO_AUTH_TOKEN,env=TURSO_AUTH_TOKEN/
		);
	});

	it('mounts the secrets on the migrate-gate RUN, not on a baked layer', () => {
		// The secret mount and the migrate gate must be the same RUN — the
		// credential is visible only for that single command.
		expect(dockerfile).toMatch(
			/--mount=type=secret,id=TURSO_AUTH_TOKEN,env=TURSO_AUTH_TOKEN[\s\S]*?node scripts\/netlify-migrate\.mjs/
		);
	});

	it('keeps the BuildKit syntax directive (required for secret mounts)', () => {
		expect(dockerfile).toMatch(/^# syntax=docker\/dockerfile:1$/m);
	});
});

describe('Coolify runbook (operator setting that makes the secret mounts work)', () => {
	it('pins the "Use Docker Build Secrets" setting', () => {
		expect(runbook).toMatch(/Use Docker Build Secrets/);
	});

	it('marks the TURSO_* build variables as secret mounts, not plain build args', () => {
		expect(runbook).toMatch(/TURSO_AUTH_TOKEN[\s\S]*?Use Docker Build Secrets/s);
	});

	it('pins the toggle location (Environment Variables settings, not the Advanced menu)', () => {
		expect(runbook).toMatch(/Use Docker Build Secrets[\s\S]*?Environment Variables/);
	});

	it('documents the Build-Variable-ON requirement for the TURSO_* variables', () => {
		expect(runbook).toMatch(/Build Variable ON for `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`/);
	});
});
