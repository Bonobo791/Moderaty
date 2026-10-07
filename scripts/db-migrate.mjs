#!/usr/bin/env node
// Use the same ORM migrator as drizzle-kit without its progress renderer,
// which suppresses rejected migration errors before exiting the process.
import { basename, dirname, resolve } from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { loadMigrationConfig } from './migration-config.mjs';

const { metaDir, url, authToken } = loadMigrationConfig({ scriptName: 'db-migrate' });
let redactions = [authToken, url].filter(Boolean);
let client;
try {
	const parsedUrl = new URL(url);
	redactions = [...redactions, parsedUrl.username, parsedUrl.password,
		decodeURIComponent(parsedUrl.username), decodeURIComponent(parsedUrl.password),
		...parsedUrl.searchParams.getAll('authToken')].filter(Boolean);
	const resolvedMetaDir = resolve(metaDir);
	if (basename(resolvedMetaDir) !== 'meta') {
		throw new Error('migration metadata directory must be named meta — refusing to select a different journal.');
	}
	client = createClient({ url, authToken });
	await migrate(drizzle(client), { migrationsFolder: dirname(resolvedMetaDir) });
	console.log('db-migrate: migrations applied — schema verification must still pass before deployment.');
} catch (error) {
	console.error('db-migrate: migration failed — blocking the deploy.');
	// Include nested driver causes, but never emit configured connection credentials.
	const seen = new Set();
	for (let cause = error; !seen.has(cause); cause = cause.cause) {
		seen.add(cause);
		let message = cause instanceof Error ? cause.message : String(cause);
		for (const secret of redactions) {
			message = message.split(secret).join('[REDACTED]');
		}
		// libsql normalizes connection URLs to https before constructing requests.
		message = message.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s]+@/gi, '$1[REDACTED]@');
		const index = Number.isInteger(cause?.statementIndex) ? ` (batch statement index ${cause.statementIndex})` : '';
		console.error(`  ${message}${index}`);
		if (cause?.cause == null) break;
	}
	process.exitCode = 1;
} finally {
	client?.close();
}
