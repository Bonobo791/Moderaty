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

import { createClient } from '@libsql/client/node';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('upgrades an existing channels table with scan state', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'moderaty-migration-'));
	const client = createClient({ url: `file:${join(directory, 'moderaty.db')}` });
	try {
		await client.executeMultiple(`
			CREATE TABLE channels (
				id text PRIMARY KEY,
				title text NOT NULL,
				refresh_token_enc text NOT NULL,
				cursor text,
				active integer NOT NULL DEFAULT 1,
				created_at text NOT NULL
			);
			INSERT INTO channels (id, title, refresh_token_enc, cursor, active, created_at)
			VALUES ('UC-existing', 'Existing channel', 'encrypted', '2026-01-01T00:00:00.000Z', 1, '2026-01-01T00:00:00.000Z');
		`);

		await client.executeMultiple(await readFile(new URL('../../../../drizzle/0000_add_channel_scan_state.sql', import.meta.url), 'utf8'));

		const columns = await client.execute('PRAGMA table_info(channels)');
		const channel = await client.execute('SELECT id, next_page_token, scan_cursor FROM channels');
		expect(columns.rows.map((column) => column.name)).toEqual(expect.arrayContaining(['next_page_token', 'scan_cursor']));
		expect(channel.rows).toEqual([{ id: 'UC-existing', next_page_token: null, scan_cursor: null }]);
	} finally {
		client.close();
		await rm(directory, { recursive: true, force: true });
	}
});
