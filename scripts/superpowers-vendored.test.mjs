import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveSkillDirectory } from '../.agents/superpowers/skills/writing-skills/render-graphs.js';

test('graph renderer rejects skill directories outside the vendored skills root', () => {
	expect(() => resolveSkillDirectory('/tmp/untrusted-skill')).toThrow(/vendored skill/);
});


test('polluter helper uses Bash conditional syntax for its guards', () => {
	const script = readFileSync(
		fileURLToPath(new URL('../.agents/superpowers/skills/systematic-debugging/find-polluter.sh', import.meta.url)),
		'utf8'
	);
	expect(script).toContain('if [[ $# -ne 2 ]]');
	expect(script).toContain('if [[ -z "$TEST_FILES" ]]');
	expect(script).toContain('if [[ -e "$POLLUTION_CHECK" ]]');
});
