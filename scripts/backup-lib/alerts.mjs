import { BackupError, safeId } from './common.mjs';

export async function notify(event, { env = process.env, fetchImpl = fetch, signal } = {}) {
	let url;
	try { url = new URL(env.BACKUP_ALERT_WEBHOOK_URL); } catch { throw new BackupError('alert-delivery', 'Approved alert webhook is missing. Use the independent escalation channel.'); }
	if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new BackupError('alert-delivery', 'Alert webhook must use HTTPS.');
	const scope = safeId(env.BACKUP_SCOPE, 'backup scope');
	const allowed = ['authentication', 'configuration', 'export', 'validation', 'encryption', 'storage', 'integrity', 'retention', 'cleanup', 'stale', 'missing', 'recovery', 'internal'];
	if (!allowed.includes(event.stage)) throw new BackupError('alert-delivery', 'Invalid alert stage.');
	const payload = {
		service: 'moderaty-backup', scope, stage: event.stage,
		deduplicationKey: `moderaty-backup:${scope}:${event.stage}`,
		lastVerifiedSuccess: event.lastVerifiedSuccess ?? null,
		runbook: 'docs/BACKUP_RECOVERY.md',
		...(env.GITHUB_REPOSITORY && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY) && /^\d+$/.test(env.GITHUB_RUN_ID ?? '') ? { run: `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` } : {})
	};
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const response = await fetchImpl(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(10_000)]) });
			await response.body?.cancel();
			if (response.ok) return;
		} catch { /* bounded retry; never print URL, response or exception */ }
		if (signal?.aborted) break;
	}
	throw new BackupError('alert-delivery', 'Alert delivery failed after three attempts. Escalate through the independent operator channel.');
}
