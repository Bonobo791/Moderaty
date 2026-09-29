// The tick-health classifier is shared with the local driver
// (scripts/dev-cron.mjs): a 200 reporting `ok:false`, an exhausted budget,
// a failed sweep, or a non-owner channel error must fail the invocation —
// HTTP status alone cannot see them (codex).
import { evaluateTick } from '../../scripts/dev-cron.mjs';

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
	const rawText = await res.text();
	const body = rawText.slice(0, 500);
	let payload = null;
	try {
		payload = JSON.parse(rawText);
	} catch {
		payload = null;
	}
	const { ownerActionableOnly, problems } = evaluateTick(res.ok, payload);
	if (!res.ok) {
		// A run whose only failures are channel-owner categories (credits/
		// token) is dashboard-visible and self-resolving — suppress the
		// invocation failure, same contract as the local driver.
		if (ownerActionableOnly && problems.length === 0) {
			console.warn(`cron endpoint answered ${res.status} with only channel-owner failure(s) — suppressing`);
			return;
		}
		throw new Error(`cron endpoint failed: ${res.status} ${body}`);
	}
	if (payload === null) throw new Error(`cron endpoint returned a non-JSON body: ${body}`);
	// A 200 can still report failure — `ok:false`, an exhausted run budget,
	// a failed sweep — none of which HTTP status exposes (codex).
	if (problems.length) throw new Error(`cron tick reported failure(s): ${problems.join('; ')}`);
	console.log(`cron endpoint ok: ${body}`);
}

const TIMEOUT_MS = 25_000; // below Netlify's 26s function limit; the endpoint's own run budget is 20s

// The schedule is every minute while the app is in early operation; raise to
// '*/15 * * * *' when user volume grows. The endpoint itself enforces one
// channel per invocation (least-recently-run first), so with N connected
// channels the per-channel scan cadence is N minutes at '* * * * *' — keep
// the schedule fast enough that N × interval stays an acceptable cadence.
export const config = { schedule: '* * * * *' };
