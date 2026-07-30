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

/**
 * Netlify Scheduled Function: triggers one bounded moderation run every
 * 15 minutes by calling the app's cron endpoint on the deployed site.
 * The endpoint itself enforces one channel per invocation, so this schedule
 * sets the per-channel scan cadence. Any failure throws so the invocation
 * shows up as failed in the Netlify function logs.
 */
export default async function cron() {
	const base = process.env.URL;
	if (!base) throw new Error('URL environment variable is required (Netlify sets it in production)');
	const secret = process.env.CRON_SECRET;
	if (!secret) throw new Error('CRON_SECRET environment variable is required');
	const endpoint = new URL('/api/cron', base);
	endpoint.searchParams.set('secret', secret);
	const res = await fetch(endpoint);
	const body = await res.text();
	if (!res.ok) throw new Error(`cron endpoint failed: ${res.status} ${body}`);
	console.log(`cron endpoint ok: ${body}`);
}

export const config = { schedule: '*/15 * * * *' };
