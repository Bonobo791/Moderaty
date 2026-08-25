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

import { error, json, type RequestHandler } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';

// Uptime probe target (issue #82): unauthenticated by design so an external
// monitor can detect a Turso outage without credentials. Loud on the server,
// generic to the client — the driver error never crosses the boundary.
export const GET: RequestHandler = async () => {
	try {
		await db.get(sql`SELECT 1`);
	} catch (e) {
		console.error('health check database query failed:', e);
		throw error(503, 'the service is temporarily unavailable — please retry shortly');
	}
	return json({ status: 'ok' });
};
