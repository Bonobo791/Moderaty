import { format } from 'node:util';

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { eq } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
	env: { APP_URL: 'https://moderaty.app', ENCRYPTION_KEY: 'zc-test-key', STRIPE_PRICE_CREDITS_500: 'price_test_500' } as Record<string, string | undefined>,
	sendProtonMailEmail: vi.fn(),
	revokeGoogleToken: vi.fn(),
	sessionsRetrieve: vi.fn(),
	customersUpdate: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

vi.mock('./protonMail', () => ({ sendProtonMailEmail: mocks.sendProtonMailEmail }));

vi.mock('./google', () => ({ revokeGoogleToken: mocks.revokeGoogleToken }));

vi.mock('./stripe/client', () => ({
	getStripe: () => ({
		checkout: { sessions: { retrieve: mocks.sessionsRetrieve } },
		customers: { update: mocks.customersUpdate }
	})
}));

import { encrypt } from './crypto';
import { setupTestDb, testDb } from './testdb';
import { channels, creditTransactions, googleRevocationOutbox, memberships, mercadoPagoCheckoutAttempts, organizations, stripeCheckoutAttempts, stripeSubscriptionPeriods, users } from './db/schema';
import { createCreditCheckout } from './billing/checkout';
import { DeadlineExceededError } from './http';
import { handleStripeEvent } from './stripe/webhooks';
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
	'google_revocation_outbox',
	'stripe_scrub_outbox',
	'stripe_checkout_attempts',
	'stripe_events',
	'stripe_pending_reversals',
	'mercado_pago_checkout_attempts',
	'stripe_subscription_periods',
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

/** An unresolved attempt whose local payment state has not changed for four days. */
async function seedOldCheckout(provider: string, status: string) {
	const attempt = {
		attemptId: 'att-stale', orgId: 'org-u1', idempotencyKey: 'idem-stale',
		status, createdAt: daysAgo(30), updatedAt: daysAgo(4)
	};
	if (provider === 'Stripe') {
		await testDb().db.insert(stripeCheckoutAttempts).values({ ...attempt, product: 'credits_500' });
		return stripeCheckoutAttempts;
	}
	// No paidAt yet: provider truth may never have reached our DB.
	await testDb().db.insert(mercadoPagoCheckoutAttempts).values({ ...attempt, bundleId: 'credits_500', amountCents: 500 });
	return mercadoPagoCheckoutAttempts;
}

async function userRow(userId: string) {
	return testDb().db.select().from(users).where(eq(users.id, userId)).get();
}

beforeEach(() => {
	mocks.env.APP_URL = 'https://moderaty.app';
	mocks.sendProtonMailEmail.mockReset();
	mocks.sendProtonMailEmail.mockResolvedValue({ messageId: '<msg-1@moderaty.app>' });
	mocks.revokeGoogleToken.mockReset();
	mocks.revokeGoogleToken.mockResolvedValue(undefined);
	mocks.sessionsRetrieve.mockReset();
	mocks.customersUpdate.mockReset().mockResolvedValue({});
});

describe('eligibility', () => {
	test('a never-purchased personal org is unmetered — never enters the countdown', async () => {
		await seedAccount('u1'); // credits_remaining NULL: self-hosted / untouched account
		const result = await sweepZeroCreditAccounts();
		expect(result).toMatchObject({ evaluated: 1, warned: 0, deleted: 0, errors: 0 });
		expect(await userRow('u1')).toMatchObject({ zeroCreditsSince: null, zeroCreditsNotifiedAt: null });
		expect(mocks.sendProtonMailEmail).not.toHaveBeenCalled();
	});

	test('a lifetime org is unmetered — never enters the countdown', async () => {
		await seedAccount('u1', { plan: 'lifetime', creditsRemaining: null });
		const result = await sweepZeroCreditAccounts();
		expect(result.errors).toBe(0);
		expect(await userRow('u1')).toMatchObject({ zeroCreditsSince: null });
		expect(mocks.sendProtonMailEmail).not.toHaveBeenCalled();
	});

	test.each(['active', 'trialing', 'past_due'])(
		'a metered org with a live subscription status (%s) keeps the account out of the countdown',
		async (status) => {
			await seedAccount('u1', { creditsRemaining: 0, stripeSubscriptionId: 'sub_1', subscriptionStatus: status });
			await sweepZeroCreditAccounts();
			expect(await userRow('u1')).toMatchObject({ zeroCreditsSince: null });
			expect(mocks.sendProtonMailEmail).not.toHaveBeenCalled();
		}
	);

	test("an 'unpaid' subscription does NOT hold the countdown — dunning is over, no payment is in flight", async () => {
		// codex: Stripe documents 'unpaid' as the terminal dunning state —
		// payments are no longer attempted and access should be revoked.
		// Treating it as "live" would exempt a permanently lapsed paid
		// account from the Terms §17 deletion forever.
		await seedAccount('u1', { plan: 'hosted', creditsRemaining: 0, stripeSubscriptionId: 'sub_1', subscriptionStatus: 'unpaid' });
		const result = await sweepZeroCreditAccounts();
		expect(result.errors).toBe(0);
		expect((await userRow('u1'))!.zeroCreditsSince).not.toBeNull();
	});

	test('an org whose subscription never completed is NOT billing-engaged — the never-purchased exemption holds', async () => {
		// codex: customer.subscription.created stores stripeSubscriptionId even
		// for 'incomplete' subs (payment never succeeded). A bare id is not
		// engagement — only a hosted plan, a granted balance, or a paid
		// subscription period proves the account purchased.
		await seedAccount('u1', { creditsRemaining: null, stripeSubscriptionId: 'sub_1', subscriptionStatus: 'incomplete' });
		const result = await sweepZeroCreditAccounts();
		expect(result.errors).toBe(0);
		expect(await userRow('u1')).toMatchObject({ zeroCreditsSince: null, zeroCreditsNotifiedAt: null });
		expect(mocks.sendProtonMailEmail).not.toHaveBeenCalled();
	});

	test('a canceled subscription WITH a paid period is still billing-engaged — the countdown applies', async () => {
		// The subscriber lapsed but DID purchase: §17 deletion applies to
		// billing-engaged accounts, so the clock must start.
		await seedAccount('u1', { creditsRemaining: null, stripeSubscriptionId: 'sub_1', subscriptionStatus: 'canceled' });
		await testDb().db.insert(stripeSubscriptionPeriods).values({
			orgId: 'org-u1',
			subscriptionId: 'sub_1',
			invoiceId: 'in_1',
			periodKey: '2026-01',
			periodStart: daysAgo(60),
			periodEnd: daysAgo(30),
			includedCredits: 100,
			consumedCredits: 0,
			status: 'paid'
		});
		const result = await sweepZeroCreditAccounts();
		expect(result.errors).toBe(0);
		expect((await userRow('u1'))!.zeroCreditsSince).not.toBeNull();
	});

	test('a billing-engaged account at zero stamps the clock — and sends NO e-mail on day 0', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		const result = await sweepZeroCreditAccounts();
		expect(result).toMatchObject({ evaluated: 1, warned: 0, deleted: 0, errors: 0 });
		const row = await userRow('u1');
		expect(Date.parse(row!.zeroCreditsSince!)).toBeGreaterThan(Date.now() - 60_000);
		expect(row!.zeroCreditsNotifiedAt).toBeNull();
		expect(mocks.sendProtonMailEmail).not.toHaveBeenCalled();
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

	test('a lifetime organization exempts the whole account — even beside a broke metered org', async () => {
		// Terms §17.3: "lifetime-plan organizations are never subject to
		// zero-credit deletion." Account deletion would dissolve the lifetime
		// org's data, so the org-level exemption is meaningless unless it
		// exempts the account (codex+coderabbit).
		await seedAccount('u1', { creditsRemaining: 0 });
		await seedSharedOrg('u1', 'org-lifetime', { plan: 'lifetime' });
		const result = await sweepZeroCreditAccounts();
		expect(result).toMatchObject({ evaluated: 1, warned: 0, deleted: 0, errors: 0 });
		expect(await userRow('u1')).toMatchObject({ zeroCreditsSince: null, zeroCreditsNotifiedAt: null });
		expect(mocks.sendProtonMailEmail).not.toHaveBeenCalled();
	});

	test('a lifetime org acquired mid-countdown clears the clock — the account is never erased', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await seedSharedOrg('u1', 'org-lifetime', { plan: 'lifetime' });
		await testDb().db
			.update(users)
			.set({ zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7) })
			.where(eq(users.id, 'u1'));
		const result = await sweepZeroCreditAccounts();
		expect(result).toMatchObject({ deleted: 0, errors: 0 });
		const row = (await userRow('u1'))!;
		expect(row.googleSub).toBe('sub-u1'); // still alive
		expect(row.zeroCreditsSince).toBeNull(); // countdown cleared
		// The lifetime org is untouched — its data survived the sweep.
		expect(
			await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-lifetime')).all()
		).toHaveLength(1);
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
		expect(mocks.sendProtonMailEmail).toHaveBeenCalledTimes(1);
		expect(mocks.sendProtonMailEmail.mock.calls[0][0]).toMatchObject({
			toEmail: 'u1@example.com',
			subject: expect.stringContaining('22 days') // ~30 - 8
		});
		const warned = (await userRow('u1'))!;
		expect(warned.zeroCreditsNotifiedAt).not.toBeNull(); // claim stamp
		expect(warned.zeroCreditsWarnedAt).not.toBeNull(); // DELIVERY stamp — set only after sendMail resolved (codex)

		// Same tick / same milestone: the claim already stands — no re-send.
		const second = await sweepZeroCreditAccounts();
		expect(second.warned).toBe(0);
		expect(mocks.sendProtonMailEmail).toHaveBeenCalledTimes(1);
	});

	test('a claim without delivery never satisfies the deletion gate — the crash window stays safe', async () => {
		// codex: claimAndWarn stamps notified_at BEFORE sendMail confirms — a
		// crash between them left the account looking warned. The gate reads
		// warned_at (set only on confirmed delivery), so this state restarts
		// the warning window instead of erasing an unwarned account.
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db
			.update(users)
			.set({ zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(1) }) // claim taken, send never completed
			.where(eq(users.id, 'u1'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = await sweepZeroCreditAccounts();
			expect(result).toMatchObject({ deleted: 0, errors: 0 });
			const row = (await userRow('u1'))!;
			expect(row.googleSub).toBe('sub-u1'); // alive — never warned
			expect(Date.parse(row.zeroCreditsSince!)).toBeGreaterThan(Date.now() - 60_000); // window restarted
			expect(row.zeroCreditsWarnedAt).toBeNull();
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no delivered warning'));
		} finally {
			errorSpy.mockRestore();
		}
		expect(mocks.sendProtonMailEmail).not.toHaveBeenCalled();
	});

	test('a crashed claim becomes retryable — the lease expires and the next sweep redelivers', async () => {
		// The claim blocks re-sends for one cadence interval; once it ages out
		// the milestone is due again and delivery is confirmed this time.
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db
			.update(users)
			.set({ zeroCreditsSince: daysAgo(15), zeroCreditsNotifiedAt: daysAgo(8) }) // crashed claim, stale lease
			.where(eq(users.id, 'u1'));

		const result = await sweepZeroCreditAccounts();
		expect(result).toMatchObject({ warned: 1, errors: 0 });
		expect(mocks.sendProtonMailEmail).toHaveBeenCalledTimes(1);
		expect((await userRow('u1'))!.zeroCreditsWarnedAt).not.toBeNull();
	});

	test('a delivered warning that lands after the countdown moved is NOT marked — the gate stays honest', async () => {
		// codex CAS: the send resolves but a funded-clear/restamp replaced the
		// countdown mid-flight — marking warned_at now would credit a warning
		// for a countdown that no longer exists.
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(8) }).where(eq(users.id, 'u1'));
		mocks.sendProtonMailEmail.mockImplementationOnce(async () => {
			// A fresh countdown commits while the warning is in flight.
			await testDb().db.update(users).set({ zeroCreditsSince: new Date().toISOString() }).where(eq(users.id, 'u1'));
		});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const result = await sweepZeroCreditAccounts();
			expect(result).toMatchObject({ warned: 1, errors: 0 });
			expect(mocks.sendProtonMailEmail).toHaveBeenCalledTimes(1);
			const row = (await userRow('u1'))!;
			expect(row.zeroCreditsWarnedAt).toBeNull(); // delivery not credited to the new countdown
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('delivery left unmarked'));
		} finally {
			warnSpy.mockRestore();
		}
	});

	test('a corrupt warned_at stamp is loud and never unlocks deletion', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db
			.update(users)
			.set({ zeroCreditsSince: daysAgo(31), zeroCreditsWarnedAt: 'not-a-date' })
			.where(eq(users.id, 'u1'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = await sweepZeroCreditAccounts();
			expect(result).toMatchObject({ deleted: 0, errors: 0 });
			expect((await userRow('u1'))!.googleSub).toBe('sub-u1');
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unparseable'));
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('warnings repeat at 14, 21, and 28 days — each exactly once', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(29) }).where(eq(users.id, 'u1'));

		for (const notifiedDaysAgo of [22, 15, 8]) {
			await testDb().db.update(users).set({ zeroCreditsNotifiedAt: daysAgo(notifiedDaysAgo) }).where(eq(users.id, 'u1'));
			const result = await sweepZeroCreditAccounts();
			expect(result.warned).toBe(1);
		}
		expect(mocks.sendProtonMailEmail).toHaveBeenCalledTimes(3);
		expect(mocks.sendProtonMailEmail.mock.calls[2][0].subject).toContain('1 day'); // day 29 → 1 day left
	});

	test('no warning while inside a 7-day interval', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb()
			.db.update(users)
			.set({ zeroCreditsSince: daysAgo(9), zeroCreditsNotifiedAt: daysAgo(2) })
			.where(eq(users.id, 'u1'));
		const result = await sweepZeroCreditAccounts();
		expect(result.warned).toBe(0);
		expect(mocks.sendProtonMailEmail).not.toHaveBeenCalled();
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
		expect(mocks.sendProtonMailEmail).not.toHaveBeenCalled();

		mocks.env.APP_URL = 'https://moderaty.app';
		const retried = await sweepZeroCreditAccounts();
		expect(retried).toMatchObject({ warned: 1, errors: 0 });
		expect(mocks.sendProtonMailEmail).toHaveBeenCalledTimes(1);
		errorSpy.mockRestore();
	});

	test('a failed send releases the claim so the milestone retries next sweep', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(8) }).where(eq(users.id, 'u1'));
		mocks.sendProtonMailEmail.mockRejectedValueOnce(new Error('smtp provider down'));

		const failed = await sweepZeroCreditAccounts();
		expect(failed).toMatchObject({ warned: 0, errors: 1 });
		expect((await userRow('u1'))!.zeroCreditsNotifiedAt).toBeNull(); // claim restored

		const retried = await sweepZeroCreditAccounts();
		expect(retried).toMatchObject({ warned: 1, errors: 0 });
		expect(mocks.sendProtonMailEmail).toHaveBeenCalledTimes(2);
	});

	test('a purchase between evaluation and the warning claim suppresses the e-mail and clears the clock', async () => {
		// codeant: the claim guard pins only `zero_credits_since` — a top-up
		// lands on the org's credits, which the guard cannot see. The trigger
		// commits the racing purchase inside the claim's own UPDATE.
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(8) }).where(eq(users.id, 'u1'));
		await testDb().client.execute(
			`CREATE TRIGGER racing_topup AFTER UPDATE OF zero_credits_notified_at ON users
			 WHEN NEW.zero_credits_notified_at IS NOT NULL
			 BEGIN UPDATE organizations SET credits_remaining = 50; END`
		);
		try {
			const result = await sweepZeroCreditAccounts();
			expect(result).toMatchObject({ evaluated: 1, warned: 0, errors: 0 });
		} finally {
			await testDb().client.execute('DROP TRIGGER racing_topup');
		}
		expect(mocks.sendProtonMailEmail).not.toHaveBeenCalled();
		// The funded state is discovered post-claim: the clock clears now —
		// the funded path would do the same on the next rotation.
		expect(await userRow('u1')).toMatchObject({ zeroCreditsSince: null, zeroCreditsNotifiedAt: null });
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
		expect(mocks.sendProtonMailEmail).not.toHaveBeenCalled();
	});
});

describe('deletion', () => {
	test('30 days at zero deletes the account via the shared tombstone path', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7) }).where(eq(users.id, 'u1'));

		const result = await sweepZeroCreditAccounts();
		expect(result).toMatchObject({ deleted: 1, errors: 0 });
		// Final notice went out before the erase.
		expect(mocks.sendProtonMailEmail).toHaveBeenCalledTimes(1);
		expect(mocks.sendProtonMailEmail.mock.calls[0][0].subject).toContain('has been deleted');

		const tombstone = await userRow('u1');
		expect(tombstone).toMatchObject({ googleSub: 'deleted:u1', email: '[deleted]', displayName: '[deleted]' });
		// Sole-member personal org dissolved with the account.
		expect(await testDb().db.select().from(organizations).all()).toHaveLength(0);
		expect(await testDb().db.select().from(memberships).all()).toHaveLength(0);
	});

	test('the countdown claim makes a concurrent/second deletion a no-op', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7) }).where(eq(users.id, 'u1'));
		await sweepZeroCreditAccounts();
		// Tombstoned users never enter the batch again.
		const second = await sweepZeroCreditAccounts();
		expect(second).toMatchObject({ evaluated: 0, deleted: 0 });
		expect(mocks.sendProtonMailEmail).toHaveBeenCalledTimes(1);
	});

	test('a final-notice failure does not block the deletion', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7) }).where(eq(users.id, 'u1'));
		mocks.sendProtonMailEmail.mockRejectedValueOnce(new Error('smtp provider down'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await sweepZeroCreditAccounts();
		expect(result).toMatchObject({ deleted: 1, errors: 0 });
		expect((await userRow('u1'))!.googleSub).toBe('deleted:u1');
		vi.restoreAllMocks();
	});

	test('a purchase between evaluation and the deletion claim saves the account', async () => {
		// codeant: same race as the warning claim, worse blast radius — a
		// top-up commits as the claim clears `since`, and the code below would
		// erase a now-funded account. The claim's own UPDATE fires the trigger
		// that lands the purchase.
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7) }).where(eq(users.id, 'u1'));
		await testDb().client.execute(
			`CREATE TRIGGER racing_topup AFTER UPDATE OF zero_credits_since ON users
			 WHEN NEW.zero_credits_since IS NULL
			 BEGIN UPDATE organizations SET credits_remaining = 50; END`
		);
		try {
			const result = await sweepZeroCreditAccounts();
			expect(result).toMatchObject({ evaluated: 1, deleted: 0, errors: 0 });
		} finally {
			await testDb().client.execute('DROP TRIGGER racing_topup');
		}
		expect(mocks.sendProtonMailEmail).not.toHaveBeenCalled();
		const user = await userRow('u1');
		expect(user?.googleSub).toBe('sub-u1'); // still alive — never tombstoned
		expect(user?.zeroCreditsSince).toBeNull(); // clock cleared by the claim
		// coderabbit: the warning stamp must die with the countdown — kept, it
		// would satisfy the next countdown's deletion gate with no fresh warning.
		expect(user?.zeroCreditsNotifiedAt).toBeNull();
	});

	test('the erase queues each grant revocation in the outbox and drains it inside the shared deadline', async () => {
		// codex: the post-commit drain used to run unbounded with no durable
		// obligation — a function killed mid-drain orphaned live Google grants
		// forever. The outbox row is written in-tx; the drain deletes it on
		// success and carries the caller's deadline through to the request.
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.insert(channels).values({ id: 'UC-1', userId: 'u1', orgId: 'org-u1', title: 'chan', refreshTokenEnc: encrypt('grant-token') });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7) }).where(eq(users.id, 'u1'));
		mocks.revokeGoogleToken.mockResolvedValue(undefined);
	mocks.sessionsRetrieve.mockReset();
	mocks.customersUpdate.mockReset().mockResolvedValue({});

		const deadline = Date.now() + 60_000;
		const result = await sweepZeroCreditAccounts(50, deadline);

		expect(result.deleted).toBe(1);
		expect(mocks.revokeGoogleToken).toHaveBeenCalledWith('grant-token', expect.stringContaining('UC-1'), deadline);
		expect(await testDb().db.select().from(googleRevocationOutbox).all()).toEqual([]);
	});

	test('a deadline spent mid-drain leaves the revocation queued — never a silent orphan', async () => {
		// codex: the drain used to run past the function's hard limit; now a
		// spent budget defers loudly and the outbox keeps the obligation for
		// the cron retry.
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.insert(channels).values([
			{ id: 'UC-1', userId: 'u1', orgId: 'org-u1', title: 'one', refreshTokenEnc: encrypt('tok-1') },
			{ id: 'UC-2', userId: 'u1', orgId: 'org-u1', title: 'two', refreshTokenEnc: encrypt('tok-2') }
		]);
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7) }).where(eq(users.id, 'u1'));
		let clock = Date.now();
		const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
		// The first revocation resolves but burns the rest of the budget.
		mocks.revokeGoogleToken.mockImplementation(async () => {
			clock += 120_000;
		});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = await sweepZeroCreditAccounts(50, clock + 30_000);
			expect(result.deleted).toBe(1);
			expect(mocks.revokeGoogleToken).toHaveBeenCalledTimes(1);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('1 grant revocation(s) stay queued'));
			expect(await testDb().db.select().from(googleRevocationOutbox).all()).toHaveLength(1);
		} finally {
			nowSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	test('a purchase landing inside the deletion transaction aborts the erase', async () => {
		// codex+coderabbit: the pre-delete funding check ran outside the erase
		// transaction, so a top-up committed in the gap was still deleted. The
		// guard's lock write inside deleteUserRecords' transaction fires this
		// trigger — a purchase landing mid-erase — and the guard must see it.
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7) }).where(eq(users.id, 'u1'));
		await testDb().client.execute(
			`CREATE TRIGGER topup_mid_delete AFTER UPDATE OF google_sub ON users
			 BEGIN UPDATE organizations SET credits_remaining = 50; END`
		);
		try {
			const result = await sweepZeroCreditAccounts();
			expect(result).toMatchObject({ evaluated: 1, deleted: 0, errors: 0 });
		} finally {
			await testDb().client.execute('DROP TRIGGER topup_mid_delete');
		}
		expect(mocks.sendProtonMailEmail).not.toHaveBeenCalled(); // no "deleted" notice — nothing was deleted
		expect((await userRow('u1'))!.googleSub).toBe('sub-u1'); // still alive — never tombstoned
		expect(await testDb().db.select().from(organizations).all()).toHaveLength(1);
	});

	test('a day-30 account that was never warned is NOT deleted — the warning window restarts', async () => {
		// codex+coderabbit: APP_URL missing or every e-mail send failing
		// leaves zeroCreditsNotifiedAt NULL; the bare clock must never erase
		// an account that got none of the warnings Terms §17.3 promises.
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(31) }).where(eq(users.id, 'u1'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = await sweepZeroCreditAccounts();
			expect(result).toMatchObject({ deleted: 0, errors: 0 });
			const row = (await userRow('u1'))!;
			expect(row.googleSub).toBe('sub-u1');
			// The countdown restarted so the promised warning cadence can run.
			expect(Date.parse(row.zeroCreditsSince!)).toBeGreaterThan(Date.now() - 60_000);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no delivered warning'));
		} finally {
			errorSpy.mockRestore();
		}
		expect(mocks.sendProtonMailEmail).not.toHaveBeenCalled();
	});

	test('a warning stamp from an earlier countdown cannot satisfy the deletion gate', async () => {
		// coderabbit: delivered 60d ago but the countdown restarted 31d ago —
		// the warning predates the CURRENT window, so the gate must treat the
		// account as never-warned and restart, not erase it.
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db
			.update(users)
			.set({ zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(60), zeroCreditsWarnedAt: daysAgo(60) })
			.where(eq(users.id, 'u1'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = await sweepZeroCreditAccounts();
			expect(result).toMatchObject({ deleted: 0, errors: 0 });
			const row = (await userRow('u1'))!;
			expect(row.googleSub).toBe('sub-u1');
			expect(Date.parse(row.zeroCreditsSince!)).toBeGreaterThan(Date.now() - 60_000);
			expect(row.zeroCreditsNotifiedAt).toBeNull(); // stale claim cleared with the restart
			expect(row.zeroCreditsWarnedAt).toBeNull(); // stale delivery marker cleared too
		} finally {
			errorSpy.mockRestore();
		}
		expect(mocks.sendProtonMailEmail).not.toHaveBeenCalled();
	});

	test('a leftover warning stamp is cleared when a new countdown starts', async () => {
		// coderabbit: stamps can outlive their countdown (claim-abort paths
		// used to clear only `since`). Re-stamping the clock must clear BOTH —
		// a stale claim would shorten the new cadence, and a stale delivery
		// marker would satisfy the deletion gate with no fresh warning (codex).
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsNotifiedAt: daysAgo(40), zeroCreditsWarnedAt: daysAgo(40) }).where(eq(users.id, 'u1'));

		const result = await sweepZeroCreditAccounts();
		expect(result).toMatchObject({ evaluated: 1, errors: 0 });
		const row = (await userRow('u1'))!;
		expect(Date.parse(row.zeroCreditsSince!)).toBeGreaterThan(Date.now() - 60_000);
		expect(row.zeroCreditsNotifiedAt).toBeNull();
		expect(row.zeroCreditsWarnedAt).toBeNull();
	});

	test('a corrupt notified_at stamp must never unlock deletion', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db
			.update(users)
			.set({ zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: 'not-a-date' })
			.where(eq(users.id, 'u1'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = await sweepZeroCreditAccounts();
			expect(result).toMatchObject({ deleted: 0, errors: 0 });
			expect((await userRow('u1'))!.googleSub).toBe('sub-u1');
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unparseable'));
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('the completion notice is sent only after the erase commits', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7) }).where(eq(users.id, 'u1'));
		// codex+coderabbit: the notice used to precede the erase — a failed
		// deletion would tell the user their account is gone while it lives.
		mocks.sendProtonMailEmail.mockImplementation(async () => {
			expect((await userRow('u1'))!.googleSub).toBe('deleted:u1'); // already committed
			return { messageId: '<msg-1@moderaty.app>' };
		});
		const result = await sweepZeroCreditAccounts();
		expect(result).toMatchObject({ deleted: 1, errors: 0 });
		expect(mocks.sendProtonMailEmail).toHaveBeenCalledTimes(1);
	});

	test('a failed deletion sends no completed-notice e-mail', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7) }).where(eq(users.id, 'u1'));
		// Multi-member personal org → deleteUserRecords' tenancy guard refuses.
		await testDb().db.insert(users).values({ id: 'u2', googleSub: 'sub-u2', email: 'u2@x.com', displayName: 'u2' });
		await testDb().db.insert(memberships).values({ userId: 'u2', orgId: 'org-u1', role: 'member' });
		vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = await sweepZeroCreditAccounts();
			expect(result).toMatchObject({ deleted: 0, errors: 1 });
		} finally {
			vi.restoreAllMocks();
		}
		expect(mocks.sendProtonMailEmail).not.toHaveBeenCalled();
		expect((await userRow('u1'))!.googleSub).toBe('sub-u1');
	});

	test('a deletion failure is loud, counted, and retryable — the clock restarts', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7) }).where(eq(users.id, 'u1'));
		// Corrupt the personal org into multi-member: deleteUserRecords' own
		// data-bug guard must refuse, and the sweep must surface it.
		await testDb().db.insert(users).values({ id: 'u2', googleSub: 'sub-u2', email: 'u2@x.com', displayName: 'u2' });
		await testDb().db.insert(memberships).values({ userId: 'u2', orgId: 'org-u1', role: 'member' });
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const failed = await sweepZeroCreditAccounts();
		expect(failed).toMatchObject({ deleted: 0, errors: 1 });
		expect((await userRow('u1'))!.googleSub).toBe('sub-u1'); // still alive
		// cubic: the retryability IS the safety property — the deletion claim
		// must have cleared both stamps so the survivor re-enters a fresh
		// 30-day window instead of being re-attempted on the next tick.
		expect((await userRow('u1'))!.zeroCreditsSince).toBeNull();
		expect((await userRow('u1'))!.zeroCreditsNotifiedAt).toBeNull();
		vi.restoreAllMocks();
	});

	test('a funded clear never erases a countdown stamped after the funding read', async () => {
		// cubic: the clear's WHERE clause must pin `since` to the value the
		// evaluation read — an unguarded clear would erase a fresh countdown
		// a concurrent tick stamped between the funding read and the write.
		await seedAccount('u1', { creditsRemaining: 0 });
		const staleStamp = daysAgo(3);
		await testDb().db.update(users).set({ zeroCreditsSince: staleStamp, zeroCreditsNotifiedAt: daysAgo(1) }).where(eq(users.id, 'u1'));
		// Make the account funded so evaluateUser takes the funded-clear path…
		await testDb().db.update(organizations).set({ creditsRemaining: 50 }).where(eq(organizations.id, 'org-u1'));
		// …then stamp a NEW countdown in the gap between the funding read and
		// the clear: intercept the clear's UPDATE (it is the one writing
		// zeroCreditsSince) and restamp first, mimicking the concurrent tick.
		const freshStamp = '2030-05-05T00:00:00.000Z';
		const realUpdate = testDb().db.update.bind(testDb().db) as (t: unknown) => {
			set: (v: Record<string, unknown>) => { where: (w: unknown) => Promise<unknown> };
		};
		const updateSpy = vi.spyOn(testDb().db, 'update').mockImplementation(((table: unknown) => {
			const builder = realUpdate(table);
			const realSet = builder.set.bind(builder);
			builder.set = (values: Record<string, unknown>) => {
				const whereable = realSet(values);
				if ('zeroCreditsSince' in values) {
					const realWhere = whereable.where.bind(whereable);
					whereable.where = async (w: unknown) => {
						// The "concurrent" tick: a fresh countdown lands before the
						// funded clear commits. An unguarded UPDATE erases it.
						// realUpdate bypasses the spy — the injected write isn't re-intercepted.
						await realUpdate(users).set({ zeroCreditsSince: freshStamp, zeroCreditsNotifiedAt: null }).where(eq(users.id, 'u1'));
						return realWhere(w as never);
					};
				}
				return whereable;
			};
			return builder;
		}) as never);
		try {
			const result = await sweepZeroCreditAccounts();
			expect(result).toMatchObject({ evaluated: 1, deleted: 0, errors: 0 });
		} finally {
			updateSpy.mockRestore();
		}
		// The fresh countdown survives — the clear's CAS saw a different
		// `since` than the one the evaluation read and no-op'd.
		expect((await userRow('u1'))!.zeroCreditsSince).toBe(freshStamp);
		expect((await userRow('u1'))!.zeroCreditsNotifiedAt).toBeNull();
	});

	test('a checkout opened recently defers deletion — the paid webhook can still land', async () => {
		// codex: Stripe marks nothing locally until the webhook fulfills the
		// attempt — an 'open' session paid at the provider is indistinguishable
		// from an abandoned one, and erasing the org strands the incoming
		// grant with no refund path. Defer, and keep the countdown.
		await seedAccount('u1', { creditsRemaining: 0 });
		const since = daysAgo(31);
		await testDb().db
			.update(users)
			.set({ zeroCreditsSince: since, zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7) })
			.where(eq(users.id, 'u1'));
		await testDb().db.insert(stripeCheckoutAttempts).values({
			attemptId: 'att-1',
			orgId: 'org-u1',
			product: 'credits_500',
			idempotencyKey: 'idem-1',
			stripeSessionId: 'cs_live',
			status: 'open'
		});

		const result = await sweepZeroCreditAccounts();
		expect(result).toMatchObject({ deleted: 0, errors: 0 });
		const row = (await userRow('u1'))!;
		expect(row.googleSub).toBe('sub-u1'); // alive — payment may still arrive
		expect(row.zeroCreditsSince).toBe(since); // countdown PRESERVED, not restarted
		expect(mocks.sendProtonMailEmail).not.toHaveBeenCalled();
	});

	test.each([
		['Stripe', 'pending'],
		['Stripe', 'open'],
		['Mercado Pago', 'pending'],
		['Mercado Pago', 'open']
	])('an old unresolved %s %s checkout preserves the account and countdown', async (provider, status) => {
		// A local timestamp cannot distinguish abandonment from a payment
		// whose delivery/fulfillment has failed beyond the retry window.
		await seedAccount('u1', { creditsRemaining: 0 });
		const countdown = {
			zeroCreditsSince: daysAgo(31),
			zeroCreditsNotifiedAt: daysAgo(7),
			zeroCreditsWarnedAt: daysAgo(7)
		};
		await testDb().db.update(users).set(countdown).where(eq(users.id, 'u1'));
		const table = await seedOldCheckout(provider, status);

		const result = await sweepZeroCreditAccounts();
		expect(result).toMatchObject({ evaluated: 1, deleted: 0, errors: 0 });
		expect(await userRow('u1')).toMatchObject({ googleSub: 'sub-u1', ...countdown });
		expect(await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-u1')).get()).toBeDefined();
		expect(await testDb().db.select({ status: table.status }).from(table).where(eq(table.attemptId, 'att-stale')).get()).toEqual({ status });
		expect(mocks.sendProtonMailEmail).not.toHaveBeenCalled();
		expect(mocks.sessionsRetrieve).not.toHaveBeenCalled(); // retention never makes remote calls under its write lock
	});

	test('a paid Stripe checkout still fulfills after a retry and sweep more than 72 hours later', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({
			zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7)
		}).where(eq(users.id, 'u1'));
		await testDb().db.insert(stripeCheckoutAttempts).values({
			attemptId: 'att-late', orgId: 'org-u1', product: 'credits_500', idempotencyKey: 'idem-late',
			stripeSessionId: 'cs_late', status: 'open', updatedAt: daysAgo(4)
		});
		mocks.sessionsRetrieve.mockResolvedValue({
			id: 'cs_late', mode: 'payment', status: 'complete', payment_status: 'paid',
			metadata: { org_id: 'org-u1', bundle: 'credits_500' }, customer: 'cus_late',
			payment_intent: { id: 'pi_late', payment_method: 'pm_late', latest_charge: 'ch_late' }
		});

		// Retrying a completed provider session must not falsely mark its
		// local attempt fulfilled before the webhook has granted anything.
		await expect(createCreditCheckout('org-u1', {
			id: 'u1', email: 'u1@example.com', displayName: 'u1', plan: 'free',
			orgId: 'org-u1', orgName: 'u1', orgRole: 'owner'
		}, 'credits_500', 'att-late')).rejects.toThrow('checkout attempt has already completed');
		await sweepZeroCreditAccounts();
		// Execute the real handler and ledger mutation, mocking only Stripe.
		// Before the fix this throws "org not found" after the sweep erases it.
		await expect(handleStripeEvent({
			id: 'evt_late', type: 'checkout.session.completed',
			data: { object: { id: 'cs_late', object: 'checkout.session' } }
		} as never)).resolves.toBe(true);
		expect(await testDb().db.select({ credits: organizations.creditsRemaining }).from(organizations).where(eq(organizations.id, 'org-u1')).get()).toEqual({ credits: 500 });
		expect(await testDb().db.select({ delta: creditTransactions.delta }).from(creditTransactions).where(eq(creditTransactions.refId, 'cs_late'))).toEqual([{ delta: 500 }]);
		expect(await testDb().db.select({ status: stripeCheckoutAttempts.status }).from(stripeCheckoutAttempts).where(eq(stripeCheckoutAttempts.attemptId, 'att-late')).get()).toEqual({ status: 'fulfilled' });
		expect(mocks.customersUpdate).toHaveBeenCalledWith('cus_late', { invoice_settings: { default_payment_method: 'pm_late' } });
		expect(await sweepZeroCreditAccounts()).toMatchObject({ deleted: 0, errors: 0 });
		expect(await userRow('u1')).toMatchObject({ googleSub: 'sub-u1', zeroCreditsSince: null, zeroCreditsNotifiedAt: null, zeroCreditsWarnedAt: null });
	});

	test.each([
		['checkout.session.expired', 'pending'],
		['checkout.session.expired', 'open'],
		['checkout.session.async_payment_failed', 'pending'],
		['checkout.session.async_payment_failed', 'open']
	])('a terminal %s event resolves a %s attempt and releases the deletion shield', async (eventType, status) => {
		await seedAccount('u1', { creditsRemaining: 0 });
		const countdown = { zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7) };
		await testDb().db.update(users).set(countdown).where(eq(users.id, 'u1'));
		await seedOldCheckout('Stripe', status);
		await testDb().db.update(stripeCheckoutAttempts).set({ stripeSessionId: 'cs_terminal' });
		mocks.sessionsRetrieve.mockResolvedValue({ id: 'cs_terminal', metadata: { org_id: 'org-u1' }, payment_intent: null });
		expect(await sweepZeroCreditAccounts()).toMatchObject({ deleted: 0, errors: 0 });
		const event = { id: 'evt_terminal', type: eventType, data: { object: { id: 'cs_terminal', object: 'checkout.session' } } };
		expect(await handleStripeEvent(event as never)).toBe(true);
		expect(await testDb().db.select({ status: stripeCheckoutAttempts.status }).from(stripeCheckoutAttempts).get()).toEqual({ status: 'expired' });
		expect(await userRow('u1')).toMatchObject(countdown);
		expect(await handleStripeEvent(event as never)).toBe(true);
		expect(mocks.sessionsRetrieve).toHaveBeenCalledTimes(eventType === 'checkout.session.async_payment_failed' ? 1 : 0);
		expect(await sweepZeroCreditAccounts()).toMatchObject({ deleted: 1, errors: 0 });
		expect((await userRow('u1'))!.googleSub).toBe('deleted:u1');
	});

	test.each(['checkout.session.expired', 'checkout.session.async_payment_failed'])('a %s event does not clear fulfilled, refund-required, or replacement sessions', async (eventType) => {
		await seedAccount('u1', { creditsRemaining: 0 });
		const attempts = [
			{ attemptId: 'att-fulfilled', stripeSessionId: 'cs_fulfilled', status: 'fulfilled' },
			{ attemptId: 'att-refund', stripeSessionId: 'cs_refund', status: 'manual_refund_required' },
			{ attemptId: 'att-replacement', stripeSessionId: 'cs_new', status: 'open' }
		];
		await testDb().db.insert(stripeCheckoutAttempts).values(attempts.map((attempt) => ({
			...attempt, orgId: 'org-u1', product: 'credits_500', idempotencyKey: attempt.attemptId
		})));
		mocks.sessionsRetrieve.mockImplementation(async (sessionId: string) => ({ id: sessionId, metadata: null }));
		const before = await testDb().db.select().from(stripeCheckoutAttempts);
		for (const sessionId of ['cs_fulfilled', 'cs_refund', 'cs_old']) {
			expect(await handleStripeEvent({ id: `evt_${sessionId}`, type: eventType, data: { object: { id: sessionId, object: 'checkout.session' } } } as never)).toBe(true);
		}
		expect(await testDb().db.select().from(stripeCheckoutAttempts)).toEqual(before);
	});

	test('a failed async reversal keeps the deletion shield for a webhook retry', async () => {
		await seedAccount('u1', { creditsRemaining: 500 });
		await testDb().db.insert(creditTransactions).values({ orgId: 'org-u1', delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_terminal', paymentIntentId: 'pi_terminal', chargeId: 'ch_terminal' });
		await seedOldCheckout('Stripe', 'open');
		await testDb().db.update(stripeCheckoutAttempts).set({ stripeSessionId: 'cs_terminal' });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7) }).where(eq(users.id, 'u1'));
		const event = { id: 'evt_terminal', type: 'checkout.session.async_payment_failed', data: { object: { id: 'cs_terminal', object: 'checkout.session' } } };
		mocks.sessionsRetrieve.mockRejectedValue(new Error('Stripe unavailable'));
		await expect(handleStripeEvent(event as never)).rejects.toThrow('Stripe unavailable');
		expect(await testDb().db.select({ status: stripeCheckoutAttempts.status }).from(stripeCheckoutAttempts).get()).toEqual({ status: 'open' });
		expect(await testDb().db.select({ credits: organizations.creditsRemaining }).from(organizations).get()).toEqual({ credits: 500 });
		mocks.sessionsRetrieve.mockResolvedValue({ id: 'cs_terminal', metadata: { org_id: 'org-u1' }, payment_intent: { id: 'pi_terminal', latest_charge: 'ch_terminal' } });
		expect(await handleStripeEvent(event as never)).toBe(true);
		expect(await handleStripeEvent(event as never)).toBe(true);
		expect(await testDb().db.select({ status: stripeCheckoutAttempts.status }).from(stripeCheckoutAttempts).get()).toEqual({ status: 'expired' });
		expect(await testDb().db.select({ credits: organizations.creditsRemaining }).from(organizations).get()).toEqual({ credits: 0 });
		expect(await testDb().db.select({ delta: creditTransactions.delta }).from(creditTransactions).where(eq(creditTransactions.reason, 'adjust'))).toEqual([{ delta: -500 }]);
		expect(mocks.sessionsRetrieve).toHaveBeenCalledTimes(2);
		expect(await sweepZeroCreditAccounts()).toMatchObject({ deleted: 1, errors: 0 });
		expect((await userRow('u1'))!.googleSub).toBe('deleted:u1');
	});

	test.each([
		['Stripe', 'expired'],
		['Stripe', 'fulfilled'],
		['Mercado Pago', 'fulfilled'],
		['Mercado Pago', 'refunded'],
		['Mercado Pago', 'disputed']
	])('a resolved %s %s attempt allows deletion on the original countdown', async (provider, status) => {
		await seedAccount('u1', { creditsRemaining: 0 });
		const since = daysAgo(31);
		await testDb().db.update(users).set({
			zeroCreditsSince: since, zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7)
		}).where(eq(users.id, 'u1'));
		const table = await seedOldCheckout(provider, 'open');
		expect(await sweepZeroCreditAccounts()).toMatchObject({ deleted: 0, errors: 0 });
		expect((await userRow('u1'))!.zeroCreditsSince).toBe(since);
		// Explicit resolution, never the passage of time, releases the shield.
		await testDb().db.update(table).set({ status }).where(eq(table.attemptId, 'att-stale'));
		if (provider === 'Mercado Pago') {
			await testDb().db.update(mercadoPagoCheckoutAttempts).set({ paidAt: daysAgo(5) }).where(eq(mercadoPagoCheckoutAttempts.attemptId, 'att-stale'));
		}
		expect(await sweepZeroCreditAccounts()).toMatchObject({ deleted: 1, errors: 0 });
		expect((await userRow('u1'))!.googleSub).toBe('deleted:u1');
	});

	test('a paid-but-unfulfilled attempt shields unconditionally — manual_refund_required never erases', async () => {
		// Money arrived but the grant never landed: the attempt row is the
		// refund trail — deleting the account destroys it (codex).
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db
			.update(users)
			.set({ zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7) })
			.where(eq(users.id, 'u1'));
		await testDb().db.insert(stripeCheckoutAttempts).values({
			attemptId: 'att-paid',
			orgId: 'org-u1',
			product: 'credits_500',
			idempotencyKey: 'idem-paid',
			status: 'manual_refund_required',
			updatedAt: daysAgo(30) // age does not matter — the obligation is real
		});

		const result = await sweepZeroCreditAccounts();
		expect(result).toMatchObject({ deleted: 0, errors: 0 });
		expect((await userRow('u1'))!.googleSub).toBe('sub-u1');
	});

	test.each(['open', 'unknown'])('a Mercado Pago paid stamp with unresolved status %s defers the erase', async (status) => {
		// The webhook saw the payment (paidAt written) but fulfillment never
		// completed — provider truth says money exists even though the local
		// balance does not.
		await seedAccount('u1', { creditsRemaining: 0 });
		await testDb().db
			.update(users)
			.set({ zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7) })
			.where(eq(users.id, 'u1'));
		await testDb().db.insert(mercadoPagoCheckoutAttempts).values({
			attemptId: 'mp-1',
			orgId: 'org-u1',
			bundleId: 'credits_500',
			idempotencyKey: 'mp-idem-1',
			status,
			amountCents: 500,
			paymentId: 'pay-1',
			paidAt: daysAgo(5), // provider confirmed — but never fulfilled
			updatedAt: daysAgo(5)
		});

		const result = await sweepZeroCreditAccounts();
		expect(result).toMatchObject({ deleted: 0, errors: 0 });
		expect((await userRow('u1'))!.googleSub).toBe('sub-u1');
	});

	test.each(['now', '-4 days'])('an unresolved checkout dated %s between the pre-check and erase aborts under the write lock', async (offset) => {
		// codex race: the pre-claim check ran clean, then a checkout opened
		// before the erase transaction committed — the in-tx predicate must
		// catch it and the countdown must be RESTORED, not silently cleared.
		await seedAccount('u1', { creditsRemaining: 0 });
		const since = daysAgo(31);
		await testDb().db
			.update(users)
			.set({ zeroCreditsSince: since, zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7) })
			.where(eq(users.id, 'u1'));
		// The lock write inside deleteUserRecords' assertDeletable fires this
		// trigger — mimicking a checkout session opening mid-erase.
		await testDb().client.execute(
			`CREATE TRIGGER checkout_mid_delete AFTER UPDATE OF google_sub ON users
			 BEGIN INSERT INTO stripe_checkout_attempts (attempt_id, org_id, product, idempotency_key, status, updated_at)
			 VALUES ('att-mid', 'org-u1', 'credits_500', 'idem-mid', 'open', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${offset === 'now' ? '+0 days' : offset}')); END`
		);
		const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
		try {
			const result = await sweepZeroCreditAccounts();
			expect(result).toMatchObject({ deleted: 0, errors: 0 });
			expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('countdown restored'));
			const row = (await userRow('u1'))!;
			expect(row.googleSub).toBe('sub-u1'); // still alive
			expect(row.zeroCreditsSince).toBe(since); // countdown RESTORED, not restarted
		} finally {
			await testDb().client.execute('DROP TRIGGER checkout_mid_delete');
			infoSpy.mockRestore();
		}
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
		const u2Stamp = (await userRow('u2'))!.zeroCreditsCheckedAt;
		expect(u2Stamp).not.toBeNull();
		const second = await sweepZeroCreditAccounts(1);
		expect(second.evaluated).toBe(1);
		// cubic: the rotation must actually move — u2's stamp stays untouched
		// while u1's is refreshed. Re-selecting u2 would pass the old
		// non-null check while the round-robin regressed.
		expect((await userRow('u2'))!.zeroCreditsCheckedAt).toBe(u2Stamp);
		const u1Stamp = (await userRow('u1'))!.zeroCreditsCheckedAt;
		expect(u1Stamp).not.toBeNull();
		expect(Date.parse(u1Stamp!)).toBeGreaterThan(Date.parse(daysAgo(1)));
	});

	test('an expired deadline bounds the batch without aborting the sweep', async () => {
		await seedAccount('u1', { creditsRemaining: 0 });
		const result = await sweepZeroCreditAccounts(25, Date.now() - 1);
		expect(result).toMatchObject({ evaluated: 0, errors: 0 });
	});

	test('a deadline that expires mid-warning defers the rest of the sweep without an error', async () => {
		// codex: the deadline used to be checked only between users — the mail
		// send, the erase, and Stripe cleanup could run unbounded past the budget.
		// DeadlineExceededError is a scheduling condition, not a per-account
		// failure: the claim releases (milestone survives for next tick) and
		// the sweep stops cleanly.
		const deadline = Date.now() + 1_000;
		await seedAccount('u1', { creditsRemaining: 0 });
		await seedAccount('u2', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(8) }).where(eq(users.id, 'u1'));
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(8) }).where(eq(users.id, 'u2'));
		mocks.sendProtonMailEmail.mockImplementation(async (_msg: unknown, given?: number) => {
			expect(given).toBe(deadline); // the shared budget reaches the provider call
			throw new DeadlineExceededError();
		});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = await sweepZeroCreditAccounts(1_000, deadline);
			expect(result).toMatchObject({ deleted: 0, errors: 0 });
			expect(mocks.sendProtonMailEmail).toHaveBeenCalledTimes(1); // u2 never reached the provider
			expect((await userRow('u1'))!.zeroCreditsNotifiedAt).toBeNull(); // claim released — no milestone consumed
			expect((await userRow('u2'))!.zeroCreditsNotifiedAt).toBeNull();
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('deadline'));
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('tombstoned accounts are never evaluated', async () => {
		await testDb().db.insert(users).values({ id: 'gone', googleSub: 'deleted:gone', email: '[deleted]', displayName: '[deleted]' });
		const result = await sweepZeroCreditAccounts();
		expect(result.evaluated).toBe(0);
	});
});

describe('loud failure logging', () => {
	test('an evaluation failure logs the user id verbatim — a % in it cannot swallow the error arg', async () => {
		// console.error treats arg[0] as a util.format format string: an id
		// interpolated INTO it turns `%s` inside the id into a specifier that
		// consumes the trailing error and hides the real failure (codeant).
		await seedAccount('u%s-1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(8) }).where(eq(users.id, 'u%s-1'));
		mocks.sendProtonMailEmail.mockRejectedValueOnce(new Error('smtp provider down'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await sweepZeroCreditAccounts();

		expect(result.errors).toBe(1);
		const call = errorSpy.mock.calls.find((args) => String(args[0]).includes('evaluation failed'));
		expect(call).toBeDefined();
		expect(format(...call!)).toContain('u%s-1');
		expect(format(...call!)).toContain('smtp provider down');
		errorSpy.mockRestore();
	});

	test('a final-notice failure logs the user id verbatim', async () => {
		await seedAccount('d%s-1', { creditsRemaining: 0 });
		await testDb().db.update(users).set({ zeroCreditsSince: daysAgo(31), zeroCreditsNotifiedAt: daysAgo(7), zeroCreditsWarnedAt: daysAgo(7) }).where(eq(users.id, 'd%s-1'));
		mocks.sendProtonMailEmail.mockRejectedValueOnce(new Error('smtp provider down'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await sweepZeroCreditAccounts();

		expect(result.deleted).toBe(1);
		const call = errorSpy.mock.calls.find((args) => String(args[0]).includes('post-deletion notice'));
		expect(call).toBeDefined();
		expect(format(...call!)).toContain('d%s-1');
		errorSpy.mockRestore();
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
		// Attribute context is escaped too — a quote in the URL cannot break
		// out of the href.
		const quoted = buildZeroCreditWarningEmail({ name: 'n', daysLeft: 1, deletionDateIso: 'd', usageUrl: 'https://x/usa"ge' });
		expect(quoted.htmlPart).toContain('href="https://x/usa&quot;ge"');
		expect(quoted.htmlPart).not.toContain('usa"ge');
	});

	test('the final notice states the deletion plainly', () => {
		const email = buildZeroCreditDeletedEmail({ name: 'Gone' });
		expect(email.subject).toContain('has been deleted');
		expect(email.textPart).toContain('30 days');
	});
});
