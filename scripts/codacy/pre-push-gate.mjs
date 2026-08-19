#!/usr/bin/env node
/**
 * Codacy pre-push gate.
 *
 * Runs Codacy local analysis (via the official Codacy MCP server,
 * @codacy/codacy-mcp, spawned over stdio) on the repository, then blocks the
 * push when any *changed* file carries error-level (critical/major) findings.
 *
 * Usage: node pre-push-gate.mjs <repo-root> <changed-file>...
 * Exit 0 = allow push; 1 = block push.
 *
 * Talks plain JSON-RPC 2.0 (newline-delimited) to the MCP server — no SDK
 * dependency, so the hook stays self-contained. Degrades to "allow" (with a
 * warning) when the server is missing or analysis tooling fails, because a
 * broken tool must never brick pushes. Escape hatches: `git push --no-verify`
 * or CODACY_GATE_OFF=1.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, copyFileSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

/**
 * Resolves the npm global prefix WITHOUT spawning npm or resolving anything
 * through PATH (S4036). Source of truth, in order: NPM_CONFIG_PREFIX /
 * npm_config_prefix env, then the user ~/.npmrc `prefix=` line, then the
 * standard Node installation layout (node at <prefix>/bin/node on POSIX,
 * <prefix>/node.exe on Windows).
 *
 * @param env - Environment (defaults to process.env)
 * @param home - Home directory for the .npmrc lookup (defaults to os.homedir())
 * @param execPath - Node executable path (defaults to process.execPath)
 * @param platform - Defaults to process.platform
 * @returns The npm global prefix directory
 */
export function npmPrefix(env = process.env, home = os.homedir(), execPath = process.execPath, platform = process.platform) {
	const fromEnv = env.NPM_CONFIG_PREFIX || env.npm_config_prefix;
	if (fromEnv) return fromEnv;
	try {
		const npmrc = path.join(home, '.npmrc');
		if (existsSync(npmrc)) {
			for (const line of readFileSync(npmrc, 'utf8').split(/\r?\n/)) {
				const m = line.match(/^\s*prefix\s*=\s*(.+?)\s*$/);
				const prefix = m?.[1]?.trim();
				if (prefix) return prefix.replace(/^["']|["']$/g, '');
			}
		}
	} catch { /* fall through to the Node-layout derivation */ }
	return platform === 'win32' ? path.dirname(execPath) : path.dirname(path.dirname(execPath));
}

/**
 * Gate entrypoint.
 *
 * @param argv - [repo-root, changed-file...] (defaults to process.argv.slice(2))
 * @returns {Promise<number>} Exit code
 */
export async function main(argv = process.argv.slice(2)) {
	const ROOT = argv[0];
	const changed = new Set((argv.slice(1) || []).map((f) => f.replace(/^\.\//, '')));
	const log = (...a) => console.error('[codacy-gate]', ...a);

	if (!ROOT || !existsSync(path.join(ROOT, '.git'))) {
		log('no repo root given; skipping gate');
		return 0;
	}
	if (changed.size === 0) {
		log('no changed files; skipping gate');
		return 0;
	}

	// --- resolve the global Codacy MCP server binary -----------------------------
	// S4036: never resolve executables through PATH — no `npm` subprocess.
	// npmPrefix() derives the prefix from env/.npmrc/Node layout, and the
	// server binary is then an absolute path under <prefix>/bin.
	const serverBin = path.join(npmPrefix(), 'bin', 'codacy-mcp-server');
	if (!existsSync(serverBin)) {
		log('@codacy/codacy-mcp is not installed globally; skipping Codacy gate');
		log('  install with: npm install -g @codacy/codacy-mcp');
		return 0;
	}

	// --- optional token from the agent config (keeps analysis cloud-synced) ------
	const env = { ...process.env };
	try {
		const envFile = path.join(os.homedir(), '.prime', 'agent', 'codacy', 'server.env');
		if (existsSync(envFile)) {
			for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
				const m = line.match(/^CODACY_ACCOUNT_TOKEN=(.*)$/);
				const token = m?.[1]?.trim();
				if (token) env.CODACY_ACCOUNT_TOKEN = token.replace(/^["']|["']$/g, '');
			}
		}
	} catch { /* token is optional */ }

	// --- preserve committed .codacy config (the runner regenerates it) -----------
	const codacyDir = path.join(ROOT, '.codacy');
	const configFiles = ['codacy.config.json', 'codacy.config.baseline.json', 'configure-codacy-summary.json'];
	const backupDir = path.join(os.tmpdir(), `codacy-gate-${process.pid}`);
	const backedUp = [];
	mkdirSync(backupDir, { recursive: true });
	for (const name of configFiles) {
		const target = path.join(codacyDir, name);
		if (existsSync(target)) {
			copyFileSync(target, path.join(backupDir, name));
			backedUp.push(name);
		}
	}
	const restoreConfig = () => {
		for (const name of backedUp) {
			try { copyFileSync(path.join(backupDir, name), path.join(codacyDir, name)); } catch { /* ignore */ }
		}
		try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* ignore */ }
	};

	// --- minimal MCP stdio client (JSON-RPC 2.0, newline-delimited) ---------------
	function rpc(rl, id, method, params) {
		return new Promise((resolve, reject) => {
			const onLine = (line) => {
				let msg;
				try { msg = JSON.parse(line); } catch { return; }
				if (msg.id === id) {
					rl.off('line', onLine);
					if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
					else resolve(msg.result);
				}
			};
			rl.on('line', onLine);
			proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		});
	}

	let payload = null;
	let analysisError = null;
	const proc = spawn(serverBin, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
	// The analysis runner streams a lot of per-tool progress to stderr; collapse
	// consecutive repeats so a 40s analysis doesn't bury the gate's verdict.
	let lastLine = null;
	let repeatCount = 0;
	proc.stderr.setEncoding('utf8');
	proc.stderr.on('data', (chunk) => {
		for (const line of chunk.split(/\r?\n/)) {
			if (!line) continue;
			if (line === lastLine) {
				repeatCount += 1;
				continue;
			}
			if (repeatCount > 3) console.error(`   ... (${repeatCount} repeats)`);
			repeatCount = 0;
			lastLine = line;
			console.error(line);
		}
	});
	try {
		const rl = readline.createInterface({ input: proc.stdout });
		await rpc(rl, 1, 'initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'codacy-pre-push-gate', version: '1.0.0' },
		});
		proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
		log('analyzing repository (first run may download tool runtimes) ...');
		const result = await rpc(rl, 2, 'tools/call', {
			name: 'codacy_cli_analyze',
			arguments: { rootPath: ROOT },
		});
		const text = result?.content?.[0]?.text;
		payload = text ? JSON.parse(text) : { success: false, output: 'empty response' };
	} catch (err) {
		analysisError = err;
	} finally {
		try { proc.kill(); } catch { /* ignore */ }
		restoreConfig();
	}
	if (analysisError) {
		log('analysis failed (%s); allowing push (tooling error, not a finding)', analysisError?.message || analysisError);
		return 0;
	}

	if (!payload.success) {
		log('analysis failed: %s; allowing push (tooling error, not a finding)', payload.output || 'unknown');
		return 0;
	}

	const findings = Array.isArray(payload.result) ? payload.result : [];
	const blockers = findings.filter(
		(f) => f && f.level === 'error' && changed.has(String(f.filePath || '').replace(/^\.\//, '')),
	);

	if (blockers.length === 0) {
		log('OK: no error-level Codacy findings in changed files');
		return 0;
	}

	console.error('');
	console.error('Codacy gate: push blocked — %d error-level finding(s) in changed files:', blockers.length);
	for (const f of blockers) {
		const column = f.region?.startColumn ? `:${f.region.startColumn}` : '';
		const at = f.region ? `${f.filePath}:${f.region.startLine ?? '?'}${column}` : f.filePath;
		console.error(`  [${f.tool}] ${f.rule?.name || f.rule?.id || '?'}  ${at}`);
		console.error(`      ${f.message}`);
	}
	console.error('');
	console.error('Fix the findings above (or suppress the pattern in .codacy/), then push again.');
	console.error('Escape hatch: git push --no-verify  (or CODACY_GATE_OFF=1).');
	return 1;
}

// Only run when executed directly, not when imported by tests.
const invokedPath = process.argv[1];
if (invokedPath && resolvePath(invokedPath) === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = await main();
	} catch (cause) {
		console.error('[codacy-gate] fatal:', cause);
		process.exit(1);
	}
}
