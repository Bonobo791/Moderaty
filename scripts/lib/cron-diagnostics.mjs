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
	if (cause.code === 'EAI_AGAIN' || cause.code === 'ENOTFOUND' || cause.code === 'EDNS') return 'dns';
	if (/^SQLITE_(BUSY|LOCKED)/.test(cause.code ?? '')) return 'database_busy';
	if (['UNAUTHORIZED', 'AUTH_ERROR', 'EAUTH'].includes(cause.code ?? '')) return 'authentication';
	if (cause.code === 'ETIMEDOUT' || /TIMEOUT/.test(cause.code ?? '') || cause.name === 'AbortError' || cause.name === 'TimeoutError') return 'timeout';
	if (cause.httpStatus) return 'http';
	if (cause.code?.startsWith('SQLITE_')) return 'database';
	if (cause.code || cause.name === 'NetworkError') return 'network';
	return 'unknown';
}

/** Select fixed classifications from text, never return text. @param {unknown} value @returns {SafeCause} */
function safeCause(value) {
	const message = field(value, 'message');
	const text = typeof message === 'string' ? message.slice(0, 2048) : '';
	// Stripe's SDK uses name="Error" and a specific type; retain that type.
	const name = allowed(NAMES, field(value, 'type')) ?? allowed(NAMES, field(value, 'name'));
	const code = allowed(CODES, field(value, 'code'));
	const status = httpStatus(field(value, 'httpStatus')) ?? httpStatus(field(value, 'status')) ?? httpStatus(field(value, 'statusCode')) ?? httpStatus(field(field(value, 'response'), 'status'))
		// Existing provider helpers encode the status after "failed:". Only
		// that numeric field is recovered; all body text remains private.
		?? httpStatus(Number(/\bfailed: ([45]\d{2})\b/.exec(text)?.[1]));
	const provider = allowed(PROVIDERS, field(value, 'provider'))
		?? (code?.startsWith('SQLITE_') || name === 'LibsqlError' ? 'turso' : undefined)
		?? (/^Stripe/.test(name ?? '') ? 'stripe' : undefined)
		?? (/^OpenAI\b/i.test(text) ? 'openai' : undefined);
	const service = allowed(SERVICES, field(value, 'service'))
		?? (provider === 'turso' ? 'database' : provider === 'stripe' ? 'payments' : provider === 'openai' ? 'ai' : undefined);
	const safe = { name, code, syscall: allowed(SYSCALLS, field(value, 'syscall')), httpStatus: status, provider, service, category: 'unknown' };
	safe.category = category(safe);
	// Recognized message-only transport errors still get a fixed category.
	if (safe.category === 'unknown' && /^fetch failed\b/.test(text)) safe.category = 'network';
	if (safe.category === 'unknown' && text === 'request deadline exceeded') safe.category = 'timeout';
	return safe;
}

/** @param {unknown} cause @param {string} label @param {string} [cronRunId] @returns {CronFailure} */
export function describeCronFailure(cause, label, cronRunId) {
	const context = Object.hasOwn(CONTEXTS, label) ? CONTEXTS[label] : CONTEXTS['cron transport'];
	/** @type {SafeCause[]} */
	const causes = [];
	const seen = new Set();
	let current = cause;
	let operation = context.operation;
	let operationContext;
	while (current !== undefined && current !== null && !seen.has(current) && causes.length < MAX_CAUSES) {
		seen.add(current);
		causes.push(safeCause(current));
		const annotated = field(current, 'diagnosticOperation');
		if (typeof annotated === 'string' && Object.hasOwn(OPERATIONS, annotated)) {
			operation = annotated;
			operationContext = OPERATIONS[annotated];
		}
		current = field(current, 'cause');
	}
	const root = causes.findLast((item) => item.category !== 'unknown') ?? causes.at(-1) ?? { category: 'unknown' };
	return { ...root, sweep: context.sweep, operation, cronRunId: runId(cronRunId),
		provider: root.provider ?? causes.findLast((item) => item.provider)?.provider ?? operationContext?.provider ?? context.provider,
		service: root.service ?? causes.findLast((item) => item.service)?.service ?? operationContext?.service ?? context.service, causes,
		...(current !== undefined && current !== null ? { causeChainTruncated: true } : {}) };
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
