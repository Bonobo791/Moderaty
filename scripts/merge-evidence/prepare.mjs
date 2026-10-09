import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJson } from './json.mjs';

// Start each action execution without a report or receipt it could mistake for
// new output. No cached artifacts are restored in this workflow.
const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
const manifest = readJson('package.json', 'package.json');
if (manifest.scripts?.test !== 'vitest run') {
	throw new Error('Merge evidence requires the reviewed full test script: vitest run. Test command changes require owner review.');
}
rmSync(resolve(workspace, 'receipt.json'), { force: true });
rmSync('.merge-evidence', { recursive: true, force: true });
mkdirSync('.merge-evidence');
writeFileSync(resolve(workspace, 'merge-evidence-start.txt'), new Date().toISOString());
