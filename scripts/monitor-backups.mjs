#!/usr/bin/env node
// Run outside the backup scheduler/account with independent read-only access.
import { s3Store, storageConfig } from './backup-lib/storage.mjs';
import { monitorOnce } from './backup-lib/freshness.mjs';
import { notify } from './backup-lib/alerts.mjs';
import { BackupError, cancellation, reportError } from './backup-lib/common.mjs';
const stop = cancellation();
try {
	if (process.argv.length !== 2) throw new BackupError('usage', 'Usage: node scripts/monitor-backups.mjs');
	const event = await monitorOnce({
		prepare: async () => { const config = storageConfig(); return { config, store: s3Store(config, { signal: stop.signal }) }; },
		alert: (event) => notify(event, { signal: stop.signal }),
		maxAgeHours: Number(process.env.BACKUP_MAX_AGE_HOURS ?? 26)
	});
	if (event.stage !== 'recovery') throw new BackupError(event.stage, 'Independent backup check is unhealthy; alert sent.');
	console.log('backup-monitor: durable ciphertext and freshness verified.');
} catch (error) { reportError(error); }
finally { stop.dispose(); }
