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

import { db } from '$lib/server/db';
import { channels, rules } from '$lib/server/db/schema';
import { validateRule } from '$lib/server/rules';
import { eq } from 'drizzle-orm';
import { fail } from '@sveltejs/kit';

export async function load({ params }) {
	const ch = await db.select().from(channels).where(eq(channels.id, params.id)).get();
	const rs = await db.select().from(rules).where(eq(rules.channelId, params.id)).all();
	return { ch, rs };
}

export const actions = {
	add: async ({ params, request }) => {
		const f = await request.formData();
		const type = String(f.get('type') ?? '');
		const pattern = String(f.get('pattern') ?? '').trim();
		const action = String(f.get('action') ?? '');
		try {
			validateRule({ id: 0, type, pattern, action });
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : String(e) });
		}
		await db.insert(rules).values({
			channelId: params.id,
			type,
			pattern,
			action,
			createdAt: new Date().toISOString()
		});
		return { ok: true };
	},
	remove: async ({ request }) => {
		const f = await request.formData();
		await db.delete(rules).where(eq(rules.id, Number(f.get('ruleId'))));
		return { ok: true };
	}
};
