import { spawn } from 'node:child_process';

/** Own the regression runner's process group so timeout cleanup includes its local server. */
export function runBrowserProcess(executable, args, { timeoutMs = 180_000 } = {}) {
	if (process.platform === 'win32') throw new Error('Browser regressions require POSIX process groups for timeout cleanup.');
	return new Promise((resolve) => {
		const child = spawn(executable, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = ''; let stderr = ''; let error; let status = null; let signal = null;
		let closed = false; let cleanupComplete = true;
		const finish = () => {
			if (closed && cleanupComplete) { clearTimeout(timer); resolve({ stdout, stderr, error, status, signal }); }
		};
		const terminate = (signal) => {
			try { process.kill(-child.pid, signal); }
			catch (cause) { if (cause.code !== 'ESRCH') error ??= cause; }
		};
		const timer = setTimeout(() => {
			error = Object.assign(new Error('Browser regression timed out.'), { code: 'ETIMEDOUT' });
			cleanupComplete = false; terminate('SIGTERM');
			setTimeout(() => { terminate('SIGKILL'); cleanupComplete = true; finish(); }, 250);
		}, timeoutMs);
		child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
		child.on('error', (cause) => { error = cause; });
		child.on('close', (code, exitSignal) => { closed = true; status = code; signal = exitSignal; finish(); });
	});
}
