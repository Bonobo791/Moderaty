// Test-only launcher: no production route or authentication bypass is added.
import { createServer } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import appConfig from '../../svelte.config.js';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { authorChannels, banKeyword, channelId, commentPage } from './youtube-fixtures.mjs';

if (!process.send || !process.env.MODERATY_E2E_DIRECTORY) throw new Error('Launch only through the Playwright fixture');
const root = process.cwd();
// Vite and SvelteKit load dotenv independently. Disable Vite dotenv and
// point SvelteKit at a fresh, empty directory, preserving the app config.
const isolatedEnvDirectory = join(resolve(process.env.MODERATY_E2E_DIRECTORY), 'empty-env');
await mkdir(isolatedEnvDirectory);
const databaseUrl = `file:${join(resolve(process.env.MODERATY_E2E_DIRECTORY), 'disposable.db')}`;
Object.assign(process.env, {
	TURSO_DATABASE_URL: databaseUrl, DRY_RUN: 'false',
	ENCRYPTION_KEY: randomBytes(32).toString('hex'),
	GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: randomBytes(32).toString('hex'),
	OPENAI_API_KEY: `synthetic-${randomBytes(32).toString('hex')}`
});

const requests = [];
const blockedRequests = [];
// Replace only the external HTTP boundary. Real YouTube parsing, allowlist
// reads, rules, transactions and enforcement all execute unchanged.
globalThis.fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
	requests.push({ url: url.href, method });
	if (url.href === 'https://oauth2.googleapis.com/token' && method === 'POST') {
		return Response.json({ access_token: 'synthetic-access-token', expires_in: 3600 });
	}
	if (url.origin === 'https://www.googleapis.com' && method === 'GET') {
		if (url.pathname === '/youtube/v3/commentThreads' && url.searchParams.get('allThreadsRelatedToChannelId') === channelId) {
			return Response.json(commentPage());
		}
		if (url.pathname === '/youtube/v3/channels' && url.searchParams.get('part') === 'snippet') {
			const ids = url.searchParams.get('id')?.split(',') ?? [];
			return Response.json({items:authorChannels.items.filter(item => ids.includes(item.id))});
		}
		if (url.pathname === '/youtube/v3/comments' && url.searchParams.get('part') === 'snippet') {
			const ids = url.searchParams.get('id')?.split(',') ?? [];
			return Response.json({items:commentPage().items.map(item => item.snippet.topLevelComment).filter(item => ids.includes(item.id))});
		}
		if (url.pathname === '/youtube/v3/channels' && url.searchParams.get('part') === 'id' && url.searchParams.get('forHandle')) {
			const handle = url.searchParams.get('forHandle').replace(/^@/, '').toLowerCase();
			return Response.json({ items: authorChannels.items.filter((item) => item.snippet.customUrl.slice(1).toLowerCase() === handle).map(({ id }) => ({ id })) });
		}
	}
	if (url.origin === 'https://www.googleapis.com' && url.pathname === '/youtube/v3/comments/setModerationStatus' && method === 'POST') {
		const ids = (url.searchParams.get('id') ?? '').split(',');
		if (ids.length && ids.every(id => ['protected-comment', 'control-comment'].includes(id))) {
			return new Response(null, { status: 204 });
		}
	}
	blockedRequests.push({ url: url.href, method });
	throw new Error(`E2E blocked unexpected external request: ${method} ${url.origin}${url.pathname}`);
};

const client = createClient({ url: databaseUrl });
await client.executeMultiple(await readFile(new URL('./legacy-base-schema.sql', import.meta.url), 'utf8'));
await migrate(drizzle(client), { migrationsFolder: join(root, 'drizzle') });
const journal = JSON.parse(await readFile(join(root, 'drizzle/meta/_journal.json'), 'utf8'));
const applied = await client.execute('SELECT COUNT(*) AS n FROM __drizzle_migrations');
if (Number(applied.rows[0].n) !== journal.entries.length) throw new Error('Disposable database migration verification failed');
client.close();

const { kit: kitConfig, ...svelteConfig } = appConfig;
const vite = await createServer({
	configFile: false,
	envDir: false,
	plugins: [sveltekit({ ...svelteConfig, ...kitConfig, env: { ...kitConfig.env, dir: isolatedEnvDirectory } })],
	server: {
		fs: { allow: [root, await realpath(join(root, 'src')), await realpath(join(root, 'node_modules'))] },
		host: '127.0.0.1', port: 0, strictPort: false,
		watch: { ignored: ['**/reports/**'] }
	}
});
await vite.listen();
const { env: privateEnv } = await vite.ssrLoadModule('$env/dynamic/private');
if (privateEnv.MODERATY_DOTENV_POISON || vite.config.env.VITE_MODERATY_DOTENV_POISON || privateEnv.TURSO_DATABASE_URL !== databaseUrl) {
	throw new Error('E2E dotenv isolation failed');
}
const { db } = await vite.ssrLoadModule('/src/lib/server/db/index.ts');
const schema = await vite.ssrLoadModule('/src/lib/server/db/schema.ts');
const { encrypt } = await vite.ssrLoadModule('/src/lib/server/crypto.ts');
const { createSession } = await vite.ssrLoadModule('/src/lib/server/session.ts');
const { LEGAL_VERSION, CONSENT_CHECKBOX_TEXT } = await vite.ssrLoadModule('/src/lib/server/legal.ts');
await db.insert(schema.users).values({ id: 'synthetic-owner', googleSub: 'synthetic-sub', email: 'owner@example.invalid', displayName: 'Synthetic Owner' });
await db.insert(schema.organizations).values({ id: 'synthetic-org', name: 'Synthetic Org', personalFor: 'synthetic-owner' });
await db.insert(schema.memberships).values({ userId: 'synthetic-owner', orgId: 'synthetic-org', role: 'owner' });
await db.insert(schema.consents).values({ userId: 'synthetic-owner', docVersion: LEGAL_VERSION, checkboxText: CONSENT_CHECKBOX_TEXT, ip: '127.0.0.1', userAgent: 'synthetic-playwright' });
await db.insert(schema.channels).values({ id: channelId, userId: 'synthetic-owner', orgId: 'synthetic-org', title: 'Synthetic Channel', refreshTokenEnc: encrypt('synthetic-refresh-token'), toneLevel: 1 });
await db.insert(schema.rules).values({ channelId, type: 'keyword', pattern: banKeyword, action: 'ban' });
const session = await createSession('synthetic-owner', db, 'synthetic-org');

async function snapshot() {
	return {
		handles: await db.select().from(schema.channelAllowedHandles).all(),
		comments: await db.select().from(schema.comments).all(),
		actions: await db.select().from(schema.moderationActions).all(),
		audits: await db.select().from(schema.auditLog).all(),
		requests, blockedRequests
	};
}
let running = false;
process.on('message', async message => {
	try {
		if (message.command === 'state') {
			process.send({ id: message.id, value: await snapshot() });
		} else if (message.command === 'run') {
			if (running) throw new Error('Concurrent fixture run refused');
			running = true;
			try {
				const { runChannel } = await vite.ssrLoadModule('/src/lib/server/pipeline/run.ts');
				const result = await runChannel(channelId, { maxPages: 1 });
				process.send({ id: message.id, value: { result, ...await snapshot() } });
			} finally { running = false; }
		} else throw new Error('Unknown fixture command');
	} catch (error) {
		process.send({ id: message.id, error: error instanceof Error ? error.stack : String(error) });
	}
});
const address = vite.httpServer.address();
if (!address || typeof address === 'string') throw new Error('No loopback server address');
process.send({ ready: true, baseURL: `http://127.0.0.1:${address.port}`, token: session.token, channelId });
process.on('SIGTERM', async () => { await vite.close(); process.exit(0); });
