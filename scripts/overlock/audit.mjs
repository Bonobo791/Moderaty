import { createHash, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Verify the actual executable dependency before importing it. The action SHA
// pins its shell wrapper; these hashes pin the independently published engine.
const modulePath = process.env.OVERLOCK_MODULE ?? fileURLToPath(new URL('../../.github/overlock/node_modules/overlock/dist/index.js', import.meta.url));
const engineHashes = {
	'index.js': '02383c4075de9b359685889ee3cec6b959a4afd4ff87158888c4d4d89b1676a1',
	'evaluation.js': '8476c19df0c204c0df9eed04b731f019568a5c347e6891144da4d3eba4b68406'
};
for (const [file, hash] of Object.entries(engineHashes)) {
	const actual = createHash('sha256').update(readFileSync(resolve(dirname(modulePath), file))).digest();
	if (!timingSafeEqual(actual, Buffer.from(hash, 'hex'))) {
		throw new Error(`Overlock engine integrity failed: ${file}`);
	}
}
const { analyze, parseDiff, isTestFile } = await import(pathToFileURL(modulePath).href);

const blockingRules = new Set([
	'TEST_SKIPPED_ADDED', 'ASSERTION_WEAKENED', 'ASSERTION_NARROWED',
	'ASSERTION_REMOVED', 'PREDICATE_NARROWED', 'SUITE_SCOPE_NARROWED',
	'TEST_GATE_DISABLED', 'COVERAGE_THRESHOLD_LOWERED'
]);

function makeReport(findings, base, extra = {}) {
	const unique = [...new Map(findings.map((finding) => [finding.id, finding])).values()];
	const counts = { high: 0, medium: 0, low: 0 };
	for (const finding of unique) counts[finding.severity] += 1;
	return {
		schema: 1, ok: counts.high === 0, base, fail_on: 'high', findings: unique,
		counts, suppressed: 0, silenced: 0, allowed: [], ...extra
	};
}

/** Analyze real rule output before any inline or trailer suppression applies. */
export function auditDiff(diff, { base = 'fixture' } = {}) {
	// Upstream recognizes Vite thresholds but not its Vitest include/exclude
	// lists. Alias only patch headers; never import or execute vite.config.ts.
	const alias = '.moderaty-overlock/vitest.config.ts';
	const aliased = diff.replace(/^(diff --git a\/|--- a\/|\+\+\+ b\/)vite\.config\.ts(.*)$/gm, (line) => line.replace(/\bvite\.config\.ts\b/g, alias));
	let produced;
	analyze({ diff: aliased, base, testGlobs: [/\.probe\.mjs$/, /\.pw\.ts$/], onFindings: (findings) => { produced = findings; } });
	if (!Array.isArray(produced)) throw new Error('Overlock did not produce raw findings');
	const findings = produced.map((finding) => ({
		...finding, file: finding.file === alias ? 'vite.config.ts' : finding.file,
		id: finding.id.replace(alias, 'vite.config.ts'),
		severity: blockingRules.has(finding.rule) ? 'high' : finding.severity
	}));
	return makeReport([...findings, ...conditionalSkips(diff)], base);
}

function quotedEnd(source, start) {
	const quote = source[start];
	for (let index = start + 1; index < source.length; index += 1) {
		if (source[index] === '\\') index += 1;
		else if (source[index] === quote) return index + 1;
	}
	return source.length;
}

function nonCodeEnd(source, index) {
	if (source[index] === '"' || source[index] === "'") return quotedEnd(source, index);
	if (source.startsWith('//', index)) {
		const end = source.indexOf('\n', index + 2);
		return end < 0 ? source.length : end + 1;
	}
	if (source.startsWith('/*', index)) {
		const end = source.indexOf('*/', index + 2);
		return end < 0 ? source.length : end + 2;
	}
	return null;
}

function conditionEnd(source, start) {
	let depth = 1;
	let index = start;
	while (index < source.length) {
		const skipped = nonCodeEnd(source, index);
		if (skipped !== null) {
			index = skipped;
			continue;
		}
		const char = source[index];
		// Regex/division and template expressions need a full JS parser.
		// Conservatively review edits through the hunk rather than stop at
		// a possible parenthesis inside an opaque expression.
		if (char === '/' || char === '`') return source.length;
		if (char === '(') depth += 1;
		if (char === ')') depth -= 1;
		index += 1;
		if (depth === 0) return index;
	}
	return source.length;
}

function hunkDeclarations(hunk, omitted) {
	let offset = 0;
	const lines = hunk.lines.filter((line) => line.kind !== omitted).map((line) => {
		const entry = { ...line, start: offset, end: offset + line.text.length };
		offset = entry.end + 1;
		return entry;
	});
	const source = lines.map((line) => line.text).join('\n');
	const declarations = /^[ \t]*(?:it|test|describe|suite)\s*\.\s*(?:skipIf|runIf)\s*\(/gm;
	return [...source.matchAll(declarations)].map((match) => {
		const end = conditionEnd(source, match.index + match[0].length);
		const line = lines.find((entry) => entry.start <= match.index && entry.end >= match.index);
		return { text: source.slice(match.index, end), line: line.newLine ?? line.oldLine };
	});
}

function conditionalHunk(file, hunk) {
	// Compare the condition itself on both sides, including deletion-only edits.
	// Edits to a same-line invocation/body are outside the argument span.
	const before = new Map();
	for (const declaration of hunkDeclarations(hunk, 'add')) {
		before.set(declaration.text, (before.get(declaration.text) ?? 0) + 1);
	}
	const findings = [];
	for (const declaration of hunkDeclarations(hunk, 'del')) {
		const count = before.get(declaration.text) ?? 0;
		if (count > 0) {
			before.set(declaration.text, count - 1);
			continue;
		}
		findings.push({
			id: `TEST_SKIPPED_ADDED:${file}:${declaration.line}`, rule: 'TEST_SKIPPED_ADDED', severity: 'high',
			file, line: declaration.line, message: 'Conditional skip/run declaration or condition changed; test execution depends on this condition.',
			evidence: { after: declaration.text }, fix_hint: 'Run the test unconditionally or obtain a separately reviewed policy change.'
		});
	}
	return findings;
}

function conditionalSkips(diff) {
	return parseDiff(diff).filter((file) => isTestFile(file.path, [/\.probe\.mjs$/]))
		.flatMap((file) => file.hunks.flatMap((hunk) => conditionalHunk(file.path, hunk)));
}

function supplemental(rule, key, message) {
	return {
		id: `${rule}:stryker.config.json:${key}`, rule, severity: 'high',
		file: 'stryker.config.json', line: null, message, evidence: {},
		fix_hint: 'Restore the gate or obtain a separate maintainer policy decision.'
	};
}

function strykerConfig(text) {
	if (text === null) return {};
	let value;
	try { value = JSON.parse(text); } catch { throw new Error('Stryker config is not valid JSON'); }
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Stryker config must be an object');
	if (value.thresholds !== undefined) {
		if (!value.thresholds || typeof value.thresholds !== 'object' || Array.isArray(value.thresholds)) throw new Error('Stryker thresholds must be an object');
		for (const [key, number] of Object.entries(value.thresholds)) {
			if (!['high', 'low', 'break'].includes(key) || !Number.isFinite(number) || number < 0 || number > 100) throw new Error(`Invalid Stryker threshold: ${key}`);
		}
	}
	if (value.mutate !== undefined && (!Array.isArray(value.mutate) || value.mutate.some((pattern) => typeof pattern !== 'string'))) {
		throw new Error('Stryker mutate must be an array of strings for this audit');
	}
	return value;
}

/** JSON-level comparisons cover the config path upstream does not recognize. */
export function inspectStryker(beforeText, afterText) {
	const before = strykerConfig(beforeText);
	const after = strykerConfig(afterText);
	const findings = [];
	for (const [key, old] of Object.entries(before.thresholds ?? {})) {
		const next = after.thresholds?.[key];
		if (next === undefined || next < old) findings.push(supplemental('COVERAGE_THRESHOLD_LOWERED', key, `Stryker ${key} changed from ${old} to ${next ?? 'absent'}.`));
	}
	if (before.mutate !== undefined && after.mutate === undefined) {
		findings.push(supplemental('SUITE_SCOPE_NARROWED', 'mutate', 'Explicit Stryker mutation scope was removed; review the resulting defaults or missing gate.'));
	}
	if (after.mutate !== undefined) {
		const old = before.mutate ?? [];
		const removed = old.filter((pattern) => !pattern.startsWith('!') && !after.mutate.includes(pattern));
		const excluded = after.mutate.filter((pattern) => pattern.startsWith('!') && !old.includes(pattern));
		if (before.mutate === undefined || removed.length || excluded.length) {
			findings.push(supplemental('SUITE_SCOPE_NARROWED', 'mutate', 'Stryker mutation scope was introduced, replaced, or given more exclusions; review the collected set.'));
		}
	}
	return findings;
}

function git(cwd, args) {
	// The supported Ubuntu runner supplies this OS-owned executable. Do not
	// resolve a candidate-controlled executable from PATH or the working tree.
	return execFileSync('/usr/bin/git', ['-c', 'core.fsmonitor=false', ...args], {
		cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
	});
}

function configAt(cwd, revision, path) {
	// Look up the tree first so only an absent file is optional. A failed read,
	// symlink, submodule or changed object type must not silently skip the check.
	const entry = git(cwd, ['ls-tree', revision, '--', path]);
	if (entry === '') return null;
	if (!entry.startsWith('100644 blob ') && !entry.startsWith('100755 blob ')) throw new Error(`Unsupported config object: ${path}`);
	return git(cwd, ['show', `${revision}:${path}`]);
}

/** Read immutable git objects only: no npm scripts, test execution or config imports. */
export function auditRepository({ cwd = process.cwd(), base }) {
	if (!/^[a-f0-9]{40}$/.test(base ?? '')) throw new Error('Audit base must be a 40-character commit SHA');
	const head = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
	const fork = git(cwd, ['merge-base', base, head]).trim();
	const diff = git(cwd, ['diff', '--text', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=80', fork, head, '--']);
	if (diff === '') throw new Error('Audit diff is empty; no clean verdict was produced');
	const report = auditDiff(diff, { base: fork });
	const extra = inspectStryker(configAt(cwd, fork, 'stryker.config.json'), configAt(cwd, head, 'stryker.config.json'));
	const files = git(cwd, ['diff', '--name-only', '-z', fork, head, '--']).split('\0').filter(Boolean).length;
	const commits = Number(git(cwd, ['rev-list', '--count', `${fork}..${head}`]));
	return makeReport([...report.findings, ...extra], fork, {
		head, requested_base: base, patch_sha256: createHash('sha256').update(diff).digest('hex'),
		scope: { files, commits }, engine_version: '0.10.4', policy: 'moderaty-overlock-v1'
	});
}

function cli(args) {
	// The pinned composite action calls `config`, then `check` twice (JSON and
	// human output). Its PR-body allow-file and severity arguments are deliberately
	// ignored: the repository's CI policy above governs all three invocations.
	const values = new Set(['--base', '--fail-on', '--severity', '--allow-file']);
	const flags = new Set(['--json', '--no-ledger', '--explain-base']);
	const command = args[0];
	if (!['check', 'config'].includes(command)) throw new Error('Expected check or config');
	let base;
	for (let i = 1; i < args.length; i += 1) {
		if (values.has(args[i])) {
			const flag = args[i];
			const value = args[++i];
			if (value === undefined) throw new Error(`Missing argument: ${flag}`);
			if (flag === '--base') base = value;
		} else if (!flags.has(args[i])) throw new Error(`Unknown audit argument: ${args[i]}`);
	}
	if (command === 'config') {
		process.stdout.write('Moderaty fixed audit policy: high gate; raw unsuppressed findings; no repository config, PR allowances, ledger, or evaluation writes.\n');
		return 0;
	}
	const report = auditRepository({ base });
	if (args.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	else {
		process.stdout.write(`Overlock: ${report.scope.files} files, ${report.scope.commits} commits, base ${report.base}, head ${report.head}\n`);
		for (const finding of report.findings) {
			const text = `${finding.severity} ${finding.rule} ${finding.file}:${finding.line ?? '-'} ${finding.message}`;
			process.stdout.write(`${text.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 1000)}\n`);
		}
		process.stdout.write(report.ok ? 'No blocking findings; medium/low findings still require review.\n' : 'Blocking test-integrity findings.\n');
	}
	return report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { process.exitCode = cli(process.argv.slice(2)); }
	catch (error) { console.error(`Overlock audit failed: ${error.message}`); process.exitCode = 2; }
}
