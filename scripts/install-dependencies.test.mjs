import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { installDependencies, runNpmCi } from './install-dependencies.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const helper = join(root, 'scripts/install-dependencies.mjs');

async function fixture(resetCount = 1) {
	const directory = await mkdtemp(join(tmpdir(), 'moderaty-install-'));
	const archiveRoot = join(directory, 'archive');
	await mkdir(join(archiveRoot, 'package'), { recursive: true });
	const dependency = { name: 'stream-reset-fixture', version: '1.0.0', scripts: { install: "node -e \"require('node:fs').writeFileSync('lifecycle-ran', 'unsafe')\"" } };
	await writeFile(join(archiveRoot, 'package/package.json'), JSON.stringify(dependency));
	await writeFile(join(archiveRoot, 'package/index.js'), 'module.exports = 42;\n');
	const archive = join(directory, 'fixture.tgz');
	execFileSync('/usr/bin/tar', ['-czf', archive, '-C', archiveRoot, 'package']);
	const body = await readFile(archive);
	let requests = 0;
	const server = createServer((request, response) => {
		if (request.url !== '/fixture.tgz') { response.writeHead(404); response.end(); return; }
		requests++;
		response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
		if (requests <= resetCount) {
			response.write(body.subarray(0, 30));
			setTimeout(() => response.destroy(), 30);
		} else response.end(body);
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const project = join(directory, 'project');
	await mkdir(join(project, 'scripts'), { recursive: true });
	if (existsSync(helper)) await copyFile(helper, join(project, 'scripts/install-dependencies.mjs'));
	const metadata = { name: 'fixture-project', version: '1.0.0', dependencies: { 'stream-reset-fixture': '1.0.0' }, scripts: { prepare: "node -e \"require('node:fs').writeFileSync('root-lifecycle-ran', 'unsafe')\"" } };
	await writeFile(join(project, 'package.json'), JSON.stringify(metadata));
	await writeFile(join(project, 'package-lock.json'), JSON.stringify({ name: metadata.name, version: metadata.version, lockfileVersion: 3, requires: true, packages: {
		'': metadata,
		'node_modules/stream-reset-fixture': { version: '1.0.0', resolved: `http://127.0.0.1:${server.address().port}/fixture.tgz`, integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`, hasInstallScript: true }
	} }));
	return {
		project,
		get requests() { return requests; },
		env: { ...process.env, npm_config_cache: join(directory, 'cache'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' },
		close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
	};
}

async function runDockerInstall(context) {
	const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
	const firstRun = dockerfile.match(/^RUN ((?:[^\n]*\\\n)*[^\n]*)/m);
	if (!firstRun) throw new Error('Dockerfile has no dependency install RUN');
	const command = firstRun[1].replace(/\\\n/g, ' ').replace(/^--mount=\S+\s*/, '').trim();
	let output = '';
	const child = spawn('/bin/sh', ['-c', command], { cwd: context.project, env: context.env, timeout: 30_000 });
	child.stdout.on('data', chunk => output += chunk);
	child.stderr.on('data', chunk => output += chunk);
	const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
	return { code, output };
}

test('the actual Docker install automatically recovers an interrupted tarball without running lifecycle scripts', async () => {
	const context = await fixture();
	try {
		const result = await runDockerInstall(context);
		expect(result.code, result.output).toBe(0);
		expect(context.requests).toBe(2);
		expect(await readFile(join(context.project, 'node_modules/stream-reset-fixture/index.js'), 'utf8')).toBe('module.exports = 42;\n');
		expect(existsSync(join(context.project, 'root-lifecycle-ran'))).toBe(false);
		expect(existsSync(join(context.project, 'node_modules/stream-reset-fixture/lifecycle-ran'))).toBe(false);
		expect(result.output).toMatch(/ECONNRESET/);
	} finally { await context.close(); }
}, 35_000);

test('a missing lockfile fails immediately without retrying the install', async () => {
	const context = await fixture(0);
	try {
		await rm(join(context.project, 'package-lock.json'));
		const result = await runDockerInstall(context);
		expect(result.code).not.toBe(0);
		expect(result.output).toMatch(/npm error code EUSAGE/);
		expect(result.output).not.toMatch(/retrying|attempt 2/i);
		expect(context.requests).toBe(0);
	} finally { await context.close(); }
}, 35_000);

test('persistent interrupted downloads stop after three complete installs', async () => {
	const context = await fixture(Infinity);
	try {
		const result = await runDockerInstall(context);
		expect(result.code).not.toBe(0);
		expect(context.requests).toBe(3);
		expect(result.output).toMatch(/blocking the build after attempt 3\/3/);
		expect(result.output).not.toMatch(/attempt 4/);
		expect(existsSync(join(context.project, 'root-lifecycle-ran'))).toBe(false);
	} finally { await context.close(); }
}, 35_000);

test.each(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'])('retries %s with bounded backoff', async (errorCode) => {
	const run = vi.fn().mockResolvedValueOnce({ code: 1, errorCode }).mockResolvedValueOnce({ code: 1, errorCode }).mockResolvedValueOnce({ code: 0 });
	const wait = vi.fn().mockResolvedValue(undefined);
	const log = vi.fn();
	expect(await installDependencies({ run, wait, log })).toBe(0);
	expect(run).toHaveBeenCalledTimes(3);
	expect(wait.mock.calls).toEqual([[5_000], [10_000]]);
	expect(log).toHaveBeenCalledWith(expect.stringContaining(`${errorCode} — retrying`));
});

test.each([
	{ code: 1, errorCode: 'EUSAGE' },
	{ code: 1, errorCode: 'EINTEGRITY' },
	{ code: 1, errorCode: 'E401' },
	{ code: 1, errorCode: 'ENOSPC' },
	{ code: 1 },
	{ code: null, signal: 'SIGTERM', errorCode: 'ECONNRESET' },
	{ code: null, error: new Error('could not spawn npm'), errorCode: 'ECONNRESET' }
])('does not retry a permanent, unknown, signaled, or spawn failure: %o', async (failure) => {
	const run = vi.fn().mockResolvedValue(failure);
	const wait = vi.fn();
	const log = vi.fn();
	expect(await installDependencies({ run, wait, log })).not.toBe(0);
	expect(run).toHaveBeenCalledTimes(1);
	expect(wait).not.toHaveBeenCalled();
	expect(log).toHaveBeenCalledWith(expect.stringContaining('blocking the build'));
});

test('drains split stderr lines after exit and uses the final npm code without a trailing newline', async () => {
	const child = new EventEmitter();
	child.stderr = new PassThrough();
	const start = vi.fn().mockReturnValue(child);
	const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	try {
		const result = runNpmCi(start);
		child.stderr.write('npm error co');
		child.stderr.write('de ECONNRESET\r\n');
		child.emit('exit', 1, null);
		child.stderr.write('npm error code EU');
		child.stderr.write('SAGE');
		child.emit('close', 1, null);
		expect(await result).toEqual({ code: 1, signal: null, errorCode: 'EUSAGE', error: undefined });
		const [executable, args] = start.mock.calls[0];
		expect(executable).toBe(process.execPath);
		expect(isAbsolute(args[0])).toBe(true);
		expect(args.slice(1)).toEqual(['ci', '--ignore-scripts', '--fetch-retries=5', '--fetch-retry-factor=2', '--fetch-retry-mintimeout=10000', '--fetch-retry-maxtimeout=120000', '--fetch-timeout=300000']);
		expect(output).toHaveBeenCalledTimes(4);
	} finally { output.mockRestore(); }
});
