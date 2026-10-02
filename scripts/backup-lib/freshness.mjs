import { BackupError } from './common.mjs';
import { completedBackups, verifyObject } from './storage.mjs';

export async function checkFreshness(store, config, { now = new Date(), maxAgeHours = 26 } = {}) {
	if (!Number.isFinite(maxAgeHours) || maxAgeHours < 24 || maxAgeHours > 48) throw new BackupError('configuration', 'Freshness threshold must be between 24 and 48 hours.');
	const { manifests, objects } = await completedBackups(store, config);
	const latest = manifests[0];
	if (!latest) return { stage: 'missing', lastVerifiedSuccess: null };
	// A completion file alone is never evidence of a successful backup.
	await verifyObject(store, `${config.prefix}${latest.id}/payload.sql.gz.age`, latest);
	if (Date.parse(latest.startedAt) > now.getTime() + 60_000 || Date.parse(latest.completedAt) > now.getTime() + 60_000) throw new BackupError('integrity', 'Backup timestamp is in the future.');
	if (manifests.some((m) => now.getTime() - Date.parse(m.startedAt) > 30 * 86_400_000) || objects.some((o) => Number.isFinite(Date.parse(o.LastModified)) && now.getTime() - Date.parse(o.LastModified) > 30 * 86_400_000)) return { stage: 'retention', lastVerifiedSuccess: latest.startedAt };
	return { stage: now.getTime() - Date.parse(latest.startedAt) > maxAgeHours * 3_600_000 ? 'stale' : 'recovery', lastVerifiedSuccess: latest.startedAt };
}

export async function monitorOnce({ prepare, alert, now, maxAgeHours }) {
	let event;
	try {
		const { store, config } = await prepare();
		await store.preflight();
		event = await checkFreshness(store, config, { now, maxAgeHours });
	} catch (error) {
		event = { stage: error instanceof BackupError && ['configuration', 'storage', 'integrity', 'cleanup'].includes(error.stage) ? error.stage : 'internal', lastVerifiedSuccess: null };
	}
	await alert(event);
	return event;
}
