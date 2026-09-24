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
