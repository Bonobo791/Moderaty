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

import { readFileSync } from 'node:fs';

/**
 * Loads a drizzle migration SQL file and splits it into executable
 * statements: split on the `--> statement-breakpoint` marker, strip `--`
 * comment lines, drop empties. Shared by the migration behavior tests.
 *
 * @param file - The migration file name inside `drizzle/` (e.g. `0013_channels_org_contract.sql`)
 * @returns The migration's statements in execution order
 */
export function migrationStatements(file: string): string[] {
	const migration = readFileSync(new URL(`../../../../drizzle/${file}`, import.meta.url), 'utf8');
	return migration
		.split('--> statement-breakpoint')
		.map((chunk) =>
			chunk
				.split('\n')
				.filter((line) => !line.trimStart().startsWith('--'))
				.join('\n')
				.trim()
		)
		.filter((chunk) => chunk.length > 0);
}
