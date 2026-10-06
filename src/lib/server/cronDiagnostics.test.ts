import { DrizzleQueryError } from 'drizzle-orm';
import { LibsqlError } from '@libsql/client';
import Stripe from 'stripe';
import { describeCronFailure, formatCronFailure, sanitizeCronFailure, withDiagnosticOperation } from '../../../scripts/lib/cron-diagnostics.mjs';
import { expect, test } from 'vitest';

const runId = '11111111-1111-4111-8111-111111111111';
// Synthetic test-secret fixture uses the maintainer-approved exception
// documented in the existing cron tests (2026-07-30, PR #13).

test.each([
	[{ code: 'EAI_AGAIN', status: 503 }, 'dns'],
	[{ code: 'SQLITE_BUSY', name: 'AbortError', status: 503 }, 'database_busy'],
	[{ code: 'AUTH_ERROR', status: 500 }, 'authentication'],
	[{ code: 'ETIMEDOUT', status: 500 }, 'timeout'],
	[{ name: 'AbortError', status: 500 }, 'timeout'],
	[{ code: 'SQLITE_ERROR', status: 503 }, 'http'],
	[{ code: 'ECONNRESET', status: 503 }, 'http'],
	[{ code: 'SQLITE_ERROR' }, 'database'],
	[{ code: 'ECONNRESET' }, 'network']
])('preserves classification precedence for overlapping fields %j', (cause, category) => {
	expect(describeCronFailure(cause, 'auto top-up sweep', runId).category).toBe(category);
});

test.each([
	[{ httpStatus: 401, status: 503, statusCode: 500, response: { status: 429 }, message: 'failed: 502' }, 401],
	[{ httpStatus: '401', status: 600, statusCode: 500, response: { status: 429 } }, 500],
	[{ status: 200, statusCode: 499.5, response: { status: 429 } }, 429],
	[{ status: '500', statusCode: null, message: 'failed: 503 test-secret' }, 503],
	[{ status: Infinity, statusCode: 399, response: { status: '500' } }, undefined]
])('selects the first valid HTTP status and rejects malformed fields %j', (cause, status) => {
	const detail = describeCronFailure(cause, 'cron transport', runId);
	expect(detail.httpStatus).toBe(status);
	expect(JSON.stringify(detail)).not.toContain('test-secret');
});

test.each(['__proto__', 'constructor', 'toString'])('rejects prototype-like provider and service names %s', (value) => {
	const detail = describeCronFailure({ provider: value, service: value, diagnosticOperation: value }, value, runId);
	expect(detail).toMatchObject({ category: 'unknown', service: 'cron', operation: 'cron_request' });
	expect(detail.provider).toBeUndefined();
});

test('retains the deepest known operation and classification through an unknown leaf', () => {
	const root = Object.assign(new Error('test-secret', { cause: 'test-secret' }), { code: 'EAI_AGAIN' });
	const inner = Object.assign(new Error('test-secret', { cause: root }), { diagnosticOperation: 'auto_topup.lifetime_candidates' });
	const outer = Object.assign(new Error('test-secret', { cause: inner }), { diagnosticOperation: 'auto_topup.paused_recovery' });
	expect(describeCronFailure(outer, 'auto top-up sweep', runId)).toMatchObject({
		category: 'dns', code: 'EAI_AGAIN', operation: 'auto_topup.lifetime_candidates', service: 'database', provider: 'turso'
	});
});

test.each([
	Object.assign(new Error('private timeout body'), { code: 'ETIMEDOUT', syscall: 'connect' }),
	new Error('request deadline exceeded')
])('classifies transport and shared run deadline timeouts', (cause) => {
	expect(describeCronFailure(cause, 'channel run', runId).category).toBe('timeout');
});

test('recognizes provider type on real Stripe SDK errors with a generic Error name', () => {
	const cause = new Stripe.errors.StripeAPIError({ message: 'test-secret', statusCode: 500 });
	expect(cause.name).toBe('Error');
	expect(describeCronFailure(cause, 'auto top-up sweep', runId)).toMatchObject({ category: 'http', httpStatus: 500, provider: 'stripe', service: 'payments' });
});

test('retains outer database provider context when the nested HTTP cause has none', () => {
	const root = Object.assign(new Error('private response test-secret'), { status: 503 });
	const cause = new LibsqlError('private URL test-secret', 'SERVER_ERROR', undefined, undefined, root);
	expect(describeCronFailure(cause, 'hosted welcome email sweep', runId)).toMatchObject({ category: 'http', httpStatus: 503, provider: 'turso', service: 'database' });
});

test('prefers the nested DNS cause to Drizzle SQL and fetch wrappers', () => {
	const root = Object.assign(new Error('getaddrinfo EAI_AGAIN private-host.invalid'), { code: 'EAI_AGAIN', syscall: 'getaddrinfo' });
	const cause = new DrizzleQueryError('select private_fixture where email = ?', ['private-fixture@example.com'], new TypeError('fetch failed', { cause: root }));
	const detail = describeCronFailure(cause, 'auto top-up sweep', runId);
	expect(detail).toMatchObject({ category: 'dns', code: 'EAI_AGAIN', syscall: 'getaddrinfo', cronRunId: runId, sweep: 'autoTopupSweepError' });
	expect(detail.causes).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'TypeError' }), expect.objectContaining({ code: 'EAI_AGAIN' })]));
	expect(formatCronFailure(detail)).toContain('EAI_AGAIN');
	for (const forbidden of ['private-fixture', 'private-host', 'select ', 'params:']) expect(JSON.stringify(detail)).not.toContain(forbidden);
});

test.each(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_BUSY_SNAPSHOT'])('retains safe nested database contention code %s', (code) => {
	const cause = new DrizzleQueryError('private SQL', ['test-secret'], Object.assign(new Error('busy test-secret'), { code }));
	expect(describeCronFailure(cause, 'consent e-mail retention sweep', runId)).toMatchObject({ category: 'database_busy', code, service: 'database', provider: 'turso' });
});

test.each([
	{ type: 'StripeAPIError', statusCode: 500, raw: { message: 'test-secret' } },
	Object.assign(new Error('provider test-secret'), { provider: 'stripe', service: 'payments', response: { status: 500, headers: { authorization: 'test-secret' } } })
])('captures provider HTTP status without the response payload', (cause) => {
	const detail = describeCronFailure(cause, 'stripe deletion outbox retry', runId);
	expect(detail).toMatchObject({ category: 'http', httpStatus: 500, provider: 'stripe', service: 'payments' });
	expect(sanitizeCronFailure(detail).httpStatus).toBe(500);
	expect(formatCronFailure(detail)).toContain('httpStatus=500');
	expect(JSON.stringify(detail)).not.toContain('test-secret');
});

test('extracts only status and known provider from existing message-only HTTP errors', () => {
	const detail = describeCronFailure(new Error('OpenAI moderation failed: 500 test-secret recipient@example.com'), 'channel run', runId);
	expect(detail).toMatchObject({ category: 'http', httpStatus: 500, provider: 'openai', service: 'ai' });
	expect(JSON.stringify(detail)).not.toContain('test-secret');
});

test.each([undefined, null, 42, 'test-secret', { message: 'test-secret', code: 'test-secret', name: 'test-secret', syscall: 'test-secret' }])('handles unknown or non-Error throws safely: %s', (cause) => {
	const detail = describeCronFailure(cause, 'auto top-up sweep', runId);
	expect(detail.category).toBe('unknown');
	expect(JSON.stringify(detail)).not.toContain('test-secret');
	expect(formatCronFailure(detail)).toContain('unknown');
});

test('bounds cycles and long cause chains with an explicit marker', () => {
	const cycle: Error & { cause?: unknown } = new Error('test-secret');
	cycle.cause = cycle;
	expect(describeCronFailure(cycle, 'auto top-up sweep', runId).causeChainTruncated).toBe(true);
	let cause = cycle;
	for (let i = 0; i < 30; i++) cause = new Error('test-secret', { cause });
	const detail = describeCronFailure(cause, 'auto top-up sweep', runId);
	expect(detail.causes.length).toBeLessThanOrEqual(8);
	expect(detail.causeChainTruncated).toBe(true);
	expect(JSON.stringify(detail).length).toBeLessThan(2000);
});

test.each([[7, 'dns', false], [8, 'unknown', true]] as const)('documents the cause traversal boundary at %s wrappers', (depth, category, truncated) => {
	let cause: Error = Object.assign(new Error('test-secret'), { code: 'EAI_AGAIN' });
	for (let i = 0; i < depth; i++) cause = new Error('test-secret', { cause });
	const detail = describeCronFailure(cause, 'auto top-up sweep', runId);
	expect(detail.category).toBe(category);
	expect(detail.causeChainTruncated === true).toBe(truncated);
	expect(detail.causes).toHaveLength(8);
});

test('ignores arbitrary error payloads, URLs, headers, identifiers and unsafe diagnostic fields', () => {
	const cause = Object.assign(new Error('https://user:test-secret@example.invalid/?token=test-secret recipient@example.com cus_private'), {
		name: 'test-secret', code: 'test-secret', syscall: 'test-secret', provider: 'test-secret',
		service: 'test-secret', status: '500 test-secret', headers: { authorization: 'Bearer test-secret' },
		params: ['test-secret'], body: { token: 'test-secret' }, customerId: 'cus_private'
	});
	const detail = describeCronFailure(cause, 'auto top-up sweep', runId);
	expect(detail.category).toBe('unknown');
	expect(detail.code).toBeUndefined();
	const rendered = formatCronFailure({ ...detail, code: 'test-secret', cronRunId: 'test-secret', operation: 'test-secret', causes: [{ name: 'test-secret' }] });
	for (const value of [JSON.stringify(detail), rendered]) {
		expect(value).not.toContain('test-secret');
		expect(value).not.toContain('recipient@example.com');
		expect(value).not.toContain('cus_private');
	}
});

test('handles throwing accessors without hiding the original failure', () => {
	const cause = Object.defineProperty({}, 'cause', { get() { throw new Error('test-secret'); } });
	expect(describeCronFailure(cause, 'auto top-up sweep', runId).category).toBe('unknown');
});

test('operation context preserves the original cause, result and exactly one attempt', async () => {
	let attempts = 0;
	const root = Object.assign(new Error('test-secret'), { code: 'EAI_AGAIN' });
	const failure = await withDiagnosticOperation('auto_topup.lifetime_candidates', async () => { attempts++; throw root; }).catch((cause) => cause);
	expect(attempts).toBe(1);
	expect(failure.cause).toBe(root);
	expect(describeCronFailure(failure, 'auto top-up sweep', runId)).toMatchObject({ operation: 'auto_topup.lifetime_candidates', category: 'dns', service: 'database' });
	expect(await withDiagnosticOperation('auto_topup.lifetime_candidates', async () => 7)).toBe(7);
});
