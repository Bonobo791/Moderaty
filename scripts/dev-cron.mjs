#!/usr/bin/env node
// Dev cron driver. Netlify Scheduled Functions only fire on the published
// production deploy — never on branch deploys, and nothing fires against
// `npm run dev` — so in every non-production environment the moderation
// pipeline only advances when something calls GET /api/cron. This script is
// that something: it ticks the endpoint on the same every-minute cadence as
// the Netlify function (at most one workload per tick, one page per dry-run
// window drain), with the secret in an Authorization header, never in the URL.
//
// Usage (run alongside `npm run dev` in a second terminal):
//   node --env-file=.env scripts/dev-cron.mjs            tick every 60s
//   node --env-file=.env scripts/dev-cron.mjs --once     one tick, then exit
//   node --env-file=.env scripts/dev-cron.mjs --interval-ms 5000
//
// APP_URL defaults to http://localhost:5173; set it to the dev branch deploy
// (with that deploy's CRON_SECRET) to drive the deployed instance instead.
//
// Coolify (docs/COOLIFY_BUNNY.md): the same script, in --once mode, is the
// scheduler for container deployments — a Coolify Scheduled Task runs
// `APP_URL=http://127.0.0.1:3000 node scripts/dev-cron.mjs --once` every
// minute inside the app container, replacing the Netlify Scheduled Function.
// Coolify emails on every non-zero exit, so the exit code is the alert
// channel: the script exits 1 only for operator-actionable failures:
// configuration/transport errors, non-suppressed HTTP failures, invalid payloads,
// failed sweeps/auxiliary jobs, an exhausted budget, a lost bookkeeping write,
// or a channel error category the channel owner cannot fix. Channel-owner
// states — 'credits' (top-up needed) and 'token' (reconnect needed) — are
// persistent and dashboard-visible. A non-OK response with only those channel
// failures and no operator problems logs a warning and exits 0 instead of
// emailing once a minute until the owner acts.
//
// Dead-man's switch: set HEALTHCHECK_PING_URL (healthchecks.io, Uptime Kuma
// push monitor, …): healthy and suppressed owner-actionable ticks attempt the
// ping. A tick that threw does NOT ping, so the monitor alerts on silence —
// which also covers a failure an exit code cannot report: the task never ran.

import { describeCronFailure, formatCronFailure, sanitizeCronFailure } from './lib/cron-diagnostics.mjs';

const DEFAULT_INTERVAL_MS = 60_000;

// Channel-run failure categories only the channel owner can resolve:
// 'credits' (buy a bundle / fix auto top-up) and 'token' (reconnect the
// channel's YouTube grant). They self-resolve when the owner acts, and the
// dashboard already surfaces them via last_run_error — an operator email
// every minute would be pure noise.
const USER_ACTIONABLE_CATEGORIES = new Set(['credits', 'token']);

// Sweep-error payload fields that mean "the app is broken", not "a channel is
// unhappy". A failure in any of them is invisible on the dashboard, so the
// exit code is the only alert path.
const SWEEP_ERROR_FIELDS = [
	'sweepError',
	'handleSweepError',
	'autoTopupSweepError',
	'stripeDeletionSweepError',
	'stripeScrubSweepError',
	'googleRevocationSweepError',
	'pendingReversalSweepError',
	'zeroCreditSweepError',
	'contactNotificationSweepError',
	'welcomeEmailSweepError',
	'feedbackPreviewSweepError'
];

/** Only allowlisted diagnostics cross back into scheduled task output. */
function tickDiagnostics(payload) {
	return Array.isArray(payload?.failureDiagnostics) ? payload.failureDiagnostics.slice(0, 20).map(sanitizeCronFailure) : [];
}

function failureDetail(payload, field) {
	const diagnostic = tickDiagnostics(payload).find((item) => item.sweep === field);
	return diagnostic ? formatCronFailure(diagnostic) : 'failure (no safe diagnostic)';
}

/** Bounded root-first output; legacy/raw body details are deliberately withheld. */
export function formatTickFailure(payload, problems) {
	const diagnostics = tickDiagnostics(payload);
	const details = diagnostics.map((item) => `${item.sweep}: ${formatCronFailure(item)}`);
	details.push(...problems.filter((problem) => !diagnostics.some((item) => problem.startsWith(`${item.sweep}:`))));
	const summary = details.map((detail) => detail.slice(0, 500)).join('; ');
	return summary.length > 5500 ? `${summary.slice(0, 5480)}; details truncated` : summary;
}

/** Never log response bodies or result keys (which identify customers/channels). */
export function renderTick(payload) {
	const problems = evaluateTick(true, payload).problems;
	const id = sanitizeCronFailure({ cronRunId: payload?.cronRunId }).cronRunId;
	return JSON.stringify({ valid: validTickPayload(payload), ok: typeof payload?.ok === 'boolean' ? payload.ok : undefined,
		cronRunId: id, problems: formatTickFailure(payload, problems) || undefined });
}

export function cronTransportError(cause) {
	return new Error(`cron endpoint unreachable: ${formatCronFailure(describeCronFailure(cause, 'cron transport'))}`);
}

/**
 * Extracts each channel result entry from a payload. A thrown run arrives as
 * `{ error: category }` inside `results` on a 500; a returned result has no
 * `error` field (out-of-credits reports `outOfCredits` on a 200 instead).
 */
function channelResultEntries(payload) {
	const results = payload && typeof payload === 'object' ? payload.results : null;
	if (!results || typeof results !== 'object' || Array.isArray(results)) return [];
	return Object.values(results).filter((entry) => entry && typeof entry === 'object');
}

/**
 * Operator-actionable problems carried inside an answered payload: failed
 * sweeps, an exhausted tick budget, a lost health write, or a channel error
 * in a category the owner cannot fix. Deliberately ignores `ok` — a thrown
 * channel run forces `ok:false` on its 500 body, which says nothing about
 * the sweeps; on a 200 the caller checks `ok` itself.
 */
/**
 * A 200's payload must be the cron endpoint's shape — `{ ok: boolean,
 * results: {...} }` — before any field can be classified. A proxy or
 * malformed response answering `[]`, `42`, or `{}` would otherwise read as
 * a healthy tick (cubic).
 */
export function validTickPayload(payload) {
	return (
		payload !== null &&
		typeof payload === 'object' &&
		!Array.isArray(payload) &&
		typeof payload.ok === 'boolean' &&
		payload.results !== null &&
		typeof payload.results === 'object' &&
		!Array.isArray(payload.results)
	);
}

function detailProblems(payload) {
	const problems = [];
	for (const field of SWEEP_ERROR_FIELDS) {
		// Sweep error text interpolates into a thrown Error the driver logs —
		// flatten CR/LF or a hostile body forges extra log lines (cubic).
		if (payload[field]) problems.push(`${field}: ${failureDetail(payload, field)}`);
	}
	if (payload.budgetExhausted) problems.push('sweeps consumed the run budget — no channel claimed');
	if (payload.bookkeepingError) problems.push('run-health bookkeeping write failed');
	// The dry-run drain, feedback digest, and pending-preview drain ride the
	// same 200 as top-level fields; all catch their failures into `{ error }`
	// so a broken aux job must not read as a healthy tick (codex). Success
	// objects have no `error` key; absent fields classify as not-run.
	for (const field of ['dryRunWindow', 'digest', 'feedbackPreview']) {
		const outcome = payload[field];
		if (outcome && typeof outcome === 'object' && typeof outcome.error === 'string') {
			problems.push(`${field}: ${failureDetail(payload, field)}`);
		}
	}
	// Per-account zero-credit eval failures ride a `ok:true` payload by design
	// — without this check a user whose evaluation throws every rotation
	// would retry forever, invisible to the scheduler (codeant).
	if (typeof payload.zeroCreditItemErrors === 'number' && payload.zeroCreditItemErrors > 0) {
		problems.push(`zeroCreditItemErrors: ${payload.zeroCreditItemErrors} account evaluation(s) failed`);
	}
	if (typeof payload.contactNotificationErrors === 'number' && payload.contactNotificationErrors > 0) {
		problems.push(`contactNotificationErrors: ${payload.contactNotificationErrors} contact delivery attempt(s) failed`);
	}
	if (typeof payload.welcomeEmailErrors === 'number' && payload.welcomeEmailErrors > 0) {
		problems.push(`welcomeEmailErrors: ${payload.welcomeEmailErrors} delivery attempt(s) failed`);
	}
	if (typeof payload.welcomeEmailEnrollmentErrors === 'number' && payload.welcomeEmailEnrollmentErrors > 0) {
		problems.push(`welcomeEmailEnrollmentErrors: ${payload.welcomeEmailEnrollmentErrors} account enrollment(s) failed`);
	}
	if (typeof payload.welcomeEmailAmbiguous === 'number' && payload.welcomeEmailAmbiguous > 0) {
		problems.push('welcomeEmailAmbiguous: reconciliation required');
	}
	problems.push(...channelRunProblems(payload));
	return problems;
}

function channelRunProblems(payload) {
	const problems = [];
	for (const entry of channelResultEntries(payload)) {
		if (typeof entry.error === 'string' && !USER_ACTIONABLE_CATEGORIES.has(entry.error)) {
			problems.push(`channel run failed: ${['quota', 'scoring', 'timeout', 'error'].includes(entry.error) ? entry.error : 'error'}`);
		}
		// A channel run that ended partial on the tick deadline returns inside
		// a 200 payload — without this check a moderation run that never
		// finished classifies as a healthy tick (codex). 'deactivated' stops
		// are owner-actionable (channel paused mid-run) and stay exempt, as
		// does `outOfCredits` (billing — dashboard-visible).
		if (entry.partial === true && entry.stoppedReason !== 'deactivated') {
			problems.push('channel run timed out before completing (partial)');
		}
	}
	return problems;
}

/**
 * Classifies an answered tick: `problems` lists every operator-actionable
 * failure the payload reports; `ownerActionableOnly` marks a non-OK response
 * whose channel errors are all credits/token (dashboard-visible and resolved
 * when the owner acts). Callers suppress that response only when `problems`
 * is empty. Shared by the local driver and the Netlify scheduled function so both classify
 * identical ticks identically (codex).
 */
export function evaluateTick(resOk, payload) {
	const problems = payload === null ? [] : detailProblems(payload);
	if (!resOk) {
		const entries = channelResultEntries(payload);
		const ownerActionableOnly =
			entries.length > 0 && entries.every((entry) => USER_ACTIONABLE_CATEGORIES.has(entry.error));
		return { ownerActionableOnly, problems };
	}
	// On a 200, `ok` is the real sweep aggregate — a failure there never
	// reaches the dashboard, so the caller's exit/report is its only alert.
	if (payload !== null && payload.ok === false && problems.length === 0) {
		problems.push('ok:false with no sweep error detail');
	}
	return { ownerActionableOnly: false, problems };
}

/**
 * Calls the app's cron endpoint once, loudly.
 *
 * @param {typeof fetch} [fetchImpl] - fetch implementation (tests inject a stub)
 * @returns {Promise<object>} The endpoint's JSON payload
 * @throws If CRON_SECRET is unset, the endpoint answers a non-suppressible
 *   failure, or an answered tick reports an ops-level problem — a tick that
 *   failed must never look like one that succeeded. The only suppressed
 *   non-OK is a run whose every channel failure is owner-actionable
 *   (credits/token): persistent, dashboard-visible, unfixable by the operator.
 */
export async function tickOnce(fetchImpl = fetch) {
	const base = process.env.APP_URL ?? 'http://localhost:5173';
	const secret = process.env.CRON_SECRET;
	if (!secret) {
		throw new Error('CRON_SECRET is not set. Run with: node --env-file=.env scripts/dev-cron.mjs');
	}
	let res;
	let rawText;
	try {
		res = await fetchImpl(`${base}/api/cron`, {
			headers: { Authorization: `Bearer ${secret}` },
			signal: AbortSignal.timeout(30_000)
		});
		rawText = await res.text();
	} catch (cause) { throw cronTransportError(cause); }
	let payload = null;
	try {
		payload = JSON.parse(rawText);
	} catch {
		payload = null;
	}
	console.log(`[${new Date().toISOString()}] tick → ${renderTick(payload)}`);
	const { ownerActionableOnly, problems } = evaluateTick(res.ok, payload);
	if (!res.ok) {
		if (ownerActionableOnly && problems.length === 0) {
			const categories = channelResultEntries(payload)
				.map((entry) => entry.error)
				.join(', ');
			console.warn(
				`cron endpoint answered ${res.status} with only channel-owner failure(s) [${categories}] — dashboard-visible, suppressing the scheduler alert`
			);
			return payload;
		}
		throw new Error(`cron endpoint answered ${res.status}: ${formatTickFailure(payload, problems) || 'no safe diagnostic'}`);
	}
	if (!validTickPayload(payload)) {
		throw new Error('cron endpoint returned a non-JSON or invalid body');
	}
	if (problems.length) {
		throw new Error(`cron tick reported failure(s): ${formatTickFailure(payload, problems)}`);
	}
	return payload;
}

/**
 * Dead-man's switch ping: GETs HEALTHCHECK_PING_URL after a healthy or suppressed
 * owner-actionable tick. Never throws — a monitor hiccup must not turn a healthy
 * tick into a failed scheduled task.
 */
export async function pingHealthcheck(fetchImpl = fetch) {
	const url = process.env.HEALTHCHECK_PING_URL;
	if (!url) return;
	try {
		const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) {
			console.error(`healthcheck ping answered ${res.status}`);
		}
	} catch (cause) {
		console.error('healthcheck ping failed:', formatCronFailure(describeCronFailure(cause, 'healthcheck ping')));
	}
}

/**
 * Parses driver flags into { once, intervalMs }, or returns null on any
 * malformed input — the caller prints usage and exits non-zero. A
 * non-positive interval is rejected: `setInterval(tick, 0)` would hot-loop
 * the endpoint and the local system (codeant); an interval past Node's
 * signed 32-bit timer limit is clamped to 1 ms by setTimeout — a typo like
 * 2147483648 would hot-loop the same way (cubic).
 */
export function parseDriverArgs(argv) {
	const once = argv.includes('--once');
	const intervalFlag = argv.indexOf('--interval-ms');
	const intervalMs =
		intervalFlag === -1 ? DEFAULT_INTERVAL_MS : Number.parseInt(argv[intervalFlag + 1] ?? '', 10);
	if (
		argv.some((a) => a !== '--once' && a !== '--interval-ms' && a !== String(intervalMs)) ||
		Number.isNaN(intervalMs) ||
		intervalMs <= 0 ||
		intervalMs > 2_147_483_647
	) {
		return null;
	}
	return { once, intervalMs };
}

/**
 * Schedules ticks serially: the next run is armed only after the current
 * tick settles. `setInterval` fires on the wall clock, so a tick slower than
 * the interval would overlap its successor — two in-flight ticks fight over
 * the same channel claim and sweep rows (codeant). `schedule` is injectable
 * for tests; it defaults to setTimeout.
 */
export function scheduleTicks(tick, intervalMs, schedule = setTimeout) {
	const step = () => void tick().finally(() => schedule(step, intervalMs));
	schedule(step, intervalMs);
}

// Only run the driver when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
	const parsed = parseDriverArgs(process.argv.slice(2));
	if (!parsed) {
		console.error('Usage: node --env-file=.env scripts/dev-cron.mjs [--once] [--interval-ms N]');
		process.exit(1);
	}
	const { once, intervalMs } = parsed;
	const tick = async () => {
		try {
			await tickOnce();
			// Only answered ticks ping: a thrown tick stays silent so the
			// dead-man's switch fires — that silence IS the alert.
			await pingHealthcheck();
		} catch (cause) {
			console.error('cron tick failed:', cause instanceof Error ? cause.message : 'unknown failure');
			return false;
		}
		return true;
	};
	if (!(await tick()) && once) process.exit(1);
	if (!once) {
		console.log(`dev cron driver: ticking every ${intervalMs / 1000}s (Ctrl+C to stop)`);
		scheduleTicks(tick, intervalMs);
	}
}
