#!/usr/bin/env node
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
//
// Dev cron driver. Netlify Scheduled Functions only fire on the published
// production deploy — never on branch deploys, and nothing fires against
// `npm run dev` — so in every non-production environment the moderation
// pipeline only advances when something calls GET /api/cron. This script is
// that something: it ticks the endpoint on the same every-minute cadence as
// the Netlify function (one channel per tick, one page per dry-run window
// drain), with the secret in an Authorization header, never in the URL.
//
// Usage (run alongside `npm run dev` in a second terminal):
//   node --env-file=.env scripts/dev-cron.mjs            tick every 60s
//   node --env-file=.env scripts/dev-cron.mjs --once     one tick, then exit
//   node --env-file=.env scripts/dev-cron.mjs --interval-ms 5000
//
// APP_URL defaults to http://localhost:5173; set it to the dev branch deploy
// (with that deploy's CRON_SECRET) to drive the deployed instance instead.

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Calls the app's cron endpoint once, loudly.
 *
 * @param {typeof fetch} [fetchImpl] - fetch implementation (tests inject a stub)
 * @returns {Promise<object>} The endpoint's JSON payload
 * @throws If CRON_SECRET is unset, or the endpoint answers non-OK — a tick
 *   that failed must never look like one that succeeded.
 */
export async function tickOnce(fetchImpl = fetch) {
	const base = process.env.APP_URL ?? 'http://localhost:5173';
	const secret = process.env.CRON_SECRET;
	if (!secret) {
		throw new Error('CRON_SECRET is not set. Run with: node --env-file=.env scripts/dev-cron.mjs');
	}
	const res = await fetchImpl(`${base}/api/cron`, {
		headers: { Authorization: `Bearer ${secret}` },
		signal: AbortSignal.timeout(30_000)
	});
	if (!res.ok) {
		throw new Error(`cron endpoint answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
	}
	const payload = await res.json();
	// Strip CR/LF before logging: the payload is remote content and a raw
	// newline in it would let a response forge extra log lines (S5145).
	console.log(`[${new Date().toISOString()}] tick → ${JSON.stringify(payload).replaceAll(/[\r\n]+/g, ' ')}`);
	return payload;
}

// Only run the driver when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
	const argv = process.argv.slice(2);
	const once = argv.includes('--once');
	const intervalFlag = argv.indexOf('--interval-ms');
	const intervalMs =
		intervalFlag === -1 ? DEFAULT_INTERVAL_MS : Number.parseInt(argv[intervalFlag + 1] ?? '', 10);
	if (argv.some((a) => a !== '--once' && a !== '--interval-ms' && a !== String(intervalMs)) || Number.isNaN(intervalMs)) {
		console.error('Usage: node --env-file=.env scripts/dev-cron.mjs [--once] [--interval-ms N]');
		process.exit(1);
	}
	try {
		await tickOnce();
	} catch (cause) {
		console.error('cron tick failed:', cause);
		if (once) process.exit(1);
	}
	if (!once) {
		console.log(`dev cron driver: ticking every ${intervalMs / 1000}s (Ctrl+C to stop)`);
		setInterval(async () => {
			try {
				await tickOnce();
			} catch (cause) {
				// Loud, but the driver survives: a transient failure must not
				// silently stop the drain cadence for the rest of the session.
				console.error('cron tick failed:', cause);
			}
		}, intervalMs);
	}
}
