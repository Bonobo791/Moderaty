import { BackupError, MAX_BYTES, atStage, requireValue, run } from './common.mjs';

export async function exportDump(database, { env = process.env, signal, fetchImpl = fetch, runTool = run } = {}) {
	// CI uses a pre-existing database-scoped read-only token, never a platform
	// token that lets the CLI silently mint broader database credentials.
	if (env.BACKUP_DATABASE_URL || env.CI || env.GITHUB_ACTIONS) {
		const raw = requireValue(env.BACKUP_DATABASE_URL, 'authentication', 'BACKUP_DATABASE_URL is required for headless backup.');
		const token = requireValue(env.BACKUP_DATABASE_AUTH_TOKEN, 'authentication', 'BACKUP_DATABASE_AUTH_TOKEN is required; configure approved database-scoped access.');
		let url;
		try { url = new URL(raw.replace(/^libsql:/, 'https:')); } catch { throw new BackupError('configuration', 'Invalid backup database URL.'); }
		if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.hostname !== env.BACKUP_EXPECTED_DATABASE_HOST || !url.hostname.endsWith('.turso.io') || !url.hostname.startsWith(`${database}-`)) {
			throw new BackupError('configuration', 'Backup database identity/HTTPS URL does not match the approved host and database.');
		}
		return atStage('export', async () => {
			const response = await fetchImpl(new URL('/dump', url), {
				headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
				signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(120_000)])
			});
			if (!response.ok || !response.body) throw new Error('export rejected');
			const reader = response.body.getReader(); const chunks = []; let size = 0;
			try {
				while (true) {
					const { value, done } = await reader.read(); if (done) break;
					size += value.length; if (size > MAX_BYTES) throw new Error('export too large');
					chunks.push(value);
				}
			} finally { await reader.cancel(); }
			return { dump: Buffer.concat(chunks), tool: 'turso-http-dump-v1' };
		});
	}
	// Local CLI login remains supported; no environment token is required.
	// Capture all output and close stdin, including the authentication probe.
	return atStage('authentication', async () => {
		const version = (await runTool('turso', ['--version'], { env, signal, maxBytes: 4096 })).toString().trim();
		if (!/(?:^|\s)v?1\.0\.31(?:$|\s)/.test(version)) throw new Error('unreviewed CLI');
		const url = (await runTool('turso', ['db', 'show', database, '--http-url'], { env, signal, maxBytes: 4096 })).toString().trim();
		if (!new RegExp(`^https://${database}-[a-z0-9-]+\\.turso\\.io/?$`).test(url)) throw new Error('invalid preflight');
		const dump = await atStage('export', () => runTool('turso', ['db', 'shell', database, '.dump'], { env, signal }));
		return { dump, tool: 'turso-cli-1.0.31-dump' };
	});
}
