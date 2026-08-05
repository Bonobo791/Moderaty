#!/usr/bin/env node
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
//
// Database backup: dumps a Turso database via the turso CLI and writes a
// gzipped SQL dump to a timestamped file. Read-only against the database —
// safe to run against production. Auth comes from the turso CLI login
// (local) or TURSO_API_TOKEN (CI); never from .env, so prod credentials are
// not read by this script.
//
// Usage:
//   node scripts/backup-db.mjs <turso-db-name> [output-dir]
// Example:
//   node scripts/backup-db.mjs moderaty backups

import { execFile } from 'node:child_process';
import { mkdirSync, createWriteStream, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const execFileAsync = promisify(execFile);

// Validate the full argument list BEFORE any work: unknown or extra
// arguments are a loud usage error, never a silent fallthrough.
const argv = process.argv.slice(2);
if (argv.length < 1 || argv.length > 2) {
	console.error('Usage: node scripts/backup-db.mjs <turso-db-name> [output-dir]');
	process.exit(1);
}
const [dbName, outDir = 'backups'] = argv;
// The name is interpolated into a turso CLI argument; only accept the shape
// turso itself allows so a typo cannot smuggle flags or shell syntax.
if (!/^[a-z0-9][a-z0-9-]*$/.test(dbName)) {
	console.error(`Invalid Turso database name "${dbName}" (expected lowercase letters, digits, dashes).`);
	process.exit(1);
}

let dump;
try {
	// 64 MiB buffer: .dump streams the whole database to stdout.
	({ stdout: dump } = await execFileAsync('turso', ['db', 'shell', dbName, '.dump'], {
		maxBuffer: 64 * 1024 * 1024
	}));
} catch (err) {
	console.error(`turso db shell ${dbName} .dump failed: ${err.stderr?.trim() || err.message}`);
	process.exit(1);
}

// Never write an empty or schema-less dump: it would look like a valid
// backup until the day a restore is attempted.
if (!dump.includes('CREATE TABLE')) {
	console.error(`Dump of ${dbName} contains no CREATE TABLE statements — refusing to write a useless backup.`);
	process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${dbName}-${stamp}.sql.gz`);
await pipeline(Readable.from([dump]), createGzip(), createWriteStream(file));

console.log(`Wrote ${file} (${statSync(file).size} bytes gzipped, ${dump.length} bytes SQL).`);
