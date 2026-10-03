// Fixed categories preserve operational evidence without logging recipients, SQL or credentials.
export class WelcomePreparationError extends Error {
	constructor(readonly category: 'configuration' | 'invalid_membership') {
		super(`Welcome preparation failed: ${category}`);
	}
}

/** Drizzle wraps driver failures; inspect at most five causes and never echo their text. */
export function welcomeFailureCategory(cause: unknown): string {
	if (cause instanceof WelcomePreparationError) return cause.category;
	for (let current = cause, depth = 0; current && depth < 5; depth++) {
		if (typeof current !== 'object') break;
		const { code, cause: nested } = current as { code?: unknown; cause?: unknown };
		if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return 'database_busy';
		if (code === 'UNAUTHORIZED' || code === 'AUTH_ERROR') return 'database_authentication';
		if (code === 'SQLITE_ERROR') return 'database_schema_or_query';
		current = nested;
	}
	return 'unexpected_preparation_or_persistence';
}
