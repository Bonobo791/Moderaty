import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Client } from '@libsql/client';

const mocks = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
import { setupTestDb, testDb, seedUser, statementSql } from './testdb';
import { users, welcomeDiscovery, welcomeEmails } from './db/schema';
import { enrollWelcomeCandidates } from './welcomeBackfill';
import { WELCOME_CAMPAIGN } from './welcomeEnrollment';

setupTestDb(['users', 'welcome_emails', 'welcome_discovery']);
beforeEach(() => {
	for (const name of Object.keys(mocks.env)) delete mocks.env[name];
	Object.assign(mocks.env, { MODERATY_DEPLOYMENT: 'official-hosted', DRY_RUN: 'false' });
});
afterEach(() => vi.restoreAllMocks());

const budget = () => Date.now() + 10_000;
const row = (id: string) => testDb().db.select().from(welcomeEmails)
	.where(and(eq(welcomeEmails.userId, id), eq(welcomeEmails.campaign, WELCOME_CAMPAIGN))).get();

async function seedAccounts(count: number, accepted = false) {
	// One statement per fixture table keeps SQLite's statement counters focused
	// on discovery work instead of thousands of retained fixture statements.
	await testDb().client.execute({ sql: `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
		INSERT INTO users (id, google_sub, email, display_name)
		SELECT printf('user-%04d', i), printf('sub-%04d', i), printf('user-%04d@example.com', i), 'Fixture' FROM n`, args: [count] });
	if (accepted) await testDb().client.execute({ sql: `INSERT INTO welcome_emails
		(user_id, campaign, template_version, state, source, message_id)
		SELECT id, ?, 1, 'accepted', 'fixture', '<accepted-' || id || '@moderaty.com>' FROM users`, args: [WELCOME_CAMPAIGN] });
}

async function measureUserQueries<T>(run: () => Promise<T>) {
	let scanSteps = 0;
	let vmSteps = 0;
	const observe = (handle: Pick<Client, 'execute'>) => {
		const execute = handle.execute.bind(handle);
		vi.spyOn(handle, 'execute').mockImplementation(async (statement, args) => {
			const result = await execute(statement, args);
			const sql = statementSql(statement);
			if (/^select /i.test(sql) && sql.toLowerCase().includes('from "users"')) {
				// Read before a transaction closes its connection and finalizes the
				// statement. These counters measure executed SQLite VM work.
				const stats = await execute({ sql: 'SELECT nscan, nstep FROM sqlite_stmt WHERE sql = ?', args: [sql] });
				expect(stats.rows.length).toBeGreaterThan(0);
				for (const entry of stats.rows) { scanSteps += Number(entry.nscan); vmSteps += Number(entry.nstep); }
			}
			return result;
		});
	};
	const client = testDb().client;
	observe(client);
	const transaction = client.transaction.bind(client);
	vi.spyOn(client, 'transaction').mockImplementation(async (...args) => {
		const tx = await transaction(...args);
		observe(tx);
		return tx;
	});
	return { value: await run(), scanSteps, vmSteps };
}

test('a mostly enrolled population costs at most one raw user page per tick', async () => {
	await seedAccounts(1000, true);
	await seedUser('z-unenrolled');
	const result = await measureUserQueries(() => enrollWelcomeCandidates(budget()));
	expect(result.scanSteps).toBeLessThanOrEqual(24);
	expect(result.vmSteps).toBeLessThan(2500);
	expect(result.value).toEqual({ scanned: 25, queued: 0, enrollmentErrors: 0 });
	expect(await row('z-unenrolled')).toBeUndefined();
});

test('terminal pages advance durably until a later eligible account is reached', async () => {
	await seedAccounts(61, true);
	await seedUser('z-unenrolled');
	expect(await enrollWelcomeCandidates(budget())).toMatchObject({ scanned: 25, queued: 0 });
	expect(await enrollWelcomeCandidates(budget())).toMatchObject({ scanned: 25, queued: 0 });
	expect(await enrollWelcomeCandidates(budget())).toMatchObject({ scanned: 12, queued: 1 });
	expect(await row('z-unenrolled')).toMatchObject({ state: 'queued' });
});

test('a finite traversal wraps to backdated and newly eligible accounts despite later inserts', async () => {
	await seedAccounts(61, true);
	expect(await enrollWelcomeCandidates(budget())).toMatchObject({ scanned: 25, queued: 0 });
	await seedUser('a-later-insert');
	await testDb().db.update(users).set({ createdAt: '2000-01-01T00:00:00.000Z' }).where(eq(users.id, 'a-later-insert'));
	await testDb().db.update(welcomeEmails).set({ state: 'historical_unknown' }).where(eq(welcomeEmails.userId, 'user-0000'));
	for (const id of ['z-new-1', 'z-new-2']) {
		await seedUser(id);
		await enrollWelcomeCandidates(budget());
	}
	// New high ids cannot keep extending the traversal ahead of the low id.
	expect(await enrollWelcomeCandidates(budget())).toMatchObject({ scanned: 25, queued: 2 });
	expect(await row('a-later-insert')).toMatchObject({ state: 'queued' });
	expect(await row('user-0000')).toMatchObject({ state: 'queued' });
});

test('a repeatedly failing low account cannot pin the page and is retried after wrap', async () => {
	await seedUser('a-failing');
	await seedAccounts(50);
	await testDb().client.execute(`CREATE TRIGGER fixture_failed_enrollment BEFORE INSERT ON welcome_emails
		WHEN NEW.user_id = 'a-failing' BEGIN SELECT RAISE(ABORT, 'fixture enrollment unavailable'); END`);
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		expect(await enrollWelcomeCandidates(budget())).toMatchObject({ scanned: 25, queued: 24, enrollmentErrors: 1 });
		expect(await enrollWelcomeCandidates(budget())).toMatchObject({ scanned: 25, queued: 25, enrollmentErrors: 0 });
		expect(await enrollWelcomeCandidates(budget())).toMatchObject({ scanned: 1, queued: 1, enrollmentErrors: 0 });
		expect(await row('user-0049')).toMatchObject({ state: 'queued' });
		await testDb().client.execute('DROP TRIGGER fixture_failed_enrollment');
		expect(await enrollWelcomeCandidates(budget())).toMatchObject({ scanned: 25, queued: 1, enrollmentErrors: 0 });
		expect(await row('a-failing')).toMatchObject({ state: 'queued' });
		expect(log).toHaveBeenCalledWith(expect.stringContaining('[welcome]'), { category: 'unexpected_preparation_or_persistence' });
	} finally {
		await testDb().client.execute('DROP TRIGGER IF EXISTS fixture_failed_enrollment');
	}
});

test('deadline expiry commits the last inspected id and resumes unprocessed ids', async () => {
	for (const id of ['a-first', 'b-next', 'c-last']) await seedUser(id);
	const now = Date.now();
	const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
	const enrollment = await import('./welcomeEnrollment');
	const enqueue = enrollment.enqueueWelcome;
	const interrupted = vi.spyOn(enrollment, 'enqueueWelcome').mockImplementation(async (...args) => {
		const result = await enqueue(...args);
		clock.mockReturnValue(now + 10_001);
		return result;
	});
	expect(await enrollWelcomeCandidates(now + 10_000)).toEqual({ scanned: 1, queued: 1, enrollmentErrors: 0 });
	expect(await testDb().db.select().from(welcomeDiscovery).get()).toMatchObject({
		afterUserId: 'a-first', cycleEndUserId: 'c-last', claimToken: null, leaseExpiresAt: null
	});
	interrupted.mockRestore(); clock.mockRestore();
	expect(await enrollWelcomeCandidates(budget())).toEqual({ scanned: 2, queued: 2, enrollmentErrors: 0 });
	for (const id of ['a-first', 'b-next', 'c-last']) expect(await row(id)).toMatchObject({ state: 'queued' });
});

test('a failed enrollment remains visible when its rollback outlasts the discovery lease', async () => {
	await seedUser('slow-failing');
	const now = Date.now();
	const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
	const enrollment = await import('./welcomeEnrollment');
	vi.spyOn(enrollment, 'enqueueWelcome').mockImplementation(async () => {
		clock.mockReturnValue(now + 60_001);
		throw new Error('fixture slow persistence failure');
	});
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	expect(await enrollWelcomeCandidates(now + 5_000)).toEqual({ scanned: 0, queued: 0, enrollmentErrors: 1 });
	expect(log).toHaveBeenCalledWith(expect.stringContaining('[welcome]'), { category: 'unexpected_preparation_or_persistence' });
	expect(await testDb().db.select().from(welcomeEmails)).toHaveLength(0);
	expect(await testDb().db.select().from(welcomeDiscovery).get()).toMatchObject({
		afterUserId: null, cycleEndUserId: 'slow-failing', claimToken: null, leaseExpiresAt: null
	});
});

async function holdFirstUserPage() {
	let started!: () => void;
	let release!: () => void;
	const ready = new Promise<void>(resolve => { started = resolve; });
	const pending = new Promise<void>(resolve => { release = resolve; });
	const client = testDb().client;
	const execute = client.execute.bind(client);
	let held = false;
	vi.spyOn(client, 'execute').mockImplementation(async (statement, args) => {
		const result = await execute(statement, args);
		const sql = statementSql(statement);
		if (!held && /^select /i.test(sql) && sql.toLowerCase().includes('from "users"')) {
			held = true;
			started(); await pending;
		}
		return result;
	});
	return { ready, release };
}

test('overlapping discoveries cannot inspect the same campaign page while its lease is active', async () => {
	await seedAccounts(50);
	const gate = await holdFirstUserPage();
	const first = enrollWelcomeCandidates(budget());
	try {
		await gate.ready;
		expect(await enrollWelcomeCandidates(budget())).toEqual({ scanned: 0, queued: 0, enrollmentErrors: 0 });
	} finally { gate.release(); await first; }
	expect(await enrollWelcomeCandidates(budget())).toEqual({ scanned: 25, queued: 25, enrollmentErrors: 0 });
	expect(await testDb().db.select().from(welcomeEmails)).toHaveLength(50);
});

test('an expired worker cannot rewind the cursor after a successor takes over', async () => {
	await seedAccounts(50);
	const now = Date.now();
	const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
	const gate = await holdFirstUserPage();
	const first = enrollWelcomeCandidates(now + 120_000);
	try {
		await gate.ready;
		clock.mockReturnValue(now + 60_001);
		expect(await enrollWelcomeCandidates(now + 120_000)).toEqual({ scanned: 25, queued: 25, enrollmentErrors: 0 });
	} finally { gate.release(); }
	expect(await first).toEqual({ scanned: 0, queued: 0, enrollmentErrors: 0 });
	expect(await testDb().db.select().from(welcomeDiscovery).get()).toMatchObject({ afterUserId: 'user-0024' });
	expect(await enrollWelcomeCandidates(now + 120_000)).toEqual({ scanned: 25, queued: 25, enrollmentErrors: 0 });
	expect(await testDb().db.select().from(welcomeEmails)).toHaveLength(50);
});
