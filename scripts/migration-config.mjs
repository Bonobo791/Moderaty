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
//
// Shared config preamble for the migration CLI scripts (verify-migrations,
// reconcile-migrations): argv/usage validation, meta-dir resolution, and the
// Turso URL/token checks. Single source of truth — the scripts used to
// copy-paste this block (AGENTS.md: DO NOT copy and paste code).

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Validates the CLI argv and Turso environment, resolving the migration meta
 * dir and journal path. Exits 1 with a loud message on any invalid input.
 *
 * @param options.argv - CLI args (defaults to process.argv.slice(2))
 * @param options.env - Environment (defaults to process.env)
 * @param options.scriptName - Basename for the usage line, e.g. 'verify-migrations'
 * @returns {{ metaDir: string, journalPath: string, url: string, authToken: string | undefined }}
 */
export function loadMigrationConfig({ argv = process.argv.slice(2), env = process.env, scriptName = 'migration' } = {}) {
	if (argv.length > 1) {
		console.error(`Usage: node scripts/${scriptName}.mjs [meta-dir]`);
		process.exit(1);
	}
	const metaDir = argv[0] ?? fileURLToPath(new URL('../drizzle/meta', import.meta.url));
	const url = env.TURSO_DATABASE_URL;
	if (!url) {
		console.error(`${scriptName}: TURSO_DATABASE_URL is not set (source .env first)`);
		process.exit(1);
	}
	const authToken = env.TURSO_AUTH_TOKEN;
	if (!url.startsWith('file:') && !authToken) {
		console.error(`${scriptName}: TURSO_AUTH_TOKEN is required for remote databases`);
		process.exit(1);
	}
	return { metaDir, journalPath: join(metaDir, '_journal.json'), url, authToken };
}
