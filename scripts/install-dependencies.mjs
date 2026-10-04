import { spawn } from 'node:child_process';
import { posix, resolve, win32 } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

/** Locate the npm CLI bundled with the absolute Node executable, without searching PATH. */
export function npmCliPath(nodeExecutable = process.execPath, platform = process.platform) {
	const paths = platform === 'win32' ? win32 : posix;
	const bundledCli = platform === 'win32'
		? 'node_modules/npm/bin/npm-cli.js'
		: '../lib/node_modules/npm/bin/npm-cli.js';
	return paths.resolve(paths.dirname(nodeExecutable), bundledCli);
}

const npmCli = npmCliPath();
const retryableCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']);
const maxAttempts = 3;

/** Run one locked install and drain stderr before returning the final npm error code. */
export function runNpmCi(start = spawn) {
	return new Promise((finish) => {
		let errorCode;
		let pending = '';
		let error;
		const inspectLine = (line) => {
			const match = /^npm error code (\S+)\s*$/.exec(line);
			if (match) errorCode = match[1];
		};
		const child = start(process.execPath, [
			npmCli, 'ci', '--ignore-scripts',
			'--fetch-retries=5', '--fetch-retry-factor=2',
			'--fetch-retry-mintimeout=10000', '--fetch-retry-maxtimeout=120000',
			'--fetch-timeout=300000'
		], { stdio: ['ignore', 'inherit', 'pipe'] });
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk) => {
			process.stderr.write(chunk);
			const lines = (pending + chunk).split('\n');
			pending = lines.pop();
			lines.forEach(inspectLine);
		});
		child.once('error', (failure) => { error = failure; });
		// close follows exit AND draining the pipes; the final code may arrive last.
		child.once('close', (code, signal) => {
			inspectLine(pending);
			finish({ code, signal, errorCode, error });
		});
	});
}

/** Only network failures from a normally terminated npm process can be retried. */
function isRetryableFailure(result) {
	return !result.error && !result.signal && retryableCodes.has(result.errorCode);
}

/** Describe process failures without treating a missing npm error code as retryable. */
function describeFailure(result) {
	return result.error?.message ?? result.signal ?? result.errorCode ?? `exit ${result.code}`;
}

/** Retry interrupted locked installs at most three times; permanent failures block the build. */
export function installDependencies({ run = runNpmCi, wait = setTimeout, log = console.error } = {}) {
	async function attempt(number) {
		log(`install-dependencies: npm ci attempt ${number}/${maxAttempts}`);
		const result = await run();
		if (result.code === 0 && !result.signal && !result.error) return 0;
		const failure = describeFailure(result);
		if (!isRetryableFailure(result) || number === maxAttempts) {
			log(`install-dependencies: ${failure} — blocking the build after attempt ${number}/${maxAttempts}`);
			return result.code || 1;
		}
		const delay = number * 5_000;
		log(`install-dependencies: ${failure} — retrying the locked install in ${delay / 1_000}s`);
		await wait(delay);
		return attempt(number + 1);
	}
	return attempt(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		process.exitCode = await installDependencies();
	} catch (error) {
		console.error(`install-dependencies: ${error.message} — blocking the build`);
		process.exitCode = 1;
	}
}
