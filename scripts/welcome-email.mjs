#!/usr/bin/env node
// Operator-only tooling. Preview/status never mutate; enqueue never sends.
import { pathToFileURL } from 'node:url';
const USAGE = 'Usage: welcome-email.mjs [preview|status|enqueue --limit=1..25 --confirm-enqueue [--after=USER_ID]]';
const INVALID_OPTIONS = 'Unknown or repeated welcome backfill option';
const REQUIRED_OPTIONS = 'Enqueue requires --confirm-enqueue and --limit=1..25';
const FAILURE_GUIDANCE = 'Welcome operation failed; no SMTP send is performed by this command.';
const SAFE_DIAGNOSTICS = new Set([USAGE, INVALID_OPTIONS, REQUIRED_OPTIONS,
	'MODERATY_DEPLOYMENT must be official-hosted or self-hosted',
	'Welcome backfill requires official-hosted deployment', 'Welcome status requires official-hosted deployment',
	'TURSO_DATABASE_URL is required', 'TURSO_AUTH_TOKEN is required for remote databases',
	'Welcome backfill limit must be 1–25']);

function enqueueOptions(flags) {
	const seen = new Set();
	const values = new Map();
	for (const flag of flags) {
		if (!/^(--limit=\d+|--confirm-enqueue|--after=[a-zA-Z0-9_-]+)$/.test(flag)) throw new Error(INVALID_OPTIONS);
		const [key, value] = flag.split('=');
		if (seen.has(key)) throw new Error(INVALID_OPTIONS);
		seen.add(key);
		values.set(key, value);
	}
	const limit = Number(values.get('--limit'));
	if (!seen.has('--confirm-enqueue') || !Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error(REQUIRED_OPTIONS);
	return { command: 'enqueue', limit, afterUserId: values.get('--after') ?? null };
}
export function parseWelcomeArgs(args) {
	const [command = 'preview', ...flags] = args;
	if (['preview', 'status'].includes(command) && flags.length === 0) return { command };
	if (command !== 'enqueue') throw new Error(USAGE);
	return enqueueOptions(flags);
}

/** Fixed categories never echo libSQL URLs, bound SQL or authentication values. */
function databaseDiagnostic(cause) {
	const message = cause instanceof Error ? cause.message : '';
	if (/no such (table|column)/i.test(message)) return 'Database schema is missing: verify migration 0062 on the selected target.';
	const code = cause?.code;
	if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return 'The database is busy; retry this bounded operation after the active transaction finishes.';
	if (code === 'UNAUTHORIZED' || code === 'AUTH_ERROR') return 'The database rejected authentication; verify the selected target credentials without printing them.';
	return null;
}

export function welcomeOperationDiagnostic(cause) {
	const message = cause instanceof Error ? cause.message : '';
	if (SAFE_DIAGNOSTICS.has(message)) return message;
	const chain = [];
	// Drizzle keeps the driver error in .cause; a hard bound handles cycles
	// and avoids retaining an unbounded chain. Prefer the deepest diagnosis.
	for (let current = cause, depth = 0; current && depth < 5; current = current.cause, depth++) chain.push(current);
	for (const current of chain.reverse()) {
		const diagnostic = databaseDiagnostic(current);
		if (diagnostic) return diagnostic;
	}
	return 'The database operation failed; verify target connectivity, authentication and migration state.';
}

export async function runWelcomeCommand(args) {
	const options = parseWelcomeArgs(args);
	// Load the same private-env/DB modules as signup; no duplicated SQL policy.
	const { createServer } = await import('vite');
	const server = await createServer({ logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom' });
	try {
		const queue = await server.ssrLoadModule('/src/lib/server/welcomeEmail.ts');
		if (options.command === 'preview') return await queue.previewWelcomeBackfill();
		if (options.command === 'status') return await queue.welcomeQueueStatus();
		return await queue.backfillWelcomeBatch(options);
	} finally { await server.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try { console.info(JSON.stringify(await runWelcomeCommand(process.argv.slice(2)), null, 2)); }
	catch (cause) { console.error(FAILURE_GUIDANCE, welcomeOperationDiagnostic(cause)); process.exitCode = 1; }
}
