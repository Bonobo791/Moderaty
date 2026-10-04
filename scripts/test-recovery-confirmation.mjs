// Browser regression for recovery confirmation identity during auto-refresh.
// Requires Chromium and Python Playwright; runs only local compiled components.
// Run with CHROMIUM_BINARY=/usr/bin/chromium node scripts/test-recovery-confirmation.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = await mkdtemp(path.join(tmpdir(), 'moderaty-recovery-confirmation-'));
try {
	await writeFile(path.join(fixture, 'Wrapper.svelte'), `<script>
		import Page from ${JSON.stringify(path.join(root, 'src/routes/(app)/channels/[id]/log/+page.svelte'))};
		let data = $state({ch:{id:'UC1',title:'Ch'},entries:[],nextCursor:null,hasPrev:false,canRecover:true,recovery:[]});
		export function updateRecovery(recovery) {data = {...data,recovery};}
	</script><Page {data} form={null}/>`);
	await writeFile(path.join(fixture, 'entry.js'), `import { mount, flushSync } from 'svelte';
		import Wrapper from './Wrapper.svelte';
		const component = mount(Wrapper,{target:document.getElementById('app')});
		const a = {id:'a',text:'A',restoreIntentId:null};
		const b = {id:'b',text:'B',restoreIntentId:null};
		const update = (rows) => {component.updateRecovery(rows);flushSync();};
		const boxes = () => document.querySelectorAll('input[name=confirmRestore]');
		try {
			update([a,b]);boxes()[0].checked = true;update([b]);
			if (boxes()[0].checked) throw new Error('confirmation transferred to another comment');
			boxes()[0].checked = true;update([{...b,restoreIntentId:8}]);
			if (boxes()[0].checked) throw new Error('confirmation survived a changed binding');
			update([a,b]);boxes()[1].checked = true;update([b,a]);
			if (!boxes()[0].checked || boxes()[1].checked) throw new Error('confirmation did not follow the same comment and binding');
			document.body.dataset.result = 'passed';
		} catch (error) {document.body.dataset.result = error.message;}`);
	await build({
		entryPoints: [path.join(fixture, 'entry.js')], outfile: path.join(fixture, 'browser.js'),
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
	const result = spawnSync('python', ['-c', `
import os, shutil, sys
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_BINARY') or shutil.which('chromium'), headless=True, args=['--no-sandbox'])
 try:
  page = browser.new_page()
  page.set_content('<div id="app"></div>')
  page.add_script_tag(path=sys.argv[1])
  result = page.get_attribute('body', 'data-result')
  assert result == 'passed', result
 finally:
  browser.close()
`, path.join(fixture, 'browser.js')], { encoding: 'utf8', timeout: 30_000 });
	assert.equal(result.error, undefined, 'Python Playwright and Chromium must be available to run this regression');
	assert.equal(result.status, 0, result.stderr);
	console.log('Recovery confirmation remains attached to the same comment and binding across refresh.');
} finally {
	await rm(fixture, { recursive: true, force: true });
}
