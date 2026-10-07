import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const run = promisify(execFile);
const script = fileURLToPath(new URL('./test-recovery-confirmation.mjs', import.meta.url));
const shadowPython = '#!/bin/sh\nprintf executed > "$MODERATY_SHADOW_MARKER"\n';

test.each(['PYTHON_BINARY', 'CHROMIUM_BINARY'])('rejects a relative %s before a shadow executable on PATH can run', async (setting) => {
	const folder = mkdtempSync(join(tmpdir(), 'moderaty-shadow-python-'));
	const marker = join(folder, 'executed');
	writeFileSync(join(folder, 'python3'), shadowPython, { mode: 0o700 });
	const env = { ...process.env, PATH: folder, PYTHON_BINARY: '/usr/bin/python3', CHROMIUM_BINARY: '/usr/bin/chromium', MODERATY_SHADOW_MARKER: marker };
	env[setting] = setting === 'PYTHON_BINARY' ? 'python3' : 'chromium';
	try {
		await expect(run(process.execPath, [script], { env })).rejects.toThrow(`${setting} must be an absolute path`);
		expect(existsSync(marker)).toBe(false);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

test('runs the absolute Python override while ignoring a shadow python3 on PATH', async () => {
	const folder = mkdtempSync(join(tmpdir(), 'moderaty-selected-python-'));
	const shadowMarker = join(folder, 'shadow-executed');
	const selectedMarker = join(folder, 'selected-executed');
	const selected = join(folder, 'selected-python');
	writeFileSync(join(folder, 'python3'), shadowPython, { mode: 0o700 });
	writeFileSync(selected, '#!/bin/sh\nprintf "%s" "$4" > "$MODERATY_SELECTED_MARKER"\n', { mode: 0o700 });
	try {
		await run(process.execPath, [script], { env: {
			...process.env, PATH: folder, PYTHON_BINARY: selected, CHROMIUM_BINARY: '/usr/bin/chromium',
			MODERATY_SHADOW_MARKER: shadowMarker, MODERATY_SELECTED_MARKER: selectedMarker
		} });
		expect(existsSync(shadowMarker)).toBe(false);
		expect(readFileSync(selectedMarker, 'utf8')).toBe('/usr/bin/chromium');
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});
