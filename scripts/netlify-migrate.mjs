#!/usr/bin/env node
// Netlify build gate: runs the database migration (drizzle-kit migrate) and
// then the schema verification (scripts/verify-migrations.mjs) at the START
// of every Netlify build, so a deploy is blocked until the database the
// deploy will serve is actually migrated and verified — never serving new
// code on an un-migrated schema. Netlify runs the build before publishing,
// so this step is strictly ordered against "hitting production".
//
// Deploy-preview builds (CONTEXT=deploy-preview) are the one exception: they
// execute untrusted PR code, and running the PR's own migration SQL against
// the dev database would be an arbitrary-SQL injection surface. Previews log
// a loud skip and continue the build. Production and branch-deploy builds
// (and any unrecognized or unset CONTEXT — the conservative default) always
// migrate + verify, failing the build loudly if either step fails.
//
// Security: every command is spawned via process.execPath (the absolute node
// binary already running this script) with a fixed, repo-absolute script
// path — nothing is resolved through PATH (javascript:S4036), so an attacker
// who can write to a PATH directory can never redirect the migration or the
// verification to their own code. The MODERATY_DRIZZLE_KIT_BIN /
// MODERATY_VERIFY_BIN / MODERATY_PREFLIGHT_BIN env overrides exist ONLY for
// the test suite to substitute fake scripts — they are honored solely when
// MODERATY_MIGRATE_TEST_HOOKS=1, so a stray or injected production env var
// can never redirect the migration to arbitrary code; production always
// uses the defaults below.
//
// Runs only from the netlify.toml build command; it needs the per-context
// Netlify env vars (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN), which drizzle-kit
// and the verification script read from the environment.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const context = process.env.CONTEXT ?? '(unset)';
console.log(`netlify-migrate: CONTEXT=${context}`);

if (context === 'deploy-preview') {
	console.log(
		'netlify-migrate: deploy-preview — skipping migrations (untrusted PR code must never run SQL against a shared database). Build continues.'
	);
	process.exit(0);
}

// Preflight the database credentials BEFORE spawning anything: drizzle-kit
// loads drizzle.config.ts, which dies with a bare "TURSO_DATABASE_URL is
// required" when the variable never reached the build. That is exactly the
// 2026-08-19 Coolify prod-deploy symptom — "Use Docker Build Secrets" was
// off, so the Dockerfile's secret mounts (--mount=type=secret,id=KEY,env=KEY)
// were empty and the env var was unset. Fail with an actionable message
// instead of a config-file stack trace. Netlify supplies the same variables
// per deploy context; the Coolify build supplies them ONLY as BuildKit secret
// mounts (never ARG/ENV, docker:S6472). file: URLs (local development) need
// no token, mirroring drizzle.config.ts and verify-migrations.mjs.
const databaseUrl = process.env.TURSO_DATABASE_URL;
if (!databaseUrl) {
	console.error(
		'netlify-migrate: TURSO_DATABASE_URL is not set — the database credentials never reached this build.\n' +
			'  - Netlify: set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the site/deploy-context environment.\n' +
			'  - Coolify Docker build: the Dockerfile reads them ONLY as BuildKit secret mounts. Enable\n' +
			'    "Use Docker Build Secrets" in the application Environment Variables settings and keep\n' +
			'    the Build Variable flag ON for TURSO_DATABASE_URL and TURSO_AUTH_TOKEN\n' +
			'    (docs/COOLIFY_BUNNY.md §3.4). If both are set and it still fails, the Coolify server\n' +
			'    may lack BuildKit secret support (it then silently falls back to build args) — check\n' +
			'    "docker build --help | grep secret" on the server.\n' +
			'  - Local: source .env (node --env-file=.env scripts/netlify-migrate.mjs).' +
			'\nblocking the deploy — a build without the credentials must never reach drizzle-kit.'
	);
	process.exit(1);
}
if (!databaseUrl.startsWith('file:') && !process.env.TURSO_AUTH_TOKEN) {
	console.error(
		'netlify-migrate: TURSO_AUTH_TOKEN is not set for a remote database — the credentials never reached this build.\n' +
			'  Configure it the same way as TURSO_DATABASE_URL (see the message above); never bake a token\n' +
			'  into the image — blocking the deploy.'
	);
	process.exit(1);
}

// Test-only seam: the MODERATY_*_BIN overrides substitute fake scripts for
// the test suite. They are honored ONLY under MODERATY_MIGRATE_TEST_HOOKS=1 —
// anywhere else they are ignored with a loud notice, so a poisoned
// production env var can never execute arbitrary code at the migration gate.
const testHooks = process.env.MODERATY_MIGRATE_TEST_HOOKS === '1';
const override = (envName, fallback) => {
	if (!process.env[envName]) return fallback;
	if (testHooks) return process.env[envName];
	console.error(
		`netlify-migrate: ignoring ${envName} — binary overrides only apply under MODERATY_MIGRATE_TEST_HOOKS=1.`
	);
	return fallback;
};

// db:preflight runs first because drizzle-kit exits 1 with no output on
// connection failures — the preflight surfaces the real driver error (expired
// token, unreachable host) into the deploy log before anything can swallow it.
const steps = [
	{
		name: 'db:preflight',
		args: [override('MODERATY_PREFLIGHT_BIN', join(repoRoot, 'scripts', 'db-preflight.mjs'))]
	},
	{
		name: 'db:migrate',
		args: [override('MODERATY_DRIZZLE_KIT_BIN', join(repoRoot, 'node_modules', 'drizzle-kit', 'bin.cjs')), 'migrate']
	},
	{
		name: 'db:verify',
		args: [override('MODERATY_VERIFY_BIN', join(repoRoot, 'scripts', 'verify-migrations.mjs'))]
	}
];

for (const step of steps) {
	const result = spawnSync(process.execPath, step.args, { stdio: 'inherit' });
	if (result.error) {
		console.error(`netlify-migrate: could not run ${step.name}: ${result.error.message} — blocking the deploy`);
		process.exit(1);
	}
	if (result.status !== 0) {
		console.error(
			`netlify-migrate: ${step.name} failed (exit ${result.status}) — blocking the deploy. ` +
				'A failed migration or an unverified schema must never ship.'
		);
		process.exit(result.status ?? 1);
	}
}

console.log('netlify-migrate: migrations applied and verified — proceeding with the build.');
