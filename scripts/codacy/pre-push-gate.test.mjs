// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { backupCodacyConfig, npmPrefix } from './pre-push-gate.mjs';

const tempDirs = [];

function tempHome() {
	const dir = mkdtempSync(join(tmpdir(), 'codacy-gate-home-'));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('npmPrefix — no npm subprocess, no PATH resolution (S4036)', () => {
	test('prefers NPM_CONFIG_PREFIX', () => {
		expect(npmPrefix({ NPM_CONFIG_PREFIX: '/env/prefix' }, tempHome(), '/bin/node', 'linux')).toBe('/env/prefix');
	});

	test('accepts the lowercase npm_config_prefix form npm sets', () => {
		expect(npmPrefix({ npm_config_prefix: '/lower/prefix' }, tempHome(), '/bin/node', 'linux')).toBe('/lower/prefix');
	});

	test('reads prefix from ~/.npmrc', () => {
		const home = tempHome();
		writeFileSync(join(home, '.npmrc'), 'registry=https://example.com\nprefix=/npmrc/prefix\n');
		expect(npmPrefix({}, home, '/bin/node', 'linux')).toBe('/npmrc/prefix');
	});

	test('derives the prefix from the node installation layout when no config exists', () => {
		expect(npmPrefix({}, tempHome(), '/opt/node/bin/node', 'linux')).toBe('/opt/node');
	});
});


describe('backupCodacyConfig', () => {
	test('restores committed files and removes files the runner generated', () => {
		const root = mkdtempSync(join(tmpdir(), 'codacy-gate-root-'));
		tempDirs.push(root);
		const codacyDir = join(root, '.codacy');
		mkdirSync(codacyDir, { recursive: true });
		// committed before the run:
		writeFileSync(join(codacyDir, 'codacy.config.json'), '{"committed":true}');

		const restore = backupCodacyConfig(root);
		// the runner regenerates the committed file and creates a NEW one:
		writeFileSync(join(codacyDir, 'codacy.config.json'), '{"regenerated":true}');
		writeFileSync(join(codacyDir, 'configure-codacy-summary.json'), '{"generated":true}');

		restore();

		// committed file restored, generated file removed, nothing else created:
		expect(readFileSync(join(codacyDir, 'codacy.config.json'), 'utf8')).toBe('{"committed":true}');
		expect(existsSync(join(codacyDir, 'configure-codacy-summary.json'))).toBe(false);
	});
});
