import assert from 'node:assert/strict';
import { test } from 'vitest';
import { runPreflight } from './public-launch-preflight.mjs';

const SHA = 'a'.repeat(40);
const BASE = 'https://launch.example.test';
const goodHealth = () => new Response('{"status":"ok"}', { status: 200 });
const goodCommit = () => new Response(`${SHA}\n`, { status: 200 });

function fakeResponses(responses, calls = []) {
	return async (url, options) => {
		calls.push({ url: new URL(url), options });
		const next = responses.shift();
		if (next instanceof Error) throw next;
		assert.ok(next, 'unexpected extra request');
		return next;
	};
}

test('passes only after healthy database response and the exact expected commit', async () => {
	const calls = [];
	const result = await runPreflight(BASE, SHA, fakeResponses([goodHealth(), goodCommit()], calls));
	assert.equal(result.ok, true);
	assert.equal(result.checks.length, 2);
	assert.deepEqual(calls.map(({ url }) => url.pathname), ['/api/health', '/__moderaty_commit.txt']);
	assert.ok(calls[1].url.searchParams.has('preflight'));
	for (const { options } of calls) {
		assert.equal(options.method, 'GET');
		assert.equal(options.redirect, 'error');
		assert.equal(options.credentials, 'omit');
		assert.equal(options.headers.Authorization, undefined);
		assert.ok(options.signal instanceof AbortSignal);
	}
});

test('reports database failure but still verifies the release without leaking the body', async () => {
	const result = await runPreflight(BASE, SHA, fakeResponses([new Response('secret-body', { status: 503 }), goodCommit()]));
	assert.equal(result.ok, false);
	assert.equal(result.checks[0].httpStatus, 503);
	assert.equal(result.checks[0].ok, false);
	assert.equal(result.checks[1].ok, true);
	assert.ok(!JSON.stringify(result).includes('secret-body'));
});

for (const body of ['<html>proxy error</html>', '{}', '[]', '{"status":"degraded"}']) {
	test(`rejects a false-positive health body: ${body}`, async () => {
		const result = await runPreflight(BASE, SHA, fakeResponses([new Response(body), goodCommit()]));
		assert.equal(result.ok, false);
		assert.equal(result.checks[0].ok, false);
	});
}

for (const body of ['unknown', 'b'.repeat(40), '<html>login</html>']) {
	test(`rejects an unknown, stale or non-release commit marker: ${body.slice(0, 10)}`, async () => {
		const result = await runPreflight(BASE, SHA, fakeResponses([goodHealth(), new Response(body)]));
		assert.equal(result.ok, false);
		assert.equal(result.checks[1].ok, false);
	});
}

test('does not print a failed fetch exception that might contain a secret', async () => {
	const result = await runPreflight(BASE, SHA, fakeResponses([new Error('sensitive-url-token'), goodCommit()]));
	assert.equal(result.ok, false);
	assert.ok(!JSON.stringify(result).includes('sensitive-url-token'));
	assert.equal(result.checks[0].detail, 'Request failed or timed out');
});

test('rejects credentialed URLs, query strings, HTTP and non-root paths before any request', async () => {
	for (const base of ['https://user:password@example.test', `${BASE}?secret=value`, 'http://example.test', `${BASE}/api/cron`, `${BASE}#fragment`]) {
		await assert.rejects(runPreflight(base, SHA, async () => assert.fail('network must not run')), /plain HTTPS origin/);
	}
});

test('requires a complete expected SHA before any request', async () => {
	for (const expected of ['', 'unknown', 'f717d70']) {
		await assert.rejects(runPreflight(BASE, expected, async () => assert.fail('network must not run')), /40-character commit SHA/);
	}
});

test('rejects oversized response bodies without printing them', async () => {
	const body = 'sensitive'.repeat(1000);
	const result = await runPreflight(BASE, SHA, fakeResponses([new Response(body), goodCommit()]));
	assert.equal(result.ok, false);
	assert.ok(!JSON.stringify(result).includes('sensitive'));
});
