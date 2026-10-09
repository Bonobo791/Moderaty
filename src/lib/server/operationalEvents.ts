import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';

// Fail closed: only framework route templates reviewed here can enter logs.
// Unknown/new routes become null until added; request URLs never enter this API.
const ROUTES = new Set([
	'/',
	'/(app)/account',
	'/(app)/channels/[id]',
	'/(app)/channels/[id]/feedback',
	'/(app)/channels/[id]/log',
	'/(app)/channels/[id]/queue',
	'/(app)/channels/[id]/rules',
	'/(app)/dashboard',
	'/(app)/help',
	'/(app)/org',
	'/(app)/org/switch',
	'/(app)/usage',
	'/(app)/usage/success',
	'/account-deleted',
	'/api/analytics',
	'/api/auth/google',
	'/api/auth/google/callback',
	'/api/auth/google/login',
	'/api/auth/google/login/callback',
	'/api/cron',
	'/api/health',
	'/api/locale',
	'/api/mercadopago/webhook',
	'/api/stripe/webhook',
	'/blogs',
	'/blogs/how-to-deal-with-hate-comments-on-youtube',
	'/blogs/how-to-stop-spam-and-scam-comments-on-youtube',
	'/connect-channel',
	'/consent',
	'/contact',
	'/contact/verify',
	'/dpa',
	'/invite/[token]',
	'/llms.txt',
	'/login',
	'/logout',
	'/pricing',
	'/privacy',
	'/robots.txt',
	'/sitemap.xml',
	'/terms'
]);
const TYPES = ['migration_check_failed', 'session_lookup_failed', 'unexpected_server_error', 'request_disconnected', 'request_not_found'] as const;
const SEVERITIES = ['info', 'warn', 'error'] as const;
const CATEGORIES = ['database', 'deployment', 'integrity', 'unexpected', 'client_disconnect', 'not_found', 'unknown'] as const;
const ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RELEASE = /^(?:[0-9a-f]{7,40}|v?\d{1,4}\.\d{1,4}\.\d{1,4})$/;

export type OperationalEvent = {
	type: typeof TYPES[number];
	severity: typeof SEVERITIES[number];
	category: typeof CATEGORIES[number];
	route: string | null;
	requestId: string | undefined;
	diagnosticError?: unknown;
};

function allowed<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
	return values.find((item) => item === value) ?? fallback;
}

function loggingFailed() {
	try {
		process.stderr.write('operational logging failed\n');
	} catch {
		// A broken stderr must not replace the original request outcome.
	}
}

function safeRequestId(value: unknown): string | null {
	return typeof value === 'string' && UUID.test(value) ? value : null;
}

function safeRelease(value: unknown): string | null {
	return typeof value === 'string' && RELEASE.test(value) ? value : null;
}

// Only fixed built-in names and an opaque grouping key enter the log. Neither
// provider messages, custom names, causes nor stack text are serialized.
function safeDiagnostics(error: unknown) {
	let errorKind = 'unknown';
	let errorFingerprint: string | null = null;
	try {
		const classes = [TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError, AggregateError, Error];
		errorKind = classes.find((kind) => error instanceof kind)?.name ?? 'unknown';
		const stack = error instanceof Error ? error.stack : undefined;
		if (typeof stack === 'string' && stack.length <= 65_536) {
			const frames = stack.split('\n').filter((line) => line.trimStart().startsWith('at ')).slice(0, 8).join('\n');
			if (frames) errorFingerprint = createHash('sha256').update(frames).digest('hex');
		}
	} catch {
		// Hostile accessors/proxies must not prevent the original event.
	}
	return { errorKind, errorFingerprint };
}

function validatedEvent(event: OperationalEvent) {
	// Read once before validation: accessors must not change a checked value.
	const { type, severity, category, route, requestId, diagnosticError } = event;
	const identity = env;
	const environment = identity.MODERATY_ENVIRONMENT ?? identity.NODE_ENV;
	const release = identity.MODERATY_RELEASE;
	return {
		version: 1,
		type: allowed(type, TYPES, 'unexpected_server_error'),
		severity: allowed(severity, SEVERITIES, 'error'),
		category: allowed(category, CATEGORIES, 'unknown'),
		route: typeof route === 'string' && ROUTES.has(route) ? route : null,
		requestId: safeRequestId(requestId),
		environment: allowed(environment, [...ENVIRONMENTS, 'unknown'], 'unknown'),
		release: safeRelease(release),
		...(diagnosticError === undefined ? {} : safeDiagnostics(diagnosticError))
	};
}

/** Fixed schema: never serialize errors, spread callers, or stringify unknown values. */
export function emitOperationalEvent(event: OperationalEvent): void {
	try {
		const record = validatedEvent(event);
		const line = JSON.stringify(record);
		if (record.severity === 'info') console.info(line);
		else if (record.severity === 'warn') console.warn(line);
		else console.error(line);
	} catch {
		loggingFailed();
	}
}
