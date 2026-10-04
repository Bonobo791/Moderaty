import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
	env: {} as Record<string, string | undefined>,
	send: vi.fn()
}));
vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('./protonMail', async original => ({
	...(await original<typeof import('./protonMail')>()), sendProtonMailEmail: mocks.send
}));
import { setupTestDb, testDb, seedUser } from './testdb';
import { users, welcomeCampaigns, welcomeEmails } from './db/schema';
import { enqueueWelcome, sweepWelcomeEmails, WELCOME_CAMPAIGN } from './welcomeEmail';
import { ProtonMailSubmissionError } from './protonMail';

setupTestDb(['users', 'organizations', 'memberships', 'channels', 'welcome_emails', 'welcome_campaigns', 'welcome_discovery']);
beforeEach(() => {
	for (const name of Object.keys(mocks.env)) delete mocks.env[name];
	Object.assign(mocks.env, { MODERATY_DEPLOYMENT: 'official-hosted', APP_URL: 'https://moderaty.com', DRY_RUN: 'false' });
	mocks.send.mockReset().mockResolvedValue({ messageId: '<fixture-accepted@moderaty.com>' });
});
afterEach(() => vi.restoreAllMocks());

const budget = () => Date.now() + 10_000;
const rows = () => testDb().db.select().from(welcomeEmails);
const row = (id: string) => testDb().db.select().from(welcomeEmails)
	.where(and(eq(welcomeEmails.userId, id), eq(welcomeEmails.campaign, WELCOME_CAMPAIGN))).get();
async function pauseDelivery() {
	await testDb().db.insert(welcomeCampaigns).values({ campaign: WELCOME_CAMPAIGN, nextAttemptAt: '2099-01-01T00:00:00.000Z' });
}
async function historical(id: string, state: string, extra: Partial<typeof welcomeEmails.$inferInsert> = {}) {
	await seedUser(id);
	await testDb().db.insert(welcomeEmails).values({ userId: id, campaign: WELCOME_CAMPAIGN,
		templateVersion: 1, state, source: state === 'never_sent' ? 'never_sent' : 'historical_unknown', messageId: `<fixture-${id}@moderaty.com>`, ...extra });
}

test('normal sweeps automatically enroll all existing hosted users across bounded pages without a caller cursor', async () => {
	await pauseDelivery();
	for (let i = 0; i < 61; i++) await seedUser(`user-${String(i).padStart(3, '0')}`);
	await testDb().db.update(users).set({ plan: 'lifetime' }).where(eq(users.id, 'user-060'));
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 25, queued: 25, accepted: 0 });
	expect(await rows()).toHaveLength(25);
	// The campaign cursor is durable; callers keep no process-local progress.
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 25, queued: 25 });
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 11, queued: 11 });
	const enrolled = await rows();
	expect(enrolled).toHaveLength(61);
	expect(enrolled.every(item => item.state === 'queued' && item.source === 'historical_unknown')).toBe(true);
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 25, queued: 0 });
	expect(await rows()).toEqual(enrolled);
	// The next traversal revisits a later account that sorts before the cursor.
	await seedUser('earlier-new-account');
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 25, queued: 0 });
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 11, queued: 0 });
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 25, queued: 1 });
	expect(await rows()).toHaveLength(62);
	expect(mocks.send).not.toHaveBeenCalled();
});

test('historical unknown and never-sent enroll; terminal states and markers cannot pin the next page', async () => {
	await pauseDelivery();
	for (let i = 0; i < 30; i++) await historical(`a-accepted-${i}`, 'accepted'); // missing accepted_at remains terminal
	for (const state of ['queued', 'claimed', 'in_flight', 'retryable_failure', 'permanent_failure', 'suppressed', 'ambiguous']) {
		await historical(`b-${state}`, state);
	}
	await historical('b-marked-accepted', 'historical_unknown', { acceptedAt: '2026-01-01T00:00:00.000Z' });
	await historical('b-marked-suppressed', 'never_sent', { suppressionReason: 'operator' });
	await historical('b-nonhosted', 'historical_unknown', { cohort: 'self-hosted' });
	await seedUser('b-deleted');
	await testDb().db.update(users).set({ googleSub: 'deleted:b-deleted', email: '[deleted]' }).where(eq(users.id, 'b-deleted'));
	await seedUser('b-invalid');
	await testDb().db.update(users).set({ email: 'invalid' }).where(eq(users.id, 'b-invalid'));
	await historical('z-unknown', 'historical_unknown');
	await historical('z-unsent', 'never_sent');
	await seedUser('z-missing');
	const before = await rows();
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 25, queued: 0, accepted: 0, ambiguous: 1 });
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 20, queued: 3, accepted: 0, ambiguous: 1 });
	for (const id of ['z-unknown', 'z-unsent', 'z-missing']) expect(await row(id)).toMatchObject({ state: 'queued' });
	expect(await row('z-unsent')).toMatchObject({ source: 'never_sent' });
	expect(await row('z-unknown')).toMatchObject({ messageId: '<fixture-z-unknown@moderaty.com>' });
	expect(await row('b-invalid')).toMatchObject({ state: 'suppressed', suppressionReason: 'invalid_recipient' });
	expect(await row('b-deleted')).toBeUndefined();
	for (const item of before.filter(item => !item.userId.startsWith('z-'))) expect(await row(item.userId)).toEqual(item);
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 25, queued: 0 });
	expect(mocks.send).not.toHaveBeenCalled();
});

test.each([undefined, '', 'true'])('official hosting automatically enrolls and sends with welcome switch %s', async enabled => {
	mocks.env.WELCOME_EMAIL_ENABLED = enabled;
	await seedUser('existing');
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ queued: 1, accepted: 1 });
	expect(await row('existing')).toMatchObject({ state: 'accepted', acceptedAt: expect.any(String), attempts: 1 });
	await sweepWelcomeEmails(budget());
	expect(await rows()).toHaveLength(1);
	expect(mocks.send).toHaveBeenCalledTimes(1);
});

test.each([
	{ WELCOME_EMAIL_ENABLED: 'false' }, { MODERATY_DEPLOYMENT: 'self-hosted' },
	{ MODERATY_DEPLOYMENT: undefined }, { DRY_RUN: 'true' }, { DRY_RUN: undefined }
])('disabled, dry-run and self-hosted sweeps leave no enrollment or mail: %o', async settings => {
	Object.assign(mocks.env, settings);
	await seedUser('existing');
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 0, queued: 0, accepted: 0 });
	expect(await rows()).toHaveLength(0);
	expect(mocks.send).not.toHaveBeenCalled();
});

test('overlapping discovery, signup enrollment and repeated cron have only one campaign record and send', async () => {
	await seedUser('one');
	let release!: () => void;
	let started!: () => void;
	const ready = new Promise<void>(resolve => { started = resolve; });
	const pending = new Promise<void>(resolve => { release = resolve; });
	mocks.send.mockImplementationOnce(async () => { started(); await pending; return { messageId: '<fixture-accepted@moderaty.com>' }; });
	const first = sweepWelcomeEmails(budget());
	try {
		await ready;
		await Promise.all([sweepWelcomeEmails(budget()), enqueueWelcome(testDb().db, 'one', 'signup')]);
		expect(await row('one')).toMatchObject({ state: 'in_flight', attempts: 1 });
		expect(await rows()).toHaveLength(1);
	} finally { release(); await first; }
	await sweepWelcomeEmails(budget());
	expect(await row('one')).toMatchObject({ state: 'accepted', attempts: 1 });
	expect(mocks.send).toHaveBeenCalledTimes(1);
});

test('concurrent candidate reads converge on one durable enrollment', async () => {
	await pauseDelivery(); await seedUser('one');
	await Promise.all([sweepWelcomeEmails(budget()), sweepWelcomeEmails(budget())]);
	expect(await rows()).toHaveLength(1);
	expect(await row('one')).toMatchObject({ state: 'queued', attempts: 0 });
	expect(mocks.send).not.toHaveBeenCalled();
});

test('a failed enrollment preserves successful rows, continues the page, and resumes next sweep', async () => {
	await pauseDelivery();
	for (const id of ['one', 'two', 'three']) await seedUser(id);
	const original = testDb().db.transaction.bind(testDb().db);
	let calls = 0;
	const interrupted = vi.spyOn(testDb().db, 'transaction').mockImplementation((async (callback, ...rest) => {
		if (++calls === 2) throw new Error('fixture interrupted enrollment');
		return original(callback, ...rest);
	}) as typeof original);
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 3, queued: 2, enrollmentErrors: 1 });
	interrupted.mockRestore();
	expect(await rows()).toHaveLength(2);
	const first = (await rows())[0];
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 3, queued: 1, enrollmentErrors: 0 });
	expect(await rows()).toHaveLength(3);
	expect(await row(first.userId)).toEqual(first);
});

test('persistent enrollment failure after busy retries cannot block other accounts or queued delivery', async () => {
	for (const id of ['a-bad', 'b-good', 'c-good', 'z-ready']) await seedUser(id);
	await enqueueWelcome(testDb().db, 'z-ready', 'signup');
	await testDb().db.update(welcomeEmails).set({ nextRetryAt: new Date(0).toISOString() }).where(eq(welcomeEmails.userId, 'z-ready'));
	const enrollment = await import('./welcomeEnrollment');
	const original = enrollment.enqueueWelcome;
	let failuresLeft = 3;
	const failure = Object.assign(new Error('private-query-fixture private-recipient-fixture'), { code: 'SQLITE_BUSY' });
	const interrupted = vi.spyOn(enrollment, 'enqueueWelcome').mockImplementation(async (handle, userId, source) => {
		if (userId === 'a-bad' && failuresLeft > 0) { failuresLeft--; throw failure; }
		return original(handle, userId, source);
	});
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 4, queued: 2, enrollmentErrors: 1, accepted: 1, errors: 0 });
		expect(await row('a-bad')).toBeUndefined();
		expect(await row('z-ready')).toMatchObject({ state: 'accepted', attempts: 1 });
		for (const id of ['b-good', 'c-good']) {
			failuresLeft = 3;
			await testDb().db.update(welcomeCampaigns).set({ nextAttemptAt: new Date(0).toISOString() });
			expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 4, queued: 0, enrollmentErrors: 1, accepted: 1 });
			expect(await row(id)).toMatchObject({ state: 'accepted', attempts: 1 });
		}
		expect(await rows()).toHaveLength(3);
		expect(mocks.send.mock.calls.map(call => call[0].toEmail).sort()).toEqual(['b-good@example.com', 'c-good@example.com', 'z-ready@example.com']);
		expect(log).toHaveBeenCalledWith(expect.stringContaining('[welcome]'), { category: 'database_busy' });
		expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-query-fixture|private-recipient-fixture/);
	} finally { interrupted.mockRestore(); log.mockRestore(); }
});

test('queued welcomes keep making progress when every discovery run exhausts its deadline', async () => {
	for (const id of ['one', 'two']) {
		await seedUser(id);
		await enqueueWelcome(testDb().db, id, 'signup');
	}
	await seedUser('unenrolled');
	const now = Date.now();
	const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
	const discovery = vi.spyOn(await import('./welcomeBackfill'), 'enrollWelcomeCandidates').mockImplementation(async deadline => {
		// Model a discovery query that returns only after the shared budget is spent.
		clock.mockReturnValue(deadline + 1);
		return { scanned: 0, queued: 0, enrollmentErrors: 0 };
	});
	for (const id of ['one', 'two']) {
		clock.mockReturnValue(now);
		await testDb().db.update(welcomeCampaigns).set({ nextAttemptAt: new Date(0).toISOString() });
		expect(await sweepWelcomeEmails(now + 10_000)).toMatchObject({ accepted: 1, scanned: 0, queued: 0 });
		expect(await row(id)).toMatchObject({ state: 'accepted', attempts: 1 });
	}
	expect(discovery).toHaveBeenCalledTimes(2);
	expect(mocks.send.mock.calls.map(call => call[0].toEmail)).toEqual(['one@example.com', 'two@example.com']);
	expect(await row('unenrolled')).toBeUndefined();
	clock.mockReturnValue(now);
	await sweepWelcomeEmails(now + 10_000);
	expect(mocks.send).toHaveBeenCalledTimes(2);
});

test('enrollment stops between accounts when the shared deadline expires, then resumes', async () => {
	await pauseDelivery(); await seedUser('one'); await seedUser('two');
	const now = Date.now();
	const enrollment = await import('./welcomeEnrollment');
	const original = enrollment.enqueueWelcome;
	const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
	const interrupted = vi.spyOn(enrollment, 'enqueueWelcome').mockImplementation(async (...args) => {
		const result = await original(...args);
		clock.mockReturnValue(now + 10_001);
		return result;
	});
	expect(await sweepWelcomeEmails(now + 10_000)).toMatchObject({ scanned: 1, queued: 1, accepted: 0 });
	interrupted.mockRestore(); clock.mockRestore();
	expect(await rows()).toHaveLength(1);
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 1, queued: 1 });
	expect(await rows()).toHaveLength(2);
	expect(mocks.send).not.toHaveBeenCalled();
});

test('an already spent deadline makes no enrollment', async () => {
	await seedUser('one');
	expect(await sweepWelcomeEmails(Date.now() - 1)).toMatchObject({ scanned: 0, queued: 0 });
	expect(await rows()).toHaveLength(0);
	expect(mocks.send).not.toHaveBeenCalled();
});

test.each(['deleted', 'accepted', 'suppressed'] as const)('discovery rechecks a concurrent %s account change transactionally', async change => {
	await pauseDelivery(); await historical('one', 'historical_unknown');
	const original = testDb().db.transaction.bind(testDb().db);
	let changed = false;
	const race = vi.spyOn(testDb().db, 'transaction').mockImplementation((async (callback, ...rest) => {
		if (!changed) {
			changed = true;
			if (change === 'deleted') {
				const { deleteUserRecords } = await import('./deletion'); await deleteUserRecords('one');
			} else {
				await testDb().db.update(welcomeEmails).set(change === 'accepted'
					? { acceptedAt: '2026-01-01T00:00:00.000Z' } : { suppressionReason: 'operator' })
					.where(eq(welcomeEmails.userId, 'one'));
			}
		}
		return original(callback, ...rest);
	}) as typeof original);
	try { expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 1, queued: 0 }); }
	finally { race.mockRestore(); }
	if (change === 'deleted') expect(await row('one')).toBeUndefined();
	else expect(await row('one')).toMatchObject({ state: 'historical_unknown', attempts: 0 });
	expect(mocks.send).not.toHaveBeenCalled();
});

test('a fresh uncertain automatic send is held through repeated discovery and an expired lease', async () => {
	await seedUser('one');
	mocks.send.mockRejectedValueOnce(new ProtonMailSubmissionError('unknown', 'timeout', 'fixture timeout'));
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ queued: 1, ambiguous: 1 });
	await testDb().db.update(welcomeCampaigns).set({ nextAttemptAt: new Date(0).toISOString() });
	await testDb().db.update(welcomeEmails).set({ acceptedAt: null, leaseExpiresAt: new Date(0).toISOString() }).where(eq(welcomeEmails.userId, 'one'));
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 1, queued: 0, ambiguous: 1 });
	expect(await row('one')).toMatchObject({ state: 'ambiguous', nextRetryAt: null, attempts: 1 });
	expect(mocks.send).toHaveBeenCalledTimes(1);
});

test('a new template version cannot reenroll an already accepted campaign', async () => {
	await historical('one', 'accepted', { templateVersion: 1, acceptedAt: '2026-01-01T00:00:00.000Z', attempts: 1 });
	const accepted = await row('one');
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 1, queued: 0, accepted: 0 });
	expect(await enqueueWelcome(testDb().db, 'one', 'signup')).toBe(false);
	expect(await row('one')).toEqual(accepted);
	expect(mocks.send).not.toHaveBeenCalled();
});

test('unclassified historical cohorts and another campaign do not exclude this welcome', async () => {
	await pauseDelivery();
	await historical('blank-cohort', 'historical_unknown', { cohort: '' });
	await seedUser('other-campaign');
	await testDb().db.insert(welcomeEmails).values({ userId: 'other-campaign', campaign: 'other-fixture-campaign',
		templateVersion: 1, state: 'accepted', source: 'fixture', messageId: '<other-fixture@moderaty.com>' });
	expect(await sweepWelcomeEmails(budget())).toMatchObject({ scanned: 2, queued: 2 });
	expect(await row('blank-cohort')).toMatchObject({ state: 'queued', cohort: 'official-hosted' });
	expect(await row('other-campaign')).toMatchObject({ state: 'queued' });
	expect(await rows()).toHaveLength(3);
});
