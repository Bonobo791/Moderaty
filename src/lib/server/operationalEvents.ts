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
const CATEGORIES = ['database', 'unexpected', 'client_disconnect', 'not_found', 'unknown'] as const;
const ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RELEASE = /^(?:[0-9a-f]{7,40}|v?\d{1,4}\.\d{1,4}\.\d{1,4})$/;

export type OperationalEvent = {
	type: typeof TYPES[number];
	severity: typeof SEVERITIES[number];
	category: typeof CATEGORIES[number];
	route: string | null;
	requestId: string | undefined;
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

function safePattern(value: unknown, pattern: RegExp): string | null {
	return typeof value === 'string' && pattern.test(value) ? value : null;
}

function validatedEvent(event: OperationalEvent) {
	// Read once before validation: accessors must not change a checked value.
	const { type, severity, category, route, requestId } = event;
	const identity = env;
	const environment = identity.MODERATY_ENVIRONMENT ?? identity.NODE_ENV;
	const release = identity.MODERATY_RELEASE;
	return {
		version: 1,
		type: allowed(type, TYPES, 'unexpected_server_error'),
		severity: allowed(severity, SEVERITIES, 'error'),
		category: allowed(category, CATEGORIES, 'unknown'),
		route: typeof route === 'string' && ROUTES.has(route) ? route : null,
		requestId: safePattern(requestId, UUID),
		environment: allowed(environment, [...ENVIRONMENTS, 'unknown'], 'unknown'),
		release: safePattern(release, RELEASE)
	};
}

/** Fixed schema: never serialize errors, spread callers, or stringify unknown values. */
export function emitOperationalEvent(event: OperationalEvent): void {
	try {
		const record = validatedEvent(event);
		console[record.severity](JSON.stringify(record));
	} catch {
		loggingFailed();
	}
}
