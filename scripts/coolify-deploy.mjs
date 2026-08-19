#!/usr/bin/env node
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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
//
// Coolify deploy guarantee (docs/COOLIFY_BUNNY.md). Coolify's GitHub App
// auto-deploy is the primary push-to-deploy trigger, but its webhook endpoint
// (https://<coolify>/webhooks/source/github/events) can silently stop being
// reachable — the documented failure mode for "every commit auto-deploys".
// This script makes each push's redeploy OBSERVABLE and, with --fallback,
// GUARANTEED: it polls the Coolify API for a deployment queued for the pushed
// commit, and if the webhook did not fire in time it triggers the deployment
// directly via the API. When auto-deploy works the script only verifies, so
// it never double-deploys. Missing credentials fail loudly (exit non-zero),
// never a silent no-op — same contract as scripts/bunny-purge.mjs.
//
// API shapes verified against the Coolify OpenAPI spec
// (https://raw.githubusercontent.com/coollabsio/coolify/main/openapi.yaml):
//   GET  /api/v1/deployments/applications/{uuid}?take=N -> ApplicationDeploymentQueue[]
//        (each has deployment_uuid, commit, status, created_at)
//   POST /api/v1/deploy?uuid=<app> -> { deployments: [{message, resource_uuid, deployment_uuid}] }

const DEPLOY_VERIFY_TIMEOUT_MS = 180_000;
const DEPLOY_VERIFY_POLL_MS = 10_000;
const API_TIMEOUT_MS = 30_000;

/** Base URL of the Coolify API (server URL + /api/v1), or throw loudly. */
export function coolifyBase() {
	const serverUrl = process.env.COOLIFY_SERVER_URL;
	if (!serverUrl) {
		throw new Error('COOLIFY_SERVER_URL is not set — cannot reach the Coolify API');
	}
	const trimmed = serverUrl.endsWith('/') ? serverUrl.slice(0, -1) : serverUrl;
	return `${trimmed}/api/v1`;
}

/** Coolify API token (COOLIFY_API_TOKEN; the local .env's COOLIFY value also works). */
export function coolifyToken() {
	const token = process.env.COOLIFY_API_TOKEN || process.env.COOLIFY;
	if (!token) {
		throw new Error('COOLIFY_API_TOKEN is not set — the Coolify API cannot be authenticated');
	}
	return token;
}

/**
 * Authenticated Coolify API call. Fails loudly on non-OK responses.
 * @param {string} path - API path starting with '/'.
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {typeof fetch} [options.fetchImpl=fetch]
 * @returns {Promise<unknown>} Parsed JSON payload.
 */
export async function coolifyRequest(path, { method = 'GET', fetchImpl = fetch, timeoutMs = API_TIMEOUT_MS } = {}) {
	let res;
	try {
		res = await fetchImpl(`${coolifyBase()}${path}`, {
			method,
			headers: { Authorization: `Bearer ${coolifyToken()}` },
			signal: AbortSignal.timeout(timeoutMs)
		});
	} catch (cause) {
		throw new Error(`Coolify API ${method} ${path} failed: ${cause.message}`, { cause });
	}
	if (!res.ok) {
		throw new Error(`Coolify API ${method} ${path} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
	}
	return res.json();
}

/**
 * Whether a deployment's commit matches the expected commit. Coolify may
 * report the full SHA, a 12-char abbreviation, or a 7-char abbreviation.
 * @param {unknown} deploymentCommit
 * @param {string} expectedCommit
 * @returns {boolean}
 */
export function commitMatches(deploymentCommit, expectedCommit) {
	if (typeof deploymentCommit !== 'string' || !expectedCommit) return false;
	const actual = deploymentCommit.trim();
	const expected = String(expectedCommit).trim();
	return actual === expected || actual === expected.slice(0, 12) || actual === expected.slice(0, 7);
}

/**
 * First deployment in the list whose commit matches the expected commit.
 * @param {Array<object>} deployments - ApplicationDeploymentQueue entries.
 * @param {string} expectedCommit
 * @returns {object|null}
 */
export function findDeploymentForCommit(deployments, expectedCommit, sinceMs) {
	return (deployments ?? []).find((d) => {
		if (!commitMatches(d?.commit, expectedCommit)) return false;
		// I2: a matching item without a deployment_uuid is malformed — never a
		// confirmation (codex P2). Missing/invalid created_at counts as old.
		if (typeof d?.deployment_uuid !== 'string' || !d.deployment_uuid) return false;
		if (sinceMs !== undefined) {
			const createdMs = Date.parse(d?.created_at);
			if (!Number.isFinite(createdMs) || createdMs < sinceMs) return false;
		}
		return true;
	}) ?? null;
}

/**
 * Poll the application's deployments until a deployment for the expected
 * commit is queued, or the timeout elapses.
 * @param {string} appUuid
 * @param {string} expectedCommit
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pollMs]
 * @param {typeof fetch} [options.fetchImpl=fetch]
 * @returns {Promise<{deploymentUuid: string, status: string, commit: string}|null>}
 */
export async function verifyDeploymentQueued(appUuid, expectedCommit, { timeoutMs = DEPLOY_VERIFY_TIMEOUT_MS, pollMs = DEPLOY_VERIFY_POLL_MS, sinceMs, fetchImpl = fetch } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const deployments = await coolifyRequest(`/deployments/applications/${encodeURIComponent(appUuid)}?take=20`, { fetchImpl });
		const hit = findDeploymentForCommit(deployments, expectedCommit, sinceMs);
		if (hit) {
			return { deploymentUuid: hit.deployment_uuid, status: hit.status, commit: hit.commit };
		}
		if (Date.now() + pollMs >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
	return null;
}

/**
 * Trigger a deployment for an application directly via the API (the fallback
 * path when the GitHub App webhook did not fire).
 * @param {string} appUuid
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl=fetch]
 * @returns {Promise<Array<object>>} The deployments the API created.
 */
export async function triggerDeploy(appUuid, { fetchImpl = fetch } = {}) {
	const payload = await coolifyRequest(`/deploy?uuid=${encodeURIComponent(appUuid)}`, { method: 'POST', fetchImpl });
	return payload?.deployments ?? [];
}

function parsePositiveSeconds(value, flag) {
	if (value === undefined) {
		throw new Error(`${flag} requires a value — e.g. ${flag} 180`);
	}
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new Error(`${flag} must be a positive number, got: ${value}`);
	}
	return seconds;
}

/**
 * Parses the `--since` value into epoch milliseconds. Accepts an ISO-8601
 * timestamp OR a Unix epoch in SECONDS: GitHub's push event exposes
 * `repository.pushed_at` as an epoch integer (not ISO-8601 like
 * `head_commit.timestamp`), so the workflow passes it through unchanged.
 */
export function parseSince(value) {
	if (value === undefined) return undefined;
	// A 9+ digit integer is an epoch in seconds, which Date.parse() rejects.
	if (/^\d{9,}$/.test(value)) {
		const epochMs = Number(value) * 1000;
		if (Number.isFinite(epochMs)) return epochMs;
	}
	const ms = Date.parse(value);
	if (!Number.isFinite(ms)) {
		throw new TypeError(`--since must be an ISO-8601 timestamp or Unix epoch (seconds), got: ${value}`);
	}
	return ms;
}

function parseArgs(argv) {
	const args = { fallback: false, timeoutMs: DEPLOY_VERIFY_TIMEOUT_MS, pollMs: DEPLOY_VERIFY_POLL_MS, sinceMs: undefined, positional: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--fallback') args.fallback = true;
		else if (a === '--timeout-sec') args.timeoutMs = parsePositiveSeconds(argv[++i], '--timeout-sec') * 1000;
		else if (a === '--poll-sec') args.pollMs = parsePositiveSeconds(argv[++i], '--poll-sec') * 1000;
		else if (a === '--since') args.sinceMs = parseSince(argv[++i]);
		else if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
		else args.positional.push(a);
	}
	return args;
}

/**
 * CLI entrypoint: verify the pushed commit is being deployed; with --fallback,
 * trigger the deploy via the API when the webhook did not fire.
 * @param {string[]} [argv]
 * @returns {Promise<number>} Process exit code (0 verified/triggered, 1 not deployed).
 */
export async function main(argv = process.argv.slice(2)) {
	const { fallback, timeoutMs, pollMs, sinceMs, positional } = parseArgs(argv);
	const [appUuid, expectedCommit] = positional;
	if (!appUuid || !expectedCommit) {
		throw new Error('usage: node scripts/coolify-deploy.mjs <app-uuid> <expected-commit> [--fallback] [--timeout-sec N] [--poll-sec N] [--since ISO-8601-or-epoch-seconds]');
	}
	const short = expectedCommit.slice(0, 12);
	const queued = await verifyDeploymentQueued(appUuid, expectedCommit, { timeoutMs, pollMs, sinceMs });
	if (queued) {
		console.log(`[${new Date().toISOString()}] coolify deploy confirmed for ${short}: deployment ${queued.deploymentUuid} (${queued.status})`);
		// A terminal failure means the redeploy did NOT succeed — the guarantee
		// must fail loudly, not pass with a warning (codeant).
		if (['failed', 'error', 'cancelled'].includes(queued.status)) {
			console.error(`ERROR: deployment ${queued.deploymentUuid} ended ${queued.status} — the redeploy did not succeed; check the Coolify logs`);
			return 1;
		}
		return 0;
	}
	if (fallback) {
		console.error(`[${new Date().toISOString()}] WARNING: no Coolify deployment for ${short} within ${Math.round(timeoutMs / 1000)}s — the GitHub App webhook may be unreachable; triggering via the API`);
		// Final recheck: a delayed GitHub App webhook deployment can become
		// visible after the last poll but before this POST. Triggering anyway
		// would race it into a duplicate deployment, so recheck once and skip
		// the API trigger when the commit just appeared (codeant).
		const late = await verifyDeploymentQueued(appUuid, expectedCommit, { timeoutMs: pollMs, pollMs, sinceMs });
		if (late) {
			console.log(`[${new Date().toISOString()}] coolify deploy confirmed (late webhook) for ${short}: deployment ${late.deploymentUuid} (${late.status})`);
			if (['failed', 'error', 'cancelled'].includes(late.status)) {
				console.error(`ERROR: deployment ${late.deploymentUuid} ended ${late.status} — the redeploy did not succeed; check the Coolify logs`);
				return 1;
			}
			return 0;
		}
		const triggered = await triggerDeploy(appUuid);
		for (const t of triggered) {
			console.log(`[${new Date().toISOString()}] coolify deploy triggered: ${t.deployment_uuid} (${t.resource_uuid})`);
		}
		if (triggered.length === 0) {
			throw new Error('Coolify API accepted /deploy but returned no deployment');
		}
		return 0;
	}
	console.error(`[${new Date().toISOString()}] ERROR: no Coolify deployment queued for ${short} within ${Math.round(timeoutMs / 1000)}s (run with --fallback to trigger via the API)`);
	return 1;
}

// Only run when executed directly, not when imported by tests. Compare
// NORMALIZED absolute paths so a relative argv[1] still enters the flow
// (coderabbit — same guard as scripts/bunny-purge.mjs).
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = await main();
	} catch (cause) {
		console.error('coolify deploy failed:', cause);
		process.exit(1);
	}
}
