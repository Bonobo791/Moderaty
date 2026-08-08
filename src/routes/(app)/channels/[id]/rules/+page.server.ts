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
import {
	addHandle as addAllowedHandle,
	listHandles,
	removeHandle as removeAllowedHandle
} from '$lib/server/allowlist';
import { ownedChannel } from '$lib/server/ownership';
import { and, eq } from 'drizzle-orm';
import { fail } from '@sveltejs/kit';

export async function load({ params, locals }) {
	// Database outage: the layout renders the overlay; this load must not 401
	// on the null-user outage shape.
	if (locals.dbDown) return { ch: { id: params.id, title: '' }, rs: [], handles: [], maintenance: true };
	const ch = await ownedChannel(params.id, locals);
	const rs = await db.select().from(rules).where(eq(rules.channelId, params.id)).all();
	const handles = await listHandles(params.id);
	// Project only what the page renders — never serialize refreshTokenEnc (or
	// any future secret column) to the browser.
	return { ch: { id: ch.id, title: ch.title }, rs, handles };
}

export const actions = {
	add: async ({ params, request, locals }) => {
		await ownedChannel(params.id, locals);
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
	remove: async ({ params, request, locals }) => {
		await ownedChannel(params.id, locals);
		const f = await request.formData();
		const ruleId = Number(f.get('ruleId'));
		if (!Number.isInteger(ruleId) || ruleId <= 0) {
			return fail(400, { error: 'Invalid rule ID' });
		}
		// Scope to this route's channel so a request here cannot delete another channel's rule.
		const deleted = await db
			.delete(rules)
			.where(and(eq(rules.id, ruleId), eq(rules.channelId, params.id)))
			.returning({ id: rules.id });
		if (deleted.length === 0) return fail(404, { error: 'rule not found' });
		return { ok: true };
	},
	addHandle: async ({ params, request, locals }) => {
		await ownedChannel(params.id, locals);
		const f = await request.formData();
		try {
			await addAllowedHandle(params.id, String(f.get('handle') ?? ''));
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : String(e) });
		}
		return { ok: true };
	},
	removeHandle: async ({ params, request, locals }) => {
		await ownedChannel(params.id, locals);
		const f = await request.formData();
		let removed: Awaited<ReturnType<typeof removeAllowedHandle>>;
		try {
			// Channel-scoped: a request here cannot delete another channel's handle.
			removed = await removeAllowedHandle(params.id, Number(f.get('handleId')));
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : String(e) });
		}
		if (!removed) return fail(404, { error: 'protected handle not found' });
		return { ok: true };
	}
};
