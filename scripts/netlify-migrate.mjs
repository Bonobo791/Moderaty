#!/usr/bin/env node
// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
//
// Netlify build gate: runs the database migration (npm run db:migrate) and
// then the schema verification (npm run db:verify) at the START of every
// Netlify build, so a deploy is blocked until the database the deploy will
// serve is actually migrated and verified — never serving new code on an
// un-migrated schema. Netlify runs the build before publishing, so this step
// is strictly ordered against "hitting production".
//
// Deploy-preview builds (CONTEXT=deploy-preview) are the one exception: they
// execute untrusted PR code, and running the PR's own migration SQL against
// the dev database would be an arbitrary-SQL injection surface. Previews log
// a loud skip and continue the build. Production and branch-deploy builds
// (and any unrecognized or unset CONTEXT — the conservative default) always
// migrate + verify, failing the build loudly if either step fails.
//
// Runs only from the netlify.toml build command; it needs the per-context
// Netlify env vars (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN), which drizzle-kit
// and the verification script read from the environment.

import { spawnSync } from 'node:child_process';

const context = process.env.CONTEXT ?? '(unset)';
console.log(`netlify-migrate: CONTEXT=${context}`);

if (context === 'deploy-preview') {
	console.log(
		'netlify-migrate: deploy-preview — skipping migrations (untrusted PR code must never run SQL against a shared database). Build continues.'
	);
	process.exit(0);
}

for (const script of ['db:migrate', 'db:verify']) {
	const result = spawnSync('npm', ['run', script], { stdio: 'inherit' });
	if (result.error) {
		console.error(`netlify-migrate: could not run npm run ${script}: ${result.error.message} — blocking the deploy`);
		process.exit(1);
	}
	if (result.status !== 0) {
		console.error(
			`netlify-migrate: npm run ${script} failed (exit ${result.status}) — blocking the deploy. ` +
				'A failed migration or an unverified schema must never ship.'
		);
		process.exit(result.status ?? 1);
	}
}

console.log('netlify-migrate: migrations applied and verified — proceeding with the build.');
