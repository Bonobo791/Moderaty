#!/usr/bin/env node
import { backup } from './backup-db.mjs';
import { notify } from './backup-lib/alerts.mjs';
import { BackupError, cancellation, reportError } from './backup-lib/common.mjs';
const stop = cancellation(); process.umask(0o077);
try {
	if (process.argv.length !== 3) throw new BackupError('usage', 'Usage: node scripts/run-backup.mjs <turso-db-name>');
	const result = await backup(process.argv[2], '--upload', { signal: stop.signal });
	await notify({ stage: 'recovery', lastVerifiedSuccess: result.startedAt }, { signal: stop.signal });
	console.log(`backup: encrypted remote backup and retention verified (${result.id}).`);
} catch (error) {
	reportError(error);
	// Cancellation still gets a bounded delivery attempt. SIGKILL/runner loss
	// cannot run cleanup or alerts: the independent freshness monitor covers it.
	try { await notify({ stage: error instanceof BackupError && error.stage !== 'alert-delivery' ? error.stage : 'internal' }); }
	catch (alertError) { reportError(alertError); }
} finally { stop.dispose(); }
