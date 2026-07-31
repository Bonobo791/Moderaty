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
 * Netlify Scheduled Function: triggers one bounded moderation run by
 * calling the app's cron endpoint on the deployed site (see the schedule
 * note at `config` below). The secret travels in an Authorization
 * header, never in the URL; the request aborts after 25s rather than hanging
 * into the platform limit. Any failure throws so the invocation shows up as
 * failed in the Netlify function logs.
 */
export default async function cron() {
	const base = process.env.APP_URL;
	if (!base) throw new Error('APP_URL environment variable is required (set it in Netlify Site settings)');
	const secret = process.env.CRON_SECRET;
	if (!secret) throw new Error('CRON_SECRET environment variable is required');
	const endpoint = new URL('/api/cron', base);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	let res;
	try {
		res = await fetch(endpoint, {
			headers: { authorization: `Bearer ${secret}` },
			signal: controller.signal
		});
	} catch (error) {
		// undici hides the real network reason (DNS, TLS, refused) in `cause`;
		// surface it so failed invocations are diagnosable from the logs alone.
		const cause = error instanceof Error ? error.cause : undefined;
		const detail = cause instanceof Error ? `${cause.code ?? cause.name}: ${cause.message}` : 'no cause';
		throw new Error(
			`cron endpoint unreachable: ${error instanceof Error ? error.message : String(error)} (${detail})`
		);
	} finally {
		clearTimeout(timer);
	}
	// Bound what lands in Netlify logs; pipeline error bodies can be long.
	const body = (await res.text()).slice(0, 500);
	if (!res.ok) throw new Error(`cron endpoint failed: ${res.status} ${body}`);
	console.log(`cron endpoint ok: ${body}`);
}

const TIMEOUT_MS = 25_000; // below Netlify's 26s function limit; the endpoint's own run budget is 20s

// The schedule is every minute while the app is in early single-channel
// operation; raise to '*/15 * * * *' when user volume grows. The endpoint
// itself enforces one channel per invocation, so this schedule sets the
// per-channel scan cadence.
export const config = { schedule: '* * * * *' };
