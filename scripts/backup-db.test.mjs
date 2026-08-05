// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

// Behavior tests for backup-db.mjs. The real `turso` CLI is replaced by a
// PATH-stubbed fake so the script's own logic — argument validation, dump
// sanity check, gzip output, loud failure — is exercised end to end without
// touching a database. Every test fails if the script's real logic breaks
// (e.g. writing raw SQL instead of gzip, or skipping the sanity check).

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const SCRIPT = new URL('./backup-db.mjs', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'backup-db-test-'));
const binDir = join(tmp, 'bin');
mkdirSync(binDir);

const CANNED_DUMP = 'CREATE TABLE channels (id TEXT PRIMARY KEY);\nINSERT INTO channels VALUES (\'UC1\');\n';

// The fake turso: "db shell good .dump" emits a canned dump, "db shell empty
// .dump" emits nothing, anything else fails like a CLI error would. The dump
// goes through a heredoc so quoting in the canned SQL cannot break the stub.
writeFileSync(
	join(binDir, 'turso'),
	`#!/bin/sh
if [ "$1 $2" = "db shell" ] && [ "$4" = ".dump" ]; then
  if [ "$3" = "good" ]; then
cat <<'MODERATY_DUMP_EOF'
${CANNED_DUMP}MODERATY_DUMP_EOF
    exit 0
  fi
  if [ "$3" = "empty" ]; then exit 0; fi
fi
echo "turso: database not found or unreachable" >&2
exit 1
`,
	{ mode: 0o755 }
);

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function runBackup(args, { stub = true } = {}) {
	return execFileAsync('node', [SCRIPT, ...args], {
		env: { ...process.env, PATH: stub ? `${binDir}:${process.env.PATH}` : process.env.PATH }
	});
}

describe('backup-db.mjs', () => {
	it('rejects missing or extra arguments with a loud usage error', async () => {
		await expect(runBackup([])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Usage:') });
		await expect(runBackup(['a', 'b', 'c'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Usage:') });
	});

	it('rejects a database name that is not lowercase-alnum-dash', async () => {
		await expect(runBackup(['Bad_Name!'])).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining('Invalid Turso database name')
		});
	});

	it('writes a gzipped dump that decompresses to exactly what turso emitted', async () => {
		const outDir = join(tmp, 'out-good');
		const { stdout } = await runBackup(['good', outDir]);
		const [file] = readdirSync(outDir);
		expect(file).toMatch(/^good-\d{8}T\d{6}Z\.sql\.gz$/);
		expect(gunzipSync(readFileSync(join(outDir, file))).toString()).toBe(CANNED_DUMP);
		expect(stdout).toContain('bytes gzipped');
	});

	it('refuses to write a dump with no CREATE TABLE and writes nothing', async () => {
		const outDir = join(tmp, 'out-empty');
		await expect(runBackup(['empty', outDir])).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining('no CREATE TABLE')
		});
		expect(() => readdirSync(outDir)).toThrow();
	});

	it('surfaces a turso CLI failure loudly and writes nothing', async () => {
		const outDir = join(tmp, 'out-missing');
		await expect(runBackup(['missing', outDir])).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining('database not found or unreachable')
		});
		expect(() => readdirSync(outDir)).toThrow();
	});
});
