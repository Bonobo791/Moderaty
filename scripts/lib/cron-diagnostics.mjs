import { randomUUID } from 'node:crypto';

// This module is shared by the route and both scheduled wrappers. Error text,
// stacks, URLs, SQL, parameters, headers and response bodies never leave it.
const MAX_CAUSES = 8;
const MAX_FAILURES = 20;
const CATEGORIES = allowlist(['unknown', 'dns', 'database_busy', 'database', 'authentication', 'network', 'timeout', 'http']);
const CODES = allowlist(['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT',
	'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
	'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
	'SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED', 'SQLITE_LOCKED_SHAREDCACHE', 'SQLITE_ERROR',
	'SERVER_ERROR', 'UNAUTHORIZED', 'AUTH_ERROR', 'RATE_LIMITED', 'EAUTH', 'ESOCKET', 'EDNS', 'ESOCKETTIMEOUT']);
const NAMES = allowlist(['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'NetworkError',
	'DrizzleQueryError', 'LibsqlError', 'StripeAPIError', 'StripeConnectionError', 'StripeAuthenticationError', 'StripeRateLimitError']);
const SYSCALLS = allowlist(['getaddrinfo', 'connect', 'read', 'write', 'send', 'recv']);
const PROVIDERS = allowlist(['turso', 'stripe', 'google', 'openai', 'proton']);
const SERVICES = allowlist(['database', 'payments', 'billing', 'youtube', 'ai', 'mail', 'cron', 'monitoring']);
/** @type {Map<unknown, string>} */
const CODE_CATEGORIES = new Map([
	['EAI_AGAIN', 'dns'], ['ENOTFOUND', 'dns'], ['EDNS', 'dns'],
	['SQLITE_BUSY', 'database_busy'], ['SQLITE_BUSY_SNAPSHOT', 'database_busy'],
	['SQLITE_LOCKED', 'database_busy'], ['SQLITE_LOCKED_SHAREDCACHE', 'database_busy'],
	['UNAUTHORIZED', 'authentication'], ['AUTH_ERROR', 'authentication'], ['EAUTH', 'authentication'],
	['ETIMEDOUT', 'timeout'], ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
	['UND_ERR_HEADERS_TIMEOUT', 'timeout'], ['UND_ERR_BODY_TIMEOUT', 'timeout'], ['ESOCKETTIMEOUT', 'timeout']
]);
/** @type {Map<unknown, string>} */
const PROVIDER_SERVICES = new Map([['turso', 'database'], ['stripe', 'payments'], ['openai', 'ai']]);
/** @type {Map<unknown, string>} */
const TIMEOUT_CATEGORIES = new Map([['AbortError', 'timeout'], ['TimeoutError', 'timeout']]);
/** @type {Map<unknown, string>} */
const FALLBACK_CATEGORIES = new Map([['SQLITE_ERROR', 'database'], ['NetworkError', 'network']]);
const FORMAT_FIELDS = {
	code: 'code', syscall: 'syscall', httpStatus: 'httpStatus', provider: 'provider', service: 'service',
	operation: 'operation', cronRunId: 'run', chain: 'causes', causeChainTruncated: 'causeChainTruncated'
};

/** @type {Map<unknown, {sweep: string, operation: string, service: string, provider?: string}>} */
const CONTEXTS = new Map(Object.entries({
	'auto top-up sweep': { sweep: 'autoTopupSweepError', operation: 'auto_topup', service: 'billing' },
	'consent e-mail retention sweep': { sweep: 'sweepError', operation: 'consent_retention', service: 'database', provider: 'turso' },
	'commenter-handle retention sweep': { sweep: 'handleSweepError', operation: 'handle_retention', service: 'database', provider: 'turso' },
	'hosted welcome email sweep': { sweep: 'welcomeEmailSweepError', operation: 'welcome_email', service: 'mail' },
	'contact notification retry': { sweep: 'contactNotificationSweepError', operation: 'contact_notification', service: 'mail' },
	'stripe deletion outbox retry': { sweep: 'stripeDeletionSweepError', operation: 'stripe_deletion', service: 'payments', provider: 'stripe' },
	'stripe scrub outbox retry': { sweep: 'stripeScrubSweepError', operation: 'stripe_scrub', service: 'payments', provider: 'stripe' },
	'google revocation outbox retry': { sweep: 'googleRevocationSweepError', operation: 'google_revocation', service: 'youtube', provider: 'google' },
	'pending-reversal sweep': { sweep: 'pendingReversalSweepError', operation: 'pending_reversal', service: 'database', provider: 'turso' },
	'zero-credit account sweep': { sweep: 'zeroCreditSweepError', operation: 'zero_credit', service: 'billing' },
	'stale feedback preview cleanup': { sweep: 'feedbackPreviewSweepError', operation: 'preview_cleanup', service: 'database', provider: 'turso' },
	'workload claim': { sweep: 'schedulerError', operation: 'workload_claim', service: 'database', provider: 'turso' },
	'channel run': { sweep: 'channelRun', operation: 'channel_run', service: 'youtube' },
	'dry-run window drain': { sweep: 'dryRunWindow', operation: 'dry_run_window', service: 'youtube' },
	'feedback digest': { sweep: 'digest', operation: 'feedback_digest', service: 'ai' },
	'feedback preview': { sweep: 'feedbackPreview', operation: 'feedback_preview', service: 'ai' },
	'lease release': { sweep: 'leaseRelease', operation: 'lease_release', service: 'database', provider: 'turso' },
	'run-health bookkeeping': { sweep: 'bookkeepingError', operation: 'run_health_write', service: 'database', provider: 'turso' },
	'cron transport': { sweep: 'cronTransport', operation: 'cron_request', service: 'cron' },
	'healthcheck ping': { sweep: 'healthcheckPing', operation: 'healthcheck_ping', service: 'monitoring' }
}));
/** @type {Record<string, {service: string, provider?: string}>} */
const OPERATIONS = {
	'auto_topup.paused_recovery': { service: 'billing' },
	'auto_topup.release_claims': { service: 'database', provider: 'turso' },
	'auto_topup.lifetime_candidates': { service: 'database', provider: 'turso' },
	'auto_topup.paused_bundles': { service: 'database', provider: 'turso' },
	'auto_topup.eligible_candidates': { service: 'database', provider: 'turso' }
};
const SWEEPS = allowlist([...CONTEXTS.values()].map((context) => context.sweep));
const OPERATION_NAMES = allowlist([...CONTEXTS.values()].map((context) => context.operation).concat(Object.keys(OPERATIONS)));

const OPERATION_PHASES = allowlist(Object.keys(OPERATIONS));

/** @typedef {{name?: string, category: string, code?: string, syscall?: string, httpStatus?: number, provider?: string, service?: string}} SafeCause */
/** @typedef {SafeCause & {sweep: string, operation: string, cronRunId?: string, causes: SafeCause[], causeChainTruncated?: boolean}} CronFailure */
/** @type {SafeCause} */
const UNKNOWN_CAUSE = { category: 'unknown' };

/** The first defined value wins; the required fallback covers an empty list.
 * @template T @param {T} fallback @param {Array<T | undefined>} values @returns {T}
 */
function prefer(fallback, values) {
	for (const value of values) {
		if (value !== undefined) return value;
	}
	return fallback;
}

/** @param {string} value @returns {[string, string]} */
function identicalEntry(value) { return [value, value]; }
/** @param {string[]} values @returns {Map<unknown, string>} */
function allowlist(values) { return new Map(values.map(identicalEntry)); }
/** @type {Map<unknown, number>} */
const HTTP_STATUSES = new Map(Array.from({ length: 200 }, /** @returns {[number, number]} */ (_, index) => [index + 400, index + 400]));
/** @type {Map<unknown, string>} */
const CODE_PROVIDERS = new Map([
	['SQLITE_BUSY', 'turso'], ['SQLITE_BUSY_SNAPSHOT', 'turso'], ['SQLITE_LOCKED', 'turso'],
	['SQLITE_LOCKED_SHAREDCACHE', 'turso'], ['SQLITE_ERROR', 'turso']
]);
/** @type {Map<unknown, string>} */
const NAME_PROVIDERS = new Map([
	['LibsqlError', 'turso'], ['StripeAPIError', 'stripe'], ['StripeConnectionError', 'stripe'],
	['StripeAuthenticationError', 'stripe'], ['StripeRateLimitError', 'stripe']
]);
const MESSAGE_CATEGORIES = new Map([['request deadline exceeded', 'timeout']]);

/** Read only known fields; unusual thrown objects must not break the reporter. @param {unknown} value @param {string} key */
function field(value, key) {
	try { return typeof value === 'object' ? Reflect.get(Object(value), key) : undefined; }
	catch { return undefined; }
}
/** @param {unknown} value */
function runId(value) { return typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value) ? value : undefined; }

/** Select fixed classifications from text, never return text. @param {unknown} value @returns {SafeCause} */
function safeCause(value) {
	const message = field(value, 'message');
	const text = typeof message === 'string' ? message.slice(0, 2048) : '';
	// Stripe's SDK uses name="Error" and a specific type; retain that type.
	const name = prefer(undefined, [NAMES.get(field(value, 'type')), NAMES.get(field(value, 'name'))]);
	const code = CODES.get(field(value, 'code'));
	const provider = prefer(undefined, [PROVIDERS.get(field(value, 'provider')), CODE_PROVIDERS.get(code),
		NAME_PROVIDERS.get(name), /^OpenAI\b/i.test(text) ? 'openai' : undefined]);
	const service = prefer(undefined, [SERVICES.get(field(value, 'service')), PROVIDER_SERVICES.get(provider)]);
	const status = prefer(undefined, ['httpStatus', 'status', 'statusCode'].map((key) => HTTP_STATUSES.get(field(value, key))).concat([
		HTTP_STATUSES.get(field(field(value, 'response'), 'status')), HTTP_STATUSES.get(Number(/\bfailed: ([45]\d{2})\b/.exec(text)?.[1]))]));
	const category = prefer('unknown', [CODE_CATEGORIES.get(code), TIMEOUT_CATEGORIES.get(name),
		status ? 'http' : undefined, FALLBACK_CATEGORIES.get(code), FALLBACK_CATEGORIES.get(name),
		code ? 'network' : undefined, MESSAGE_CATEGORIES.get(text), /^fetch failed\b/.test(text) ? 'network' : undefined]);
	return { name, code, syscall: SYSCALLS.get(field(value, 'syscall')), httpStatus: status, provider, service, category };
}

/** @param {unknown} cause @param {string} defaultOperation */
function causeChain(cause, defaultOperation) {
	/** @type {SafeCause[]} */
	const causes = [];
	const seen = new Set();
	let current = cause;
	let operation = defaultOperation;
	while (current != null && !seen.has(current) && causes.length < MAX_CAUSES) {
		seen.add(current);
		causes.push(safeCause(current));
		operation = prefer(operation, [OPERATION_PHASES.get(field(current, 'diagnosticOperation'))]);
		current = field(current, 'cause');
	}
	return { causes, operation, truncated: current != null };
}

/** @param {SafeCause} root @param {SafeCause[]} causes @param {'provider' | 'service'} key @param {string | undefined} fallback */
function inheritedField(root, causes, key, fallback) {
	return prefer(fallback, [root[key], ...causes.toReversed().map((item) => item[key])]);
}

/** @param {unknown} cause @param {string} label @param {string} [cronRunId] @returns {CronFailure} */
export function describeCronFailure(cause, label, cronRunId) {
	const context = prefer({ sweep: 'cronTransport', operation: 'cron_request', service: 'cron' }, [CONTEXTS.get(label)]);
	const { causes, operation, truncated } = causeChain(cause, context.operation);
	const operationContext = { ...context, ...OPERATIONS[operation] };
	const root = prefer(UNKNOWN_CAUSE, [causes.findLast((item) => item.category !== 'unknown'), causes.at(-1)]);
	return { ...root, sweep: context.sweep, operation, cronRunId: runId(cronRunId),
		provider: inheritedField(root, causes, 'provider', operationContext.provider),
		service: inheritedField(root, causes, 'service', operationContext.service), causes,
		...(truncated ? { causeChainTruncated: true } : {}) };
}

/** Revalidate diagnostics from the HTTP boundary before formatting. @param {unknown} value @returns {CronFailure} */
export function sanitizeCronFailure(value) {
	const safe = safeCause(value);
	const causes = field(value, 'causes');
	return { ...safe, category: prefer(safe.category, [CATEGORIES.get(field(value, 'category'))]),
		sweep: prefer('cronTransport', [SWEEPS.get(field(value, 'sweep'))]),
		operation: prefer('cron_request', [OPERATION_NAMES.get(field(value, 'operation'))]),
		cronRunId: runId(field(value, 'cronRunId')),
		causes: Array.isArray(causes) ? causes.slice(0, MAX_CAUSES).map(safeCause) : [],
		...(field(value, 'causeChainTruncated') === true ? { causeChainTruncated: true } : {}) };
}

/** Root fields precede the bounded chain so wrapper limits cannot bury them. @param {unknown} value */
export function formatCronFailure(value) {
	const safe = sanitizeCronFailure(value);
	const parts = { ...safe, chain: safe.causes.map((cause) => prefer('unknown', [cause.code, cause.name])).join('>') };
	const fields = Object.entries(FORMAT_FIELDS).filter(([key]) => field(parts, key))
		.map(([key, label]) => `${label}=${field(parts, key)}`);
	return [safe.category, ...fields].join(' ');
}

/** Adds a fixed phase without altering attempts or retaining data in a message.
 * @template T @param {string} operation @param {() => Promise<T>} run @returns {Promise<T>}
 */
export async function withDiagnosticOperation(operation, run) {
	try { return await run(); }
	catch (cause) {
		throw Object.assign(new Error('Cron operation failed', { cause }), { diagnosticOperation: operation });
	}
}

export class CronDiagnostics {
	constructor() {
		this.cronRunId = randomUUID();
		/** @type {CronFailure[]} */
		this.failures = [];
	}
	/** @param {string} label @param {unknown} cause */
	report(label, cause) {
		const diagnostic = describeCronFailure(cause, label, this.cronRunId);
		if (this.failures.length < MAX_FAILURES) this.failures.push(diagnostic);
		console.error('cron failure:', JSON.stringify(diagnostic));
		return formatCronFailure(diagnostic);
	}
}
