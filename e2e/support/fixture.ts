import { test as base, expect } from '@playwright/test';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type RequestRecord = { url: string; method: string };
export type Snapshot = {
	handles: { channelId: string; handle: string; resolvedChannelId: string | null }[];
	comments: { id: string; status: string; decidedBy: string; authorName: string | null; authorChannelId: string | null }[];
	actions: { commentId: string; action: string; state: string }[];
	audits: { commentId: string; action: string; reason: string; authorHandle: string | null }[];
	requests: RequestRecord[];
	blockedRequests: RequestRecord[];
};
type RunSnapshot = Snapshot & {
	result: { fetched: number; acted: number; queued: number; partial: boolean; skipped: boolean; dryRun: boolean };
};
type App = {
	baseURL: string;
	token: string;
	channelId: string;
	state(): Promise<Snapshot>;
	run(): Promise<RunSnapshot>;
};

export const test = base.extend<{ app: App }>({
	app: async ({}, use, testInfo) => {
		const directory = await mkdtemp(join(tmpdir(), 'moderaty-protected-handle-'));
		// Exercise a developer checkout with dotenv present without touching
		// their real files. Symlinks serve the unchanged application source.
		const project = join(directory, 'project');
		await mkdir(project);
		for (const name of ['src', 'static', 'drizzle', 'node_modules', 'package.json', 'package-lock.json', 'svelte.config.js', 'vite.config.ts', 'tsconfig.json']) {
			await symlink(join(process.cwd(), name), join(project, name));
		}
		for (const name of ['.env', '.env.local', '.env.development', '.env.development.local']) {
			await writeFile(join(project, name), 'MODERATY_DOTENV_POISON=synthetic-poison\nVITE_MODERATY_DOTENV_POISON=synthetic-poison\nDRY_RUN=true\n');
		}
		// Do not inherit credentials, NODE_OPTIONS/preloads or dotenv settings.
		const child = fork(join(import.meta.dirname, 'server.mjs'), [], {
			cwd: project,
			env: { PATH: process.env.PATH, TMPDIR: directory, NODE_ENV: 'development', MODERATY_E2E_DIRECTORY: directory },
			stdio: ['ignore', 'pipe', 'pipe', 'ipc']
		});
		let output = '';
		child.stdout?.on('data', chunk => { output += String(chunk); });
		child.stderr?.on('data', chunk => { output += String(chunk); });
		const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
		let readyResolve: (app: Pick<App, 'baseURL' | 'token' | 'channelId'>) => void;
		let readyReject: (error: Error) => void;
		const ready = new Promise<Pick<App, 'baseURL' | 'token' | 'channelId'>>((resolve, reject) => {
			readyResolve = resolve; readyReject = reject;
		});
		child.on('message', (message: { ready?: boolean; baseURL: string; token: string; channelId: string; id?: string; value?: unknown; error?: string }) => {
			if (message.ready) readyResolve(message);
			else if (message.id) {
				const call = pending.get(message.id);
				pending.delete(message.id);
				if (message.error) call?.reject(new Error(message.error));
				else call?.resolve(message.value);
			}
		});
		const failed = (error: Error) => {
			readyReject(error);
			for (const call of pending.values()) call.reject(error);
			pending.clear();
		};
		child.on('error', failed);
		child.on('exit', code => failed(new Error(`E2E server exited (${code})\n${output}`)));
		const startupTimeout = setTimeout(() => failed(new Error(`E2E startup timed out\n${output}`)), 30_000);
		async function command<T>(command: 'run' | 'state'): Promise<T> {
			const id = randomUUID();
			return new Promise<T>((resolve, reject) => {
				const timer = setTimeout(() => { pending.delete(id); reject(new Error(`E2E ${command} timed out\n${output}`)); }, 20_000);
				pending.set(id, {
					resolve: value => { clearTimeout(timer); resolve(value as T); },
					reject: error => { clearTimeout(timer); reject(error); }
				});
				child.send({ id, command }, error => { if (error) failed(error); });
			});
		}
		try {
			const app = await ready;
			clearTimeout(startupTimeout);
			await use({ ...app, state: () => command<Snapshot>('state'), run: () => command<RunSnapshot>('run') });
		} finally {
			clearTimeout(startupTimeout);
			if (child.exitCode === null && child.signalCode === null) {
				const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
				const killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
				child.kill('SIGTERM');
				await exited;
				clearTimeout(killTimer);
			}
			await testInfo.attach('server-log', { body: output, contentType: 'text/plain' });
			await rm(directory, { recursive: true, force: true });
		}
	}
});
export { expect };
