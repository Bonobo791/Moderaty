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
