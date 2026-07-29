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

import { json, error } from '@sveltejs/kit';

import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { runChannel } from '$lib/server/pipeline';

export async function GET({ url }) {
	if (url.searchParams.get('secret') !== env.CRON_SECRET) throw error(401, 'bad secret');
	const chs = await db.select().from(channels).all();
	const results: Record<string, unknown> = {};
	for (const ch of chs) {
		try {
			results[ch.id] = await runChannel(ch.id);
		} catch (e) {
			results[ch.id] = { error: e instanceof Error ? e.message : String(e) };
		}
	}
	return json({ ok: true, dryRun: process.env.DRY_RUN === 'true', results });
}
