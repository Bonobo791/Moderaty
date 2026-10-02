import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export const MAX_BYTES = 64 * 1024 * 1024;
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export class BackupError extends Error {
	constructor(stage, message) { super(message); this.stage = stage; }
}
export function requireValue(value, stage, message) {
	if (!value) throw new BackupError(stage, message);
	return value;
}
export function safeId(value, label = 'identifier') {
	if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) {
		throw new BackupError('configuration', `Invalid ${label}; use lowercase letters, digits and dashes.`);
	}
	return value;
}
// Child output is untrusted: never include it or the command arguments in errors.
// stdin is always closed, so a missing login cannot become an interactive prompt.
export function run(command, args, { input, env = process.env, signal, timeout = 120_000, maxBytes = MAX_BYTES } = {}) {
	return new Promise((resolve, reject) => {
		let child;
		try { child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], signal, timeout, killSignal: 'SIGKILL' }); }
		catch { reject(new BackupError('tool', 'Required tool could not start. Check installation and permissions.')); return; }
		const chunks = []; let size = 0; let overflow = false;
		child.stdout.on('data', (chunk) => {
			size += chunk.length;
			if (size > maxBytes) { overflow = true; child.kill('SIGKILL'); }
			else chunks.push(chunk);
		});
		child.stderr.on('data', () => {});
		child.stdin.on('error', () => {});
		child.on('error', () => reject(new BackupError('tool', 'Required tool failed or was cancelled.')));
		child.on('close', (code) => {
			if (code !== 0 || overflow) reject(new BackupError('tool', 'Required tool failed, timed out, or exceeded its output limit.'));
			else resolve(Buffer.concat(chunks));
		});
		child.stdin.end(input);
	});
}
export async function atStage(stage, action) {
	try { return await action(); }
	catch { throw new BackupError(stage, `${stage} failed. Check the runbook and scoped configuration; source output is suppressed.`); }
}
export function cancellation() {
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once('SIGTERM', stop); process.once('SIGINT', stop);
	return { signal: controller.signal, dispose() { process.off('SIGTERM', stop); process.off('SIGINT', stop); } };
}
export function reportError(error) {
	const safe = error instanceof BackupError ? error : new BackupError('internal', 'Backup operation failed; source output is suppressed.');
	console.error(`backup: ${safe.stage}: ${safe.message}`);
	process.exitCode = 1;
}
