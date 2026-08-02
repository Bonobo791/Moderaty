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

import { readFileSync, readdirSync } from 'node:fs';
import { expect, test } from 'vitest';

// Guard for the PR #37 review finding: the cron retention purge filters and
// orders `users` by `deleted_at` every invocation, so the column must be
// indexed — declared in the Drizzle schema (drift-pinned) and present in a
// migration (never edit an applied migration; add a new one).
const schemaSource = readFileSync(new URL('./schema.ts', import.meta.url), 'utf8');
const migrations = readdirSync(new URL('../../../../drizzle', import.meta.url))
	.filter((file) => file.endsWith('.sql'))
	.map((file) => readFileSync(new URL(`../../../../drizzle/${file}`, import.meta.url), 'utf8'))
	.join('\n');

test('users.deleted_at is indexed in the schema and in a migration', () => {
	expect(schemaSource).toContain("index('users_deleted_at_idx').on(table.deletedAt)");
	expect(migrations).toMatch(/CREATE INDEX `?users_deleted_at_idx`? ON `?users`? \(`?deleted_at`?\)/);
});
