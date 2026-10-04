// The tick-health classifier is shared with the local driver
// (scripts/dev-cron.mjs): a 200 reporting `ok:false`, an exhausted budget,
// a failed sweep, or a non-owner channel error must fail the invocation —
// HTTP status alone cannot see them (codex).
import { evaluateTick, validTickPayload } from '../../scripts/dev-cron.mjs';

/**
 * Netlify Scheduled Function: requests at most one bounded workload by
 * calling the app's cron endpoint on the deployed site (see the schedule
 * note at `config` below). The secret travels in an Authorization
 * header, never in the URL; the request aborts after 25s rather than hanging
 * into the platform limit. Configuration or transport errors, invalid responses,
 * and operator-actionable tick failures throw and fail the invocation. A non-OK
 * response containing only credits/token channel failures and no operator
 * problems logs a warning without failing the invocation.
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
	let rawText;
	try {
		res = await fetch(endpoint, {
			headers: { authorization: `Bearer ${secret}` },
			signal: controller.signal
		});
		rawText = await res.text();
	} catch (error) {
		throw unreachableError(error);
	} finally {
		clearTimeout(timer);
	}
	// Bound what lands in Netlify logs; pipeline error bodies can be long.
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
		// token) is dashboard-visible and resolves when the owner acts. With no
		// operator problems, suppress the failure as the local driver does.
		if (ownerActionableOnly && problems.length === 0) {
			console.warn(`cron endpoint answered ${res.status} with only channel-owner failure(s) — suppressing`);
			return;
		}
		throw new Error(`cron endpoint failed: ${res.status} ${body}`);
	}
	// A 200 answering a scalar/array/foreign object is not the cron payload —
	// classifying it healthy would hide a proxy or scheduler failure (cubic).
	if (!validTickPayload(payload)) throw new Error(`cron endpoint returned a non-JSON or invalid body: ${body}`);
	// A 200 can still report failure — `ok:false`, an exhausted run budget,
	// a failed sweep — none of which HTTP status exposes (codex).
	if (problems.length) throw new Error(`cron tick reported failure(s): ${problems.join('; ')}`);
	console.log(`cron endpoint ok: ${body}`);
}

const TIMEOUT_MS = 25_000; // below Netlify's 26s function limit; the endpoint's own run budget is 20s

// undici hides the real network reason (DNS, TLS, refused) in `cause`;
// surface it so failed invocations are diagnosable from the logs alone.
function unreachableError(error) {
	const cause = error instanceof Error ? error.cause : undefined;
	const detail = cause instanceof Error ? `${cause.code ?? cause.name}: ${cause.message}` : 'no cause';
	return new Error(
		`cron endpoint unreachable: ${error instanceof Error ? error.message : String(error)} (${detail})`
	);
}

// The schedule is every minute while the app is in early operation; raise to
// '*/15 * * * *' when user volume grows. The endpoint itself enforces at most one
// workload per invocation. Live channels rotate least-recently-run first,
// alternating with feedback previews when both classes are ready. N eligible
// live channels rotate about every N schedule intervals without previews,
// or 2N intervals under sustained preview contention. Multiply by the
// configured interval between invocations to get the elapsed time.
export const config = { schedule: '* * * * *' };
