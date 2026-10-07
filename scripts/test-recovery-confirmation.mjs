// Browser regression for recovery confirmation identity during auto-refresh.
// Requires Chromium and Python 3 Playwright; runs only local compiled components.
// Linux defaults: /usr/bin/python3 and /usr/bin/chromium. For other installations,
// set PYTHON_BINARY and CHROMIUM_BINARY to the absolute paths of those executables.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';

const root = fileURLToPath(new URL('../', import.meta.url));
const pythonBinary = process.env.PYTHON_BINARY ?? '/usr/bin/python3';
const chromiumBinary = process.env.CHROMIUM_BINARY ?? '/usr/bin/chromium';
assert.ok(path.isAbsolute(pythonBinary), 'PYTHON_BINARY must be an absolute path');
assert.ok(path.isAbsolute(chromiumBinary), 'CHROMIUM_BINARY must be an absolute path');
const fixture = await mkdtemp(path.join(tmpdir(), 'moderaty-recovery-confirmation-'));
try {
	await build({
		entryPoints: [path.join(root, 'scripts/browser-recovery-fixture/entry.js')], outfile: path.join(fixture, 'browser.js'),
		bundle: true, format: 'iife', platform: 'browser', conditions: ['browser'],
		nodePaths: [path.join(root, 'node_modules')], define: { 'process.env.NODE_ENV': '"development"' },
		plugins: [{ name: 'svelte-browser-fixture', setup(builder) {
			builder.onResolve({ filter: /^\$lib\// }, ({ path: module }) => module === '$lib/auto-refresh.svelte'
				? { path: 'auto-refresh', namespace: 'fixture' }
				: { path: path.join(root, 'src/lib', module.slice(5) + (module === '$lib/relative-time' ? '.ts' : '')) });
			builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function autoRefresh() {}', loader: 'js' }));
			builder.onLoad({ filter: /\.svelte$/ }, async ({ path: filename }) => ({
				contents: compile(await readFile(filename, 'utf8'), { filename, generate: 'client', dev: true }).js.code,
				loader: 'js', resolveDir: path.dirname(filename)
			}));
		} }]
	});
	const result = spawnSync(pythonBinary, ['-c', `
import sys
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 browser = p.chromium.launch(executable_path=sys.argv[2], headless=True, args=['--no-sandbox'])
 try:
  page = browser.new_page()
  page.set_content('<div id="app"></div>')
  page.add_script_tag(path=sys.argv[1])
  result = page.get_attribute('body', 'data-result')
  assert result == 'passed', result
 finally:
  browser.close()
`, path.join(fixture, 'browser.js'), chromiumBinary], { encoding: 'utf8', timeout: 30_000 });
	assert.equal(result.error, undefined, 'Python 3 Playwright and Chromium must be available to run this regression');
	assert.equal(result.status, 0, result.stderr);
	console.log('Recovery confirmation remains attached to the same comment and binding across refresh.');
} finally {
	await rm(fixture, { recursive: true, force: true });
}
