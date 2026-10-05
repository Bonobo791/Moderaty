import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

// Test-only preload inherited by the helper and npm. Node can launch its
// bundled CLI, but neither process can launch tar or an OS shell.
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
	const original = childProcess[method];
	childProcess[method] = (executable, ...args) => {
		if (method === 'exec' || method === 'execSync' || executable !== process.execPath || args.some(value => value?.shell)) {
			throw Object.assign(new Error('external executables unavailable in install fixture'), { code: 'ENOENT' });
		}
		return original(executable, ...args);
	};
}
syncBuiltinESMExports();
console.error(`install fixture: external tools disabled for ${basename(process.argv[1] ?? 'probe')}`);
