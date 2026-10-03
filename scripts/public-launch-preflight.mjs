#!/usr/bin/env node
// Credential-free, read-only release check. Never invokes /api/cron or signs in.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const MAX_BODY_LENGTH = 4096;

function publicOrigin(base) {
	let url;
	try { url = new URL(base); } catch { throw new Error('Use a plain HTTPS origin'); }
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
		throw new Error('Use a plain HTTPS origin without credentials, a path, query or fragment');
	}
	return url.origin;
}

function responseVerdict(name, body, expected) {
	if (body.length > MAX_BODY_LENGTH) return { ok: false, detail: 'Unexpected oversized response' };
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

export async function runPreflight(base, expectedCommit, fetchImpl = fetch) {
	const origin = publicOrigin(base);
	if (typeof expectedCommit !== 'string' || !SHA_PATTERN.test(expectedCommit)) {
		throw new Error('Supply the expected full 40-character commit SHA');
	}
	const expected = expectedCommit.toLowerCase();
	const checks = [];
	for (const [name, path] of [['health', '/api/health'], ['release', '/__moderaty_commit.txt']]) {
		const url = new URL(path, origin);
		if (name === 'release') url.searchParams.set('preflight', String(Date.now()));
		const started = performance.now();
		let result;
		try {
			const response = await fetchImpl(url.toString(), {
				method: 'GET',
				redirect: 'error',
				credentials: 'omit',
				cache: 'no-store',
				headers: { Accept: name === 'health' ? 'application/json' : 'text/plain', 'Cache-Control': 'no-cache' },
				signal: AbortSignal.timeout(10_000)
			});
			result = response.status === 200
				? { httpStatus: response.status, ...responseVerdict(name, await response.text(), expected) }
				: { httpStatus: response.status, ok: false, detail: 'Endpoint did not return HTTP 200' };
		} catch {
			// Raw errors and response bodies can contain secrets or provider data.
			result = { ok: false, detail: 'Request failed or timed out' };
		}
		checks.push({ name, path, ...result, elapsedMs: Math.round(performance.now() - started) });
	}
	return { checkedAt: new Date().toISOString(), origin, expectedCommit: expected, ok: checks.every((check) => check.ok), checks };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 4) {
		console.error('Usage: node scripts/public-launch-preflight.mjs https://moderaty.com <full-commit-sha>');
		process.exitCode = 2;
	} else {
		try {
			const report = await runPreflight(process.argv[2], process.argv[3]);
			console.log(JSON.stringify(report, null, 2));
			process.exitCode = report.ok ? 0 : 1;
		} catch {
			console.error('Invalid arguments: use a plain HTTPS origin and a full 40-character commit SHA');
			process.exitCode = 2;
		}
	}
}
