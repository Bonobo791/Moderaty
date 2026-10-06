import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { runBrowserProcess } from './browser-process.mjs';

test.skipIf(process.platform === 'win32')('browser timeout terminates the child server as well as its parent', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'moderaty-browser-timeout-'));
	const marker = path.join(directory, 'server-stopped'); const pidFile = path.join(directory, 'server-pid');
	const child = `const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(process.argv[1], 'stopped'); process.exit(0); }); setInterval(() => {}, 100);`;
	const parent = `const { spawn } = require('node:child_process'); const fs = require('node:fs'); const server = spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], { stdio: 'ignore' }); fs.writeFileSync(process.argv[3], String(server.pid)); setInterval(() => {}, 100);`;
	try {
		const result = await runBrowserProcess(process.execPath, ['-e', parent, child, marker, pidFile], { timeoutMs: 1500 });
		expect(result.error?.code).toBe('ETIMEDOUT');
		await expect.poll(async () => { try { await access(marker); return true; } catch { return false; } }, { timeout: 1000 }).toBe(true);
	} finally {
		try { process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGKILL'); } catch { /* Already exited. */ }
		await rm(directory, { recursive: true, force: true });
	}
});

test('returns normal browser process output and exit status', async () => {
	const result = await runBrowserProcess(process.execPath, ['-e', 'process.stdout.write("passed");'], { timeoutMs: 1000 });
	expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stdout).toBe('passed');
});
