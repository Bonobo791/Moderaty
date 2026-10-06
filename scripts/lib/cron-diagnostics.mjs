import { randomUUID } from 'node:crypto';

// This module is shared by the route and both scheduled wrappers. Error text,
// stacks, URLs, SQL, parameters, headers and response bodies never leave it.
const MAX_CAUSES = 8;
const MAX_FAILURES = 20;
const CATEGORIES = new Set(['unknown', 'dns', 'database_busy', 'database', 'authentication', 'network', 'timeout', 'http']);
const CODES = new Set(['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT',
	'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
	'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
	'SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED', 'SQLITE_LOCKED_SHAREDCACHE', 'SQLITE_ERROR',
	'SERVER_ERROR', 'UNAUTHORIZED', 'AUTH_ERROR', 'RATE_LIMITED', 'EAUTH', 'ESOCKET', 'EDNS', 'ESOCKETTIMEOUT']);
const NAMES = new Set(['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'NetworkError',
	'DrizzleQueryError', 'LibsqlError', 'StripeAPIError', 'StripeConnectionError', 'StripeAuthenticationError', 'StripeRateLimitError']);
const SYSCALLS = new Set(['getaddrinfo', 'connect', 'read', 'write', 'send', 'recv']);
const PROVIDERS = new Set(['turso', 'stripe', 'google', 'openai', 'proton']);
const SERVICES = new Set(['database', 'payments', 'billing', 'youtube', 'ai', 'mail', 'cron', 'monitoring']);
const CODE_CATEGORIES = new Map([
	['EAI_AGAIN', 'dns'], ['ENOTFOUND', 'dns'], ['EDNS', 'dns'],
	['SQLITE_BUSY', 'database_busy'], ['SQLITE_BUSY_SNAPSHOT', 'database_busy'],
	['SQLITE_LOCKED', 'database_busy'], ['SQLITE_LOCKED_SHAREDCACHE', 'database_busy'],
	['UNAUTHORIZED', 'authentication'], ['AUTH_ERROR', 'authentication'], ['EAUTH', 'authentication'],
	['ETIMEDOUT', 'timeout'], ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
	['UND_ERR_HEADERS_TIMEOUT', 'timeout'], ['UND_ERR_BODY_TIMEOUT', 'timeout'], ['ESOCKETTIMEOUT', 'timeout']
]);
const PROVIDER_SERVICES = new Map([['turso', 'database'], ['stripe', 'payments'], ['openai', 'ai']]);

/** @type {Record<string, {sweep: string, operation: string, service: string, provider?: string}>} */
const CONTEXTS = {
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
};
/** @type {Record<string, {service: string, provider?: string}>} */
const OPERATIONS = {
	'auto_topup.paused_recovery': { service: 'billing' },
	'auto_topup.release_claims': { service: 'database', provider: 'turso' },
	'auto_topup.lifetime_candidates': { service: 'database', provider: 'turso' },
	'auto_topup.paused_bundles': { service: 'database', provider: 'turso' },
	'auto_topup.eligible_candidates': { service: 'database', provider: 'turso' }
};
const SWEEPS = new Set(Object.values(CONTEXTS).map((context) => context.sweep));
const OPERATION_NAMES = new Set([...Object.values(CONTEXTS).map((context) => context.operation), ...Object.keys(OPERATIONS)]);

/** @typedef {{name?: string, category: string, code?: string, syscall?: string, httpStatus?: number, provider?: string, service?: string}} SafeCause */
/** @typedef {SafeCause & {sweep: string, operation: string, cronRunId?: string, causes: SafeCause[], causeChainTruncated?: boolean}} CronFailure */

/** Read only known fields; unusual thrown objects must not break the reporter. @param {unknown} value @param {string} key */
function field(value, key) {
	try { return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined; }
	catch { return undefined; }
}
/** @param {Set<string>} allowed @param {unknown} value */
function allowed(allowed, value) { return typeof value === 'string' && allowed.has(value) ? value : undefined; }
/** @param {unknown} value */
function httpStatus(value) { return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined; }
/** @param {unknown} value */
function runId(value) { return typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value) ? value : undefined; }

/** @param {SafeCause} cause */
function category(cause) {
	const codeCategory = CODE_CATEGORIES.get(cause.code ?? '');
	if (codeCategory) return codeCategory;
	if (['AbortError', 'TimeoutError'].includes(cause.name ?? '')) return 'timeout';
	if (cause.httpStatus) return 'http';
	if (cause.code === 'SQLITE_ERROR') return 'database';
	if (cause.code || cause.name === 'NetworkError') return 'network';
	return 'unknown';
}

/** @param {unknown} value */
function boundedMessage(value) {
	const message = field(value, 'message');
	return typeof message === 'string' ? message.slice(0, 2048) : '';
}

/** @param {unknown} value @param {string} text */
function causeStatus(value, text) {
	for (const key of ['httpStatus', 'status', 'statusCode']) {
		const status = httpStatus(field(value, key));
		if (status) return status;
	}
	// Existing provider helpers encode the status after "failed:". Only
	// that numeric field is recovered; all body text remains private.
	return httpStatus(field(field(value, 'response'), 'status'))
		?? httpStatus(Number(/\bfailed: ([45]\d{2})\b/.exec(text)?.[1]));
}

/** @param {unknown} value @param {string | undefined} code @param {string | undefined} name @param {string} text */
function causeProvider(value, code, name, text) {
	const explicit = allowed(PROVIDERS, field(value, 'provider'));
	if (explicit) return explicit;
	if (code?.startsWith('SQLITE_') || name === 'LibsqlError') return 'turso';
	if (name?.startsWith('Stripe')) return 'stripe';
	if (/^OpenAI\b/i.test(text)) return 'openai';
	return undefined;
}

/** Recognized message-only transport errors get a fixed category. @param {SafeCause} safe @param {string} text */
function causeCategory(safe, text) {
	const classified = category(safe);
	if (classified !== 'unknown') return classified;
	if (/^fetch failed\b/.test(text)) return 'network';
	if (text === 'request deadline exceeded') return 'timeout';
	return 'unknown';
}

/** Select fixed classifications from text, never return text. @param {unknown} value @returns {SafeCause} */
function safeCause(value) {
	const text = boundedMessage(value);
	// Stripe's SDK uses name="Error" and a specific type; retain that type.
	const name = allowed(NAMES, field(value, 'type')) ?? allowed(NAMES, field(value, 'name'));
	const code = allowed(CODES, field(value, 'code'));
	const provider = causeProvider(value, code, name, text);
	const service = allowed(SERVICES, field(value, 'service')) ?? PROVIDER_SERVICES.get(provider ?? '');
	const safe = { name, code, syscall: allowed(SYSCALLS, field(value, 'syscall')), httpStatus: causeStatus(value, text), provider, service, category: 'unknown' };
	return { ...safe, category: causeCategory(safe, text) };
}

/** @param {unknown} cause @param {string} defaultOperation */
function causeChain(cause, defaultOperation) {
	/** @type {SafeCause[]} */
	const causes = [];
	const seen = new Set();
	let current = cause;
	let operation = defaultOperation;
	while (current !== undefined && current !== null && !seen.has(current) && causes.length < MAX_CAUSES) {
		seen.add(current);
		causes.push(safeCause(current));
		const annotated = field(current, 'diagnosticOperation');
		if (typeof annotated === 'string' && Object.hasOwn(OPERATIONS, annotated)) {
			operation = annotated;
		}
		current = field(current, 'cause');
	}
	return { causes, operation, truncated: current !== undefined && current !== null };
}

/** @param {SafeCause} root @param {SafeCause[]} causes @param {'provider' | 'service'} key @param {string | undefined} fallback */
function inheritedField(root, causes, key, fallback) {
	return root[key] ?? causes.findLast((item) => item[key])?.[key] ?? fallback;
}

/** @param {unknown} cause @param {string} label @param {string} [cronRunId] @returns {CronFailure} */
export function describeCronFailure(cause, label, cronRunId) {
	const context = Object.hasOwn(CONTEXTS, label) ? CONTEXTS[label] : CONTEXTS['cron transport'];
	const { causes, operation, truncated } = causeChain(cause, context.operation);
	const operationContext = OPERATIONS[operation];
	const root = causes.findLast((item) => item.category !== 'unknown') ?? causes.at(-1) ?? { category: 'unknown' };
	return { ...root, sweep: context.sweep, operation, cronRunId: runId(cronRunId),
		provider: inheritedField(root, causes, 'provider', operationContext?.provider ?? context.provider),
		service: inheritedField(root, causes, 'service', operationContext?.service ?? context.service), causes,
		...(truncated ? { causeChainTruncated: true } : {}) };
}

/** Revalidate diagnostics from the HTTP boundary before formatting. @param {unknown} value @returns {CronFailure} */
export function sanitizeCronFailure(value) {
	const safe = safeCause(value);
	const causes = field(value, 'causes');
	return { ...safe, category: allowed(CATEGORIES, field(value, 'category')) ?? safe.category,
		sweep: allowed(SWEEPS, field(value, 'sweep')) ?? 'cronTransport',
		operation: allowed(OPERATION_NAMES, field(value, 'operation')) ?? 'cron_request',
		cronRunId: runId(field(value, 'cronRunId')),
		causes: Array.isArray(causes) ? causes.slice(0, MAX_CAUSES).map(safeCause) : [],
		...(field(value, 'causeChainTruncated') === true ? { causeChainTruncated: true } : {}) };
}

/** Root fields precede the bounded chain so wrapper limits cannot bury them. @param {unknown} value */
export function formatCronFailure(value) {
	const safe = sanitizeCronFailure(value);
	const fields = [safe.category, safe.code && `code=${safe.code}`, safe.syscall && `syscall=${safe.syscall}`,
		safe.httpStatus && `httpStatus=${safe.httpStatus}`, safe.provider && `provider=${safe.provider}`, safe.service && `service=${safe.service}`,
		`operation=${safe.operation}`, safe.cronRunId && `run=${safe.cronRunId}`];
	const chain = safe.causes.map((cause) => cause.code ?? cause.name ?? 'unknown').join('>');
	if (chain) fields.push(`causes=${chain}`);
	if (safe.causeChainTruncated) fields.push('causeChainTruncated=true');
	return fields.filter(Boolean).join(' ');
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
