// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Advanced Digital Marketing LTDA
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

const root = new URL('../..', import.meta.url);

test('an empty push diff exits cleanly under set -u', () => {
	const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
	const input = `refs/heads/dev ${head} refs/heads/dev ${head}\n`;
	const result = spawnSync('bash', ['scripts/hooks/pre-push'], {
		cwd: root,
		input,
		encoding: 'utf8',
		env: { ...process.env, CODACY_GATE_OFF: '0' }
	});
	expect(result.status).toBe(0);
	expect(result.stderr).not.toContain('unbound variable');
	expect(result.stdout).toBe('');
});
