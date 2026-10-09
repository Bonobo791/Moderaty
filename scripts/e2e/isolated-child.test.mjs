import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('the browser fixture child cannot inherit Node preloads from its parent', () => {
	const cwd = mkdtempSync(join(tmpdir(), 'moderaty-preload-'));
	try {
		const helper = new URL('../../e2e/support/isolated-child.mjs', import.meta.url).href;
		writeFileSync(join(cwd,'preload.mjs'), "if (process.argv[1]?.endsWith('child.mjs')) process.env.PRELOAD_POISON='synthetic-poison';\n");
		writeFileSync(join(cwd,'child.mjs'), 'process.send({execArgv:process.execArgv, poison:process.env.PRELOAD_POISON ?? null});\n');
		writeFileSync(join(cwd,'parent.mjs'), `import {forkIsolated} from ${JSON.stringify(helper)}; const child=forkIsolated('./child.mjs',{env:{},stdio:['ignore','ignore','inherit','ipc']}); child.on('message',m=>process.stdout.write(JSON.stringify(m)));\n`);
		const result = spawnSync(process.execPath, ['--import', './preload.mjs', './parent.mjs'], {cwd, encoding:'utf8'});
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({execArgv:[], poison:null});
	} finally {rmSync(cwd,{recursive:true,force:true});}
});
