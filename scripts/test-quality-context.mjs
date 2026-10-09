import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
const CONTROL_NAMES = new Set(['package.json', 'package-lock.json']);
const CONTROL_PREFIXES = ['vitest', 'vite.config.', 'playwright.config.', 'stryker', 'tsconfig'];
function isControl(path) {
	const filename = path.split('/').at(-1);
	return path.startsWith('.github/workflows/') || CONTROL_NAMES.has(filename) ||
		CONTROL_PREFIXES.some((prefix) => filename.startsWith(prefix));
}

// This collects review evidence, not a quality verdict. Candidate files are data:
// never imported, checked out, evaluated or passed to a shell.
export function collectContext({ repo = process.cwd(), base, head, maxBytes = 2_000_000 }) {
	if (!SHA.test(base) || !SHA.test(head)) throw new Error('Expected full commit SHA for base and head');
	const git = (...args) => execFileSync('/usr/bin/git', ['--literal-pathspecs', ...args], {
		cwd: repo, encoding: 'utf8', maxBuffer: 8_000_000,
		env: { ...process.env, PATH: '/usr/bin:/bin' }
	});
	git('cat-file', '-e', base + '^{commit}');
	git('cat-file', '-e', head + '^{commit}');
	const mergeBase = git('merge-base', base, head).trim();
	const fields = git('diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', mergeBase, head).split('\0');
	const changed = [];
	for (let i = 0; i < fields.length && fields[i];) {
		const status = fields[i++];
		const previousPath = fields[i++];
		const path = /^[RC]/.test(status) ? fields[i++] : previousPath;
		changed.push({ status, path, previousPath });
	}
	if (changed.length > 500) throw new Error('Review exceeds 500 changed files; split the PR');
	const blob = (ref, path) => {
		const entry = git('ls-tree', '-z', ref, '--', path);
		return entry ? git('show', '--no-ext-diff', '--no-textconv', `${ref}:${path}`) : null;
	};
	const evidence = ({ status, path, previousPath }) => ({
		status, path, previousPath,
		before: blob(mergeBase, previousPath), after: blob(head, path),
		diff: git('diff', '--no-ext-diff', '--no-textconv', mergeBase, head, '--', previousPath, path)
	});
	const tests = changed.filter((file) => TEST.test(file.path) || TEST.test(file.previousPath)).map((file) => {
		const companions = [...new Set([file.path, file.previousPath].map((path) => path.replace(/\.(test|spec)(\.[cm]?[jt]sx?)$/, '$2')))];
		const production = companions.map((path) => ({ path, before: blob(mergeBase, path), after: blob(head, path) }))
			.filter((file) => file.before !== null || file.after !== null);
		return { ...evidence(file), production };
	});
	const controls = changed.filter((file) => isControl(file.path) || isControl(file.previousPath)).map(evidence);
	const productionChanges = changed.filter((file) => /^(src|scripts)\//.test(file.path) && !TEST.test(file.path) && !isControl(file.path)).map(evidence);
	const context = { base, mergeBase, head, changed, tests, controls, productionChanges };
	if (Buffer.byteLength(JSON.stringify(context)) > maxBytes) {
		throw new Error(`Review evidence exceeds ${maxBytes} bytes; split the PR (no evidence was truncated)`);
	}
	return context;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const context = collectContext({ base: process.env.PR_BASE_SHA, head: process.env.PR_HEAD_SHA });
		if (!process.env.SENTINEL_CONTEXT_PATH) throw new Error('SENTINEL_CONTEXT_PATH is required');
		writeFileSync(process.env.SENTINEL_CONTEXT_PATH, JSON.stringify(context, null, 2));
		process.stdout.write(`Collected ${context.tests.length} test files and ${context.controls.length} CI controls for ${context.head}\n`);
	} catch (error) {
		process.stderr.write(`Test Quality Sentinel evidence collection failed: ${error.message}\n`);
		process.exitCode = 1;
	}
}
