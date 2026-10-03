#!/usr/bin/env node
// Operator-only tooling. Preview/status never mutate; enqueue never sends.
// Run from a reviewed checkout with explicitly supplied target environment.
import { pathToFileURL } from 'node:url';

export function parseWelcomeArgs(args) {
	const [command = 'preview', ...flags] = args;
	if (['preview', 'status'].includes(command) && flags.length === 0) return { command };
	if (command !== 'enqueue') throw new Error('Usage: welcome-email.mjs [preview|status|enqueue --limit=1..25 --confirm-enqueue [--after=USER_ID]]');
	const allowed = /^(--limit=\d+|--confirm-enqueue|--after=[a-zA-Z0-9_-]+)$/;
	if (flags.some(flag => !allowed.test(flag)) || new Set(flags.map(flag => flag.split('=')[0])).size !== flags.length) throw new Error('Unknown or repeated welcome backfill option');
	const limit = Number(flags.find(flag => flag.startsWith('--limit='))?.slice(8));
	if (!flags.includes('--confirm-enqueue') || !Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('Enqueue requires --confirm-enqueue and --limit=1..25');
	return { command, limit, afterUserId: flags.find(flag => flag.startsWith('--after='))?.slice(8) ?? null };
}

export async function runWelcomeCommand(args) {
	const options = parseWelcomeArgs(args);
	// Vite resolves the same SvelteKit private-env/DB modules used by signup
	// and cron. No duplicated SQL policy or production-only dependency.
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
	catch { console.error('Welcome operation failed. Check command arguments, explicit target environment, deployment guard and applied migration; no SMTP send is performed by this command.'); process.exitCode = 1; }
}
