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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { requireRole } from '$lib/server/org';
import { requireUser, type SessionUser } from '$lib/server/session';

/**
 * Throws 403 unless the signed-in user's role in the ACTIVE org meets the
 * minimum. Use on team-management and channel-connect actions; ordinary
 * moderation work needs no role check beyond org membership (which
 * ownedChannel already enforces).
 */
export function requireOrgRole(user: SessionUser, minimum: 'admin' | 'owner'): void {
	requireRole(user.orgRole, minimum);
}

/**
 * Loads a channel only when it belongs to the signed-in user's ACTIVE org.
 * The single tenancy gate for every channel-scoped route: 401 when signed
 * out, 404 when the channel is missing or owned by another org (never leak
 * existence).
 */
export async function ownedChannel(channelId: string, locals: { user: SessionUser | null }) {
	const user = requireUser(locals);
	const ch = await db
		.select()
		.from(channels)
		.where(and(eq(channels.id, channelId), eq(channels.orgId, user.orgId)))
		.get();
	if (!ch) throw error(404, 'channel not found');
	return ch;
}
