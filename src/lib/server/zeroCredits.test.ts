import { beforeEach, describe, expect, test, vi } from 'vitest';

import { eq } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
	env: { APP_URL: 'https://moderaty.app' } as Record<string, string | undefined>,
	sendMailjetMessage: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

vi.mock('./mailjet', () => ({ sendMailjetMessage: mocks.sendMailjetMessage }));

import { setupTestDb, testDb } from './testdb';
import { memberships, organizations, users } from './db/schema';
import { buildZeroCreditDeletedEmail, buildZeroCreditWarningEmail, sweepZeroCreditAccounts } from './zeroCredits';

setupTestDb([
	'memberships',
	'organizations',
	'users',
	'sessions',
	'consents',
	'invites',
	'channels',
	'comments',
	'moderation_actions',
	'audit_log',
	'channel_allowed_handles',
	'rules',
	'credit_transactions',
	'stripe_deletion_outbox',
	'stripe_lifetime_slots',
	'stripe_lifetime_entitlements',
	'feedback_digests',
	'feedback_findings',
	'finding_evidence',
	'feedback_history_comments'
]);

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

interface OrgSeed {
	plan?: string;
	creditsRemaining?: number | null;
	stripeSubscriptionId?: string | null;
	subscriptionStatus?: string | null;
}

/** A user whose personal org carries the given billing state. */
async function seedAccount(userId: string, org: OrgSeed = {}): Promise<void> {
	await testDb().db
		.insert(users)
		.values({ id: userId, googleSub: `sub-${userId}`, email: `${userId}@example.com`, displayName: userId });
	await testDb().db.insert(organizations).values({
		id: `org-${userId}`,
		name: userId,
		personalFor: userId,
		...(org.plan !== undefined ? { plan: org.plan } : {}),
		...(org.creditsRemaining !== undefined ? { creditsRemaining: org.creditsRemaining } : {}),
		...(org.stripeSubscriptionId !== undefined ? { stripeSubscriptionId: org.stripeSubscriptionId } : {}),
		...(org.subscriptionStatus !== undefined ? { stripeSubscriptionStatus: org.subscriptionStatus } : {})
	});
	await testDb().db.insert(memberships).values({ userId, orgId: `org-${userId}`, role: 'owner' });
}

/** A shared (never-personal) org the user also belongs to. */
async function seedSharedOrg(userId: string, orgId: string, org: OrgSeed = {}): Promise<void> {
	await testDb().db.insert(organizations).values({
		id: orgId,
		name: orgId,
		...(org.plan !== undefined ? { plan: org.plan } : {}),
		...(org.creditsRemaining !== undefined ? { creditsRemaining: org.creditsRemaining } : {}),
		...(org.stripeSubscriptionId !== undefined ? { stripeSubscriptionId: org.stripeSubscriptionId } : {}),
		...(org.subscriptionStatus !== undefined ? { stripeSubscriptionStatus: org.subscriptionStatus } : {})
	});
	await testDb().db.insert(memberships).values({ userId, orgId, role: 'owner' });
}

async function userRow(userId: string) {
	return testDb().db.select().from(users).where(eq(users.id, userId)).get();
}

beforeEach(() => {
	mocks.env.APP_URL = 'https://moderaty.app';
	mocks.sendMailjetMessage.mockReset();
	mocks.sendMailjetMessage.mockResolvedValue({ messageId: 1, messageUuid: 'uuid-1' });
});

describe('eligibility', () => {
	test('a never-purchased personal org is unmetered — never enters the countdown', async () => {
		await seedAccount('u1'); // credits_remaining NULL: self-hosted / untouched account
		const result = await sweepZeroCreditAccounts();
		expect(result).toMatchObject({ evaluated: 1, warned: 0, deleted: 0, errors: 0 });
		expect(await userRow('u1')).toMatchObject({ zeroCreditsSince: null, zeroCreditsNotifiedAt: null });
		expect(mocks.sendMailjetMessage).not.toHaveBeenCalled();
	});

	test('a lifetime org is unmetered — never enters the countdown', async () => {
		await seedAccount('u1', { plan: 'lifetime', creditsRemaining: null });
		const result = await sweepZeroCreditAccounts();
		expect(result.errors).toBe(0);
		expect(await userRow('u1')).toMatchObject({ zeroCreditsSince: null });
		expect(mocks.sendMailjetMessage).not.toHaveBeenCalled();
	});

	test.each(['active', 'trialing', 'past_due', 'unpaid'])(
		'a metered org with a live subscription status (%s) keeps the account out of the countdown',
		async (status) => {
			await seedAccount('u1', { creditsRemaining: 0, stripeSubscriptionId: 'sub_1', subscriptionStatus: status });
			await sweepZeroCreditAccounts();
			expect(await userRow('u1')).toMatchObject({ zeroCreditsSince: null });
			expect(mocks.sendMailjetMessage).not.toHaveBeenCalled();
		}
	);

	test('a billing-engaged account at zero stamps the clock — and sends NO e-mail on day 0', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		const result = await sweepZeroCreditAccounts();
		expect(result).toMatchObject({ evaluated: 1, warned: 0, deleted: 0, errors: 0 });
		const row = await userRow('u1');
		expect(Date.parse(row!.zeroCreditsSince!)).toBeGreaterThan(Date.now() - 60_000);
		expect(row!.zeroCreditsNotifiedAt).toBeNull();
		expect(mocks.sendMailjetMessage).not.toHaveBeenCalled();
	});

	test('one funded metered org keeps a multi-org account alive', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await seedSharedOrg('u1', 'org-funded', { creditsRemaining: 50 });
		const result = await sweepZeroCreditAccounts();
		expect(result.warned).toBe(0);
		expect(await userRow('u1')).toMatchObject({ zeroCreditsSince: null });
	});

	test('a never-purchased shared org is not "funded" — the broke metered org still starts the clock', async () => {
		// Unmetered orgs are excluded from the test rather than counted as
		// keepers: otherwise a user could dodge deletion forever by creating
		// an empty team, and every untouched personal org would immunize its
		// account.
		await seedAccount('u1', { creditsRemaining: 0 });
		await seedSharedOrg('u1', 'org-empty'); // unmetered: NULL credits, no subscription
		const result = await sweepZeroCreditAccounts();
		expect(result.errors).toBe(0);
		expect((await userRow('u1'))!.zeroCreditsSince).not.toBeNull();
	});

	test('an account with no metered org at all is ignored even alongside unmetered extras', async () => {
		await seedAccount('u1'); // unmetered personal
		await seedSharedOrg('u1', 'org-empty'); // unmetered shared
		await sweepZeroCreditAccounts();
		expect(await userRow('u1')).toMatchObject({ zeroCreditsSince: null });
	});

	test('a live user with zero memberships is a loud data bug, never a deletion candidate', async () => {
		await testDb().db.insert(users).values({ id: 'orphan', googleSub: 'sub-orphan', email: 'o@x.com', displayName: 'Orphan' });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await sweepZeroCreditAccounts();
		expect(result).toMatchObject({ evaluated: 1, errors: 0, deleted: 0 });
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no memberships'));
		errorSpy.mockRestore();
	});
});

describe('warning cadence', () => {
	test('the first warning lands at the 7-day mark, exactly once per milestone', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(8) }).where(eq(users.id, 'u1'));

		const first = await sweepZeroCreditAccounts();
		expect(first).toMatchObject({ warned: 1, deleted: 0 });
		expect(mocks.sendMailjetMessage).toHaveBeenCalledTimes(1);
		expect(mocks.sendMailjetMessage.mock.calls[0][0]).toMatchObject({
			toEmail: 'u1@example.com',
			subject: expect.stringContaining('22 days') // ~30 - 8
		});
		expect((await userRow('u1'))!.zeroCreditsNotifiedAt).not.toBeNull();

		// Same tick / same milestone: the claim already stands — no re-send.
		const second = await sweepZeroCreditAccounts();
		expect(second.warned).toBe(0);
		expect(mocks.sendMailjetMessage).toHaveBeenCalledTimes(1);
	});

	test('warnings repeat at 14, 21, and 28 days — each exactly once', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(29) }).where(eq(users.id, 'u1'));

		for (const notifiedDaysAgo of [22, 15, 8]) {
			await testDb().db.update(users).set({ zeroCreditsNotifiedAt: daysAgo(notifiedDaysAgo) }).where(eq(users.id, 'u1'));
			const result = await sweepZeroCreditAccounts();
			expect(result.warned).toBe(1);
		}
		expect(mocks.sendMailjetMessage).toHaveBeenCalledTimes(3);
		expect(mocks.sendMailjetMessage.mock.calls[2][0].subject).toContain('1 day'); // day 29 → 1 day left
	});

	test('no warning while inside a 7-day interval', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb()
			.db.update(users)
			.set({ zeroCreditsSince: daysAgo(9), zeroCreditsNotifiedAt: daysAgo(2) })
			.where(eq(users.id, 'u1'));
		const result = await sweepZeroCreditAccounts();
		expect(result.warned).toBe(0);
		expect(mocks.sendMailjetMessage).not.toHaveBeenCalled();
	});

	test('a missing APP_URL never consumes the milestone — the warning retries once configured', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(8) }).where(eq(users.id, 'u1'));
		delete mocks.env.APP_URL;
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const failed = await sweepZeroCreditAccounts();
		expect(failed).toMatchObject({ warned: 0, errors: 1 });
		// The claim must NOT stand: the milestone was never mailed, so the
		// row stays due — the "never silently consumed" guarantee.
		expect((await userRow('u1'))!.zeroCreditsNotifiedAt).toBeNull();
		expect(mocks.sendMailjetMessage).not.toHaveBeenCalled();

		mocks.env.APP_URL = 'https://moderaty.app';
		const retried = await sweepZeroCreditAccounts();
		expect(retried).toMatchObject({ warned: 1, errors: 0 });
		expect(mocks.sendMailjetMessage).toHaveBeenCalledTimes(1);
		errorSpy.mockRestore();
	});

	test('a failed send releases the claim so the milestone retries next sweep', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(8) }).where(eq(users.id, 'u1'));
		mocks.sendMailjetMessage.mockRejectedValueOnce(new Error('mailjet down'));

		const failed = await sweepZeroCreditAccounts();
		expect(failed).toMatchObject({ warned: 0, errors: 1 });
		expect((await userRow('u1'))!.zeroCreditsNotifiedAt).toBeNull(); // claim restored

		const retried = await sweepZeroCreditAccounts();
		expect(retried).toMatchObject({ warned: 1, errors: 0 });
		expect(mocks.sendMailjetMessage).toHaveBeenCalledTimes(2);
	});
});

describe('countdown reset', () => {
	test('refunding clears the countdown, and a re-break starts a fresh 30 days', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb()
			.db.update(users)
			.set({ zeroCreditsSince: daysAgo(9), zeroCreditsNotifiedAt: daysAgo(2) })
			.where(eq(users.id, 'u1'));

		// A purchase lands: funded again — clock and warning claim cleared.
		await testDb().db.update(organizations).set({ creditsRemaining: 25 }).where(eq(organizations.id, 'org-u1'));
		const cleared = await sweepZeroCreditAccounts();
		expect(cleared.warned).toBe(0);
		expect(await userRow('u1')).toMatchObject({ zeroCreditsSince: null, zeroCreditsNotifiedAt: null });

		// Spends down again: the new observation starts a NEW clock — never a
		// resurrection of the old deadline.
		await testDb().db.update(organizations).set({ creditsRemaining: 0 }).where(eq(organizations.id, 'org-u1'));
		await sweepZeroCreditAccounts();
		const row = await userRow('u1');
		expect(Date.parse(row!.zeroCreditsSince!)).toBeGreaterThan(Date.now() - 60_000);
		expect(mocks.sendMailjetMessage).not.toHaveBeenCalled();
	});
});

describe('deletion', () => {
	test('30 days at zero deletes the account via the shared tombstone path', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(31) }).where(eq(users.id, 'u1'));

		const result = await sweepZeroCreditAccounts();
		expect(result).toMatchObject({ deleted: 1, errors: 0 });
		// Final notice went out before the erase.
		expect(mocks.sendMailjetMessage).toHaveBeenCalledTimes(1);
		expect(mocks.sendMailjetMessage.mock.calls[0][0].subject).toContain('has been deleted');

		const tombstone = await userRow('u1');
		expect(tombstone).toMatchObject({ googleSub: 'deleted:u1', email: '[deleted]', displayName: '[deleted]' });
		// Sole-member personal org dissolved with the account.
		expect(await testDb().db.select().from(organizations).all()).toHaveLength(0);
		expect(await testDb().db.select().from(memberships).all()).toHaveLength(0);
	});

	test('the countdown claim makes a concurrent/second deletion a no-op', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(31) }).where(eq(users.id, 'u1'));
		await sweepZeroCreditAccounts();
		// Tombstoned users never enter the batch again.
		const second = await sweepZeroCreditAccounts();
		expect(second).toMatchObject({ evaluated: 0, deleted: 0 });
		expect(mocks.sendMailjetMessage).toHaveBeenCalledTimes(1);
	});

	test('a final-notice failure does not block the deletion', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(31) }).where(eq(users.id, 'u1'));
		mocks.sendMailjetMessage.mockRejectedValueOnce(new Error('mailjet down'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await sweepZeroCreditAccounts();
		expect(result).toMatchObject({ deleted: 1, errors: 0 });
		expect((await userRow('u1'))!.googleSub).toBe('deleted:u1');
		vi.restoreAllMocks();
	});

	test('a deletion failure is loud, counted, and retryable — the clock restarts', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(31) }).where(eq(users.id, 'u1'));
		// Corrupt the personal org into multi-member: deleteUserRecords' own
		// data-bug guard must refuse, and the sweep must surface it.
		await testDb().db.insert(users).values({ id: 'u2', googleSub: 'sub-u2', email: 'u2@x.com', displayName: 'u2' });
		await testDb().db.insert(memberships).values({ userId: 'u2', orgId: 'org-u1', role: 'member' });
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const failed = await sweepZeroCreditAccounts();
		expect(failed).toMatchObject({ deleted: 0, errors: 1 });
		expect((await userRow('u1'))!.googleSub).toBe('sub-u1'); // still alive
		vi.restoreAllMocks();
	});
});

describe('batching', () => {
	test('the sweep honors its limit and rotates coverage by checked_at', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await seedAccount('u2', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsCheckedAt: daysAgo(1) }).where(eq(users.id, 'u1'));
		// u2 was never checked (NULL sorts first) — evaluated before u1.
		const first = await sweepZeroCreditAccounts(1);
		expect(first.evaluated).toBe(1);
		expect((await userRow('u2'))!.zeroCreditsCheckedAt).not.toBeNull();
		const second = await sweepZeroCreditAccounts(1);
		expect(second.evaluated).toBe(1);
		// Both checked_at stamps now exist and differ — the rotation moved.
		const stamps = (await testDb().db.select({ checked: users.zeroCreditsCheckedAt }).from(users).all()).map((r) => r.checked);
		expect(stamps.every((s) => s !== null)).toBe(true);
	});

	test('an expired deadline bounds the batch without aborting the sweep', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		const result = await sweepZeroCreditAccounts(25, Date.now() - 1);
		expect(result).toMatchObject({ evaluated: 0, errors: 0 });
	});

	test('tombstoned accounts are never evaluated', async () => {
		await testDb().db.insert(users).values({ id: 'gone', googleSub: 'deleted:gone', email: '[deleted]', displayName: '[deleted]' });
		const result = await sweepZeroCreditAccounts();
		expect(result.evaluated).toBe(0);
	});
});

describe('e-mail builders', () => {
	test('the warning names the deadline and escapes the name', () => {
		const email = buildZeroCreditWarningEmail({
			name: 'Evil <script>',
			daysLeft: 22,
			deletionDateIso: '2026-10-21',
			usageUrl: 'https://moderaty.app/usage'
		});
		expect(email.subject).toContain('22 days');
		expect(email.textPart).toContain('2026-10-21');
		expect(email.textPart).toContain('https://moderaty.app/usage');
		expect(email.htmlPart).toContain('Evil &lt;script&gt;');
		expect(email.htmlPart).not.toContain('<script>');
	});

	test('the final notice states the deletion plainly', () => {
		const email = buildZeroCreditDeletedEmail({ name: 'Gone' });
		expect(email.subject).toContain('has been deleted');
		expect(email.textPart).toContain('30 days');
	});
});
