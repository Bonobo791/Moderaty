#!/usr/bin/env node
// Credential-free, read-only release check. Never invokes /api/cron or signs in.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const MAX_BODY_BYTES = 4096;
const USAGE = 'Usage: node scripts/public-launch-preflight.mjs https://moderaty.com <full-commit-sha>';
const INVALID_ARGUMENTS = 'Invalid arguments: use a plain HTTPS origin and a full 40-character commit SHA';

function publicOrigin(base) {
	let url;
	try { url = new URL(base); } catch { throw new Error('Use a plain HTTPS origin'); }
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
		throw new Error('Use a plain HTTPS origin without credentials, a path, query or fragment');
	}
	return url.origin;
}

function responseVerdict(name, body, expected) {
	if (name === 'health') {
		try {
			const payload = JSON.parse(body);
			if (payload && !Array.isArray(payload) && payload.status === 'ok') return { ok: true, detail: 'Database-backed health response is ok' };
		} catch { /* A non-JSON response cannot establish health. */ }
		return { ok: false, detail: 'Health response was not a JSON object with status ok' };
	}
	const actual = body.trim().toLowerCase();
	if (!SHA_PATTERN.test(actual)) return { ok: false, detail: 'Commit marker was missing, unknown or invalid' };
	if (actual !== expected) return { ok: false, detail: 'Commit does not match the expected release', observedCommit: actual };
	return { ok: true, detail: 'Expected release commit is serving', observedCommit: actual };
}

// Returning from for-await cancels the stream. Never buffer past 4 KiB,
// even if the endpoint keeps sending data or omits Content-Length.
async function readSmallBody(response) {
	const chunks = [];
	let size = 0;
	for await (const chunk of response.body ?? []) {
		size += chunk.byteLength;
		if (size > MAX_BODY_BYTES) return null;
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, size).toString('utf8');
}

async function fetchCheck(url, name, expected, fetchImpl) {
	const response = await fetchImpl(url.toString(), {
		method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
		headers: { Accept: name === 'health' ? 'application/json' : 'text/plain', 'Cache-Control': 'no-cache' },
		signal: AbortSignal.timeout(10_000)
	});
	if (response.status !== 200) {
		await response.body?.cancel();
		return { httpStatus: response.status, ok: false, detail: 'Endpoint did not return HTTP 200' };
	}
	const body = await readSmallBody(response);
	const verdict = body === null
		? { ok: false, detail: 'Unexpected oversized response' }
		: responseVerdict(name, body, expected);
	return { httpStatus: response.status, ...verdict };
}

async function checkEndpoint(origin, name, path, expected, fetchImpl) {
	const url = new URL(path, origin);
	if (name === 'release') url.searchParams.set('preflight', String(Date.now()));
	const started = performance.now();
	let result;
	try {
		result = await fetchCheck(url, name, expected, fetchImpl);
	} catch {
		// Raw errors and response bodies can contain secrets or provider data.
		result = { ok: false, detail: 'Request failed or timed out' };
	}
	return { name, path, ...result, elapsedMs: Math.round(performance.now() - started) };
}

export async function runPreflight(base, expectedCommit, fetchImpl = fetch) {
	const origin = publicOrigin(base);
	if (typeof expectedCommit !== 'string' || !SHA_PATTERN.test(expectedCommit)) {
		throw new Error('Supply the expected full 40-character commit SHA');
	}
	const expected = expectedCommit.toLowerCase();
	const health = await checkEndpoint(origin, 'health', '/api/health', expected, fetchImpl);
	const release = await checkEndpoint(origin, 'release', '/__moderaty_commit.txt', expected, fetchImpl);
	const checks = [health, release];
	return { checkedAt: new Date().toISOString(), origin, expectedCommit: expected, ok: checks.every((check) => check.ok), checks };
}

async function runCli(argv) {
	if (argv.length !== 2) {
		console.error(USAGE);
		return 2;
	}
	try {
		const report = await runPreflight(argv[0], argv[1]);
		console.log(JSON.stringify(report, null, 2));
		return report.ok ? 0 : 1;
	} catch {
		console.error(INVALID_ARGUMENTS);
		return 2;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await runCli(process.argv.slice(2));
}
