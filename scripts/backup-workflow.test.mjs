import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { run } from './backup-lib/common.mjs';
const workflow = readFileSync(new URL('../.github/workflows/db-backup.yml', import.meta.url), 'utf8');

describe('backup trust boundaries', () => {
	it('keeps credentials behind explicit activation and default-branch/environment gates', () => {
		expect(workflow).toContain("vars.BACKUP_PRODUCTION_ENABLED == 'true'");
		expect(workflow).toContain('github.event.repository.default_branch');
		expect(workflow).toContain('environment: production-backups');
		expect(workflow).toContain('contents: read');
		expect(workflow).toContain('cancel-in-progress: false');
		expect(workflow).toContain('timeout-minutes: 20');
		expect(workflow).not.toMatch(/pull_request_target|upload-artifact|actions\/cache|TURSO_API_TOKEN|AGE_SECRET|AGE_IDENTITY/);
		for (const [, reference] of workflow.matchAll(/uses:\s*(\S+)/g)) expect(reference).toMatch(/@[a-f0-9]{40}$/);
	});
	it('cancels subprocesses and suppresses command stderr instead of disclosing source data', async () => {
		await expect(run(process.execPath, ['-e', 'console.error("synthetic private data");process.exit(1)'])).rejects.not.toThrow('synthetic private data');
		await expect(run(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { signal: AbortSignal.timeout(25) })).rejects.toThrow('failed');
	});
	it('bounds process output even when the command exits successfully', async () => {
		await expect(run(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], { maxBytes: 10 })).rejects.toThrow('output limit');
	});
});
