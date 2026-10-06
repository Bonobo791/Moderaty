import { DrizzleQueryError } from 'drizzle-orm';
import { LibsqlError } from '@libsql/client';
import Stripe from 'stripe';
import { CronDiagnostics, describeCronFailure, formatCronFailure, sanitizeCronFailure, withDiagnosticOperation } from '../../../scripts/lib/cron-diagnostics.mjs';
import { expect, onTestFinished, test, vi } from 'vitest';

const runId = '11111111-1111-4111-8111-111111111111';
// Synthetic test-secret fixture uses the maintainer-approved exception
// documented in the existing cron tests (2026-07-30, PR #13).

test('reporting preserves earlier diagnostic snapshots and the bounded failure list', () => {
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	onTestFinished(() => log.mockRestore());
	const diagnostics = new CronDiagnostics();
	const emptySnapshot = diagnostics.failures;
	diagnostics.report('channel run', { code: 'ECONNRESET' });
	expect(emptySnapshot).toEqual([]);
	const firstSnapshot = Object.freeze(diagnostics.failures);
	for (let index = 0; index < 24; index++) diagnostics.report('lease release', { code: 'SQLITE_BUSY' });
	expect(firstSnapshot).toHaveLength(1);
	expect(firstSnapshot[0]).toMatchObject({ code: 'ECONNRESET', cronRunId: diagnostics.cronRunId });
	expect(diagnostics.failures).toHaveLength(20);
	expect(diagnostics.failures[19]).toMatchObject({ code: 'SQLITE_BUSY', cronRunId: diagnostics.cronRunId });
	expect(log).toHaveBeenCalledTimes(25);
});

test.each([
	[{ code: 'EAI_AGAIN', status: 503 }, 'dns', 'auto top-up sweep'],
	[{ code: 'SQLITE_BUSY', name: 'AbortError', status: 503 }, 'database_busy', 'auto top-up sweep'],
	[{ code: 'AUTH_ERROR', status: 500 }, 'authentication', 'auto top-up sweep'],
	[{ code: 'ETIMEDOUT', status: 500 }, 'timeout', 'auto top-up sweep'],
	[{ name: 'AbortError', status: 500 }, 'timeout', 'auto top-up sweep'],
	[{ code: 'SQLITE_ERROR', status: 503 }, 'http', 'auto top-up sweep'],
	[{ code: 'ECONNRESET', status: 503 }, 'http', 'auto top-up sweep'],
	[{ code: 'SQLITE_ERROR' }, 'database', 'auto top-up sweep'],
	[{ code: 'ECONNRESET' }, 'network', 'auto top-up sweep'],
	[Object.assign(new Error('private timeout body'), { code: 'ETIMEDOUT', syscall: 'connect' }), 'timeout', 'channel run'],
	[new Error('request deadline exceeded'), 'timeout', 'channel run']
])('preserves classification precedence for overlapping fields %j', (cause, category, context) => {
	expect(describeCronFailure(cause, context, runId).category).toBe(category);
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

const unknownFields = { category: 'unknown', provider: undefined };
type HostileFixture = { label: string; cause: unknown; context: string; expected: Record<string, unknown>; formatOverride?: Record<string, unknown> };
const hostileFixtures: HostileFixture[] = [
	...['__proto__', 'constructor', 'toString'].map((value) => ({ label: `prototype metadata: ${value}`,
		cause: { provider: value, service: value, diagnosticOperation: value }, context: value,
		expected: { ...unknownFields, service: 'cron', operation: 'cron_request' } })),
	{ label: 'boxed and coercible metadata', context: 'cron transport',
		cause: { code: Object('EAI_AGAIN'), name: Object('LibsqlError'), status: Object(500),
			provider: { toString() { throw new Error('test-secret'); } }, service: Object('database'), diagnosticOperation: Object('auto_topup.lifetime_candidates') },
		expected: { ...unknownFields, service: 'cron', operation: 'cron_request' } },
	{ label: 'ordinary operation name is not an annotation phase', context: 'auto top-up sweep',
		cause: { diagnosticOperation: 'channel_run' }, expected: { ...unknownFields, service: 'billing', operation: 'auto_topup' } },
	...[undefined, null, 42, 'test-secret', { message: 'test-secret', code: 'test-secret', name: 'test-secret', syscall: 'test-secret' }]
		.map((cause, index) => ({ label: `unknown or non-Error throw ${index}`, cause, context: 'auto top-up sweep',
			expected: { ...unknownFields, service: 'billing', operation: 'auto_topup' } })),
	{ label: 'payload, URL, headers, identifiers and unsafe formatted fields', context: 'auto top-up sweep',
		cause: Object.assign(new Error('https://user:test-secret@example.invalid/?token=test-secret recipient@example.com cus_private'), {
			name: 'test-secret', code: 'test-secret', syscall: 'test-secret', provider: 'test-secret', service: 'test-secret', status: '500 test-secret',
			headers: { authorization: 'Bearer test-secret' }, params: ['test-secret'], body: { token: 'test-secret' }, customerId: 'cus_private' }),
		expected: { ...unknownFields, service: 'billing', operation: 'auto_topup' },
		formatOverride: { code: 'test-secret', cronRunId: 'test-secret', operation: 'test-secret', causes: [{ name: 'test-secret' }] } },
	{ label: 'throwing cause accessor', context: 'auto top-up sweep',
		cause: Object.defineProperty({}, 'cause', { get() { throw new Error('test-secret'); } }),
		expected: { ...unknownFields, service: 'billing', operation: 'auto_topup' } }
];

test.each(hostileFixtures)('sanitizes $label', (fixture) => {
	const detail = describeCronFailure(fixture.cause, fixture.context, runId);
	expect(detail).toMatchObject({ ...fixture.expected, cronRunId: runId });
	expect(detail.code).toBeUndefined();
	expect(detail.httpStatus).toBeUndefined();
	const rendered = formatCronFailure({ ...detail, ...fixture.formatOverride });
	expect(rendered).toContain('unknown');
	const output = [JSON.stringify(detail), rendered].join(' ');
	for (const value of ['test-secret', 'recipient@example.com', 'cus_private']) expect(output).not.toContain(value);
});

test('retains the deepest known operation and classification through an unknown leaf', () => {
	const root = Object.assign(new Error('test-secret', { cause: 'test-secret' }), { code: 'EAI_AGAIN' });
	const inner = Object.assign(new Error('test-secret', { cause: root }), { diagnosticOperation: 'auto_topup.lifetime_candidates' });
	const outer = Object.assign(new Error('test-secret', { cause: inner }), { diagnosticOperation: 'auto_topup.paused_recovery' });
	expect(describeCronFailure(outer, 'auto top-up sweep', runId)).toMatchObject({
		category: 'dns', code: 'EAI_AGAIN', operation: 'auto_topup.lifetime_candidates', service: 'database', provider: 'turso'
	});
});

test('recognizes provider type on real Stripe SDK errors with a generic Error name', () => {
	const cause = new Stripe.errors.StripeAPIError({ message: 'test-secret', statusCode: 500 });
	expect(cause.name).toBe('Error');
	expect(describeCronFailure(cause, 'auto top-up sweep', runId)).toMatchObject({ category: 'http', httpStatus: 500, provider: 'stripe', service: 'payments' });
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

const providerFixtures = [
	{ label: 'outer database provider with nested HTTP failure', context: 'hosted welcome email sweep',
		cause: new LibsqlError('private URL test-secret', 'SERVER_ERROR', undefined, undefined,
			Object.assign(new Error('private response test-secret'), { status: 503 })),
		expected: { category: 'http', httpStatus: 503, provider: 'turso', service: 'database' }, summary: 'httpStatus=503' },
	...['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_BUSY_SNAPSHOT'].map((code) => ({ label: `nested contention: ${code}`, context: 'consent e-mail retention sweep',
		cause: new DrizzleQueryError('private SQL', ['test-secret'], Object.assign(new Error('busy test-secret'), { code })),
		expected: { category: 'database_busy', code, service: 'database', provider: 'turso' }, summary: `code=${code}` })),
	{ label: 'provider statusCode without response payload', context: 'stripe deletion outbox retry',
		cause: { type: 'StripeAPIError', statusCode: 500, raw: { message: 'test-secret' } },
		expected: { category: 'http', httpStatus: 500, provider: 'stripe', service: 'payments' }, summary: 'httpStatus=500' },
	{ label: 'nested provider response without headers', context: 'stripe deletion outbox retry',
		cause: Object.assign(new Error('provider test-secret'), { provider: 'stripe', service: 'payments', response: { status: 500, headers: { authorization: 'test-secret' } } }),
		expected: { category: 'http', httpStatus: 500, provider: 'stripe', service: 'payments' }, summary: 'httpStatus=500' },
	{ label: 'message-only HTTP status and known provider', context: 'channel run',
		cause: new Error('OpenAI moderation failed: 500 test-secret recipient@example.com'),
		expected: { category: 'http', httpStatus: 500, provider: 'openai', service: 'ai' }, summary: 'httpStatus=500' }
];

test.each(providerFixtures)('retains safe fields for $label', (fixture) => {
	const detail = describeCronFailure(fixture.cause, fixture.context, runId);
	expect(detail).toMatchObject(fixture.expected);
	expect(sanitizeCronFailure(detail)).toMatchObject(fixture.expected);
	expect(formatCronFailure(detail)).toContain(fixture.summary);
	expect(JSON.stringify(detail)).not.toContain('test-secret');
});

function nestedCause(depth: number, root: Error): Error {
	let cause = root;
	for (let i = 0; i < depth; i++) cause = new Error('test-secret', { cause });
	return cause;
}
const cycle: Error & { cause?: unknown } = new Error('test-secret');
cycle.cause = cycle;
const dnsRoot = Object.assign(new Error('test-secret'), { code: 'EAI_AGAIN' });

test.each([
	{ label: 'cycle', cause: cycle, category: 'unknown', truncated: true, length: 1 },
	{ label: 'long chain ending in a cycle', cause: nestedCause(30, cycle), category: 'unknown', truncated: true, length: 8 },
	{ label: 'DNS root at seven wrappers', cause: nestedCause(7, dnsRoot), category: 'dns', truncated: false, length: 8 },
	{ label: 'DNS root beyond eight wrappers', cause: nestedCause(8, dnsRoot), category: 'unknown', truncated: true, length: 8 }
])('bounds $label', (fixture) => {
	const detail = describeCronFailure(fixture.cause, 'auto top-up sweep', runId);
	expect(detail.category).toBe(fixture.category);
	expect(detail.causeChainTruncated === true).toBe(fixture.truncated);
	expect(detail.causes).toHaveLength(fixture.length);
	expect(JSON.stringify(detail).length).toBeLessThan(2000);
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
