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
