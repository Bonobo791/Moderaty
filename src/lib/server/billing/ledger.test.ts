// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';

import { setupTestDb, testDb } from '$lib/server/testdb';
import { db } from '$lib/server/db';
import { creditTransactions, organizations } from '$lib/server/db/schema';
import {
	applyLedgerDelta,
	consumeCredit,
	findGrantForStripe,
	getCredits,
	listCreditTransactions,
	monthStartIso,
	orgIsMetered,
	usageSummary
} from './ledger';

setupTestDb(['organizations', 'credit_transactions', 'stripe_events']);

async function seedOrg(orgId = 'org-1', credits: number | null = null, stripeCustomerId: string | null = null): Promise<void> {
	await testDb().db
		.insert(organizations)
		.values({ id: orgId, name: 'Test org', creditsRemaining: credits, stripeCustomerId });
}

describe('orgIsMetered', () => {
	test('an org with neither balance nor customer is unmetered (self-hosted / pre-billing)', async () => {
		await seedOrg('org-1', null, null);
		expect(await orgIsMetered('org-1')).toBe(false);
	});

	test('an org with a balance is metered even with no customer', async () => {
		await seedOrg('org-1', 500, null);
		expect(await orgIsMetered('org-1')).toBe(true);
	});

	test('an org with a Stripe customer is metered even with a null balance', async () => {
		await seedOrg('org-1', null, 'cus_1');
		expect(await orgIsMetered('org-1')).toBe(true);
	});

	test('fails loudly for an unknown org', async () => {
		await expect(orgIsMetered('missing')).rejects.toThrow('org not found');
	});
});


describe('consumeCredit', () => {
	test('charges one credit and records the row with the new balance', async () => {
		await seedOrg('org-1', 5);
		const charged = await consumeCredit(db, 'org-1', 'comment-1');
		expect(charged).toBe(true);
		expect(await getCredits('org-1')).toBe(4);
		const rows = await listCreditTransactions('org-1');
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ orgId: 'org-1', delta: -1, reason: 'consume', refType: 'comment', refId: 'comment-1' });
		expect(rows[0].balanceAfter).toBe(4);
	});

	test('is idempotent: the same comment is charged exactly once', async () => {
		await seedOrg('org-1', 5);
		expect(await consumeCredit(db, 'org-1', 'comment-1')).toBe(true);
		expect(await consumeCredit(db, 'org-1', 'comment-1')).toBe(false);
		expect(await getCredits('org-1')).toBe(4);
	});

	test('at balance 0 the comment is not charged and no ledger row survives', async () => {
		await seedOrg('org-1', 0);
		expect(await consumeCredit(db, 'org-1', 'comment-1')).toBe(false);
		expect(await getCredits('org-1')).toBe(0);
		expect(await listCreditTransactions('org-1')).toHaveLength(0);
	});

	test('an org with a null balance behaves as zero', async () => {
		await seedOrg('org-1', null);
		expect(await consumeCredit(db, 'org-1', 'comment-1')).toBe(false);
	});

	test('fails loudly for an unknown org', async () => {
		await expect(consumeCredit(db, 'missing', 'comment-1')).rejects.toThrow('org not found');
	});
});

describe('applyLedgerDelta', () => {
	test('grants credits and records the purchase row keyed by checkout session', async () => {
		await seedOrg('org-1', 0);
		const applied = await applyLedgerDelta(db, {
			orgId: 'org-1',
			delta: 500,
			reason: 'purchase',
			refType: 'checkout_session',
			refId: 'cs_123',
			paymentIntentId: 'pi_123',
			chargeId: 'ch_123'
		});
		expect(applied).toBe(true);
		expect(await getCredits('org-1')).toBe(500);
		const rows = await listCreditTransactions('org-1');
		expect(rows).toHaveLength(1);
		expect(rows[0].balanceAfter).toBe(500);
	});

	test('is idempotent: the same session never grants twice', async () => {
		await seedOrg('org-1', 0);
		expect(await applyLedgerDelta(db, { orgId: 'org-1', delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_123' })).toBe(true);
		expect(await applyLedgerDelta(db, { orgId: 'org-1', delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_123' })).toBe(false);
		expect(await getCredits('org-1')).toBe(500);
	});

	test('reverses credits (negative delta) idempotently', async () => {
		await seedOrg('org-1', 500);
		const applied = await applyLedgerDelta(db, { orgId: 'org-1', delta: -500, reason: 'refund', refType: 'charge', refId: 'ch_123' });
		expect(applied).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
		expect(await applyLedgerDelta(db, { orgId: 'org-1', delta: -500, reason: 'refund', refType: 'charge', refId: 'ch_123' })).toBe(false);
		expect(await getCredits('org-1')).toBe(0);
	});

	test('fails loudly for an unknown org', async () => {
		await expect(applyLedgerDelta(db, { orgId: 'missing', delta: 100, reason: 'purchase', refType: 'checkout_session', refId: 'cs_x' })).rejects.toThrow('org not found');
	});
});

describe('findGrantForStripe', () => {
	test('finds a grant by payment intent id', async () => {
		await seedOrg('org-1', 0);
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 2000, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1' });
		const match = await findGrantForStripe(db, { paymentIntentId: 'pi_1' });
		expect(match).toEqual({ orgId: 'org-1', credits: 2000 });
	});

	test('finds a grant by charge id', async () => {
		await seedOrg('org-1', 0);
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 100, reason: 'auto_topup', refType: 'payment_intent', refId: 'pi_2', paymentIntentId: 'pi_2', chargeId: 'ch_2' });
		const match = await findGrantForStripe(db, { chargeId: 'ch_2' });
		expect(match).toEqual({ orgId: 'org-1', credits: 100 });
	});

	test('never counts won-dispute restores (adjust) as part of the charge grant', async () => {
		// A refund must reverse what the charge ORIGINALLY granted — a restore
		// row (money that came back after a won dispute) is not part of it.
		await seedOrg('org-1', 0);
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 2000, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 2000, reason: 'adjust', refType: 'dispute', refId: 'du_1', chargeId: 'ch_1' });
		const match = await findGrantForStripe(db, { chargeId: 'ch_1' });
		expect(match).toEqual({ orgId: 'org-1', credits: 2000 });
	});

	test('returns null when nothing matches', async () => {
		expect(await findGrantForStripe(db, { chargeId: 'ch_none' })).toBeNull();
	});

	test('never matches consumption rows', async () => {
		await seedOrg('org-1', 5);
		await consumeCredit(db, 'org-1', 'comment-1');
		expect(await findGrantForStripe(db, { paymentIntentId: 'pi_x', chargeId: 'ch_x' })).toBeNull();
	});
});

describe('usageSummary', () => {
	test('reports remaining, lifetime and this-month usage', async () => {
		await seedOrg('org-1', 3);
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 100, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1' });
		await consumeCredit(db, 'org-1', 'c1');
		await consumeCredit(db, 'org-1', 'c2');
		// A consumption from last month must not count into this month.
		await testDb().db.insert(creditTransactions).values({
			orgId: 'org-1',
			delta: -1,
			reason: 'consume',
			refType: 'comment',
			refId: 'c-old',
			createdAt: '2000-01-15T12:00:00.000Z'
		});
		await testDb().db
			.update(organizations)
			.set({ creditsRemaining: 2 })
			.where(eq(organizations.id, 'org-1'));
		const summary = await usageSummary('org-1');
		expect(summary.remaining).toBe(2);
		expect(summary.usedLifetime).toBe(3);
		expect(summary.usedThisMonth).toBe(2);
	});

	test('aggregates in SQL — never fetches every consume row into memory', async () => {
		// The usage page must stay bounded as the ledger grows: SUM over the
		// (org_id, created_at) index, not a lifetime row fetch + JS reduce.
		await seedOrg('org-1', 100);
		await consumeCredit(db, 'org-1', 'c1');
		await testDb().db.insert(creditTransactions).values({
			orgId: 'org-1',
			delta: -7,
			reason: 'consume',
			refType: 'comment',
			refId: 'c-old',
			createdAt: '2000-01-15T12:00:00.000Z'
		});
		const statements: string[] = [];
		const client = testDb().client;
		const originalExecute = client.execute.bind(client);
		client.execute = ((stmt: unknown) => {
			const sqlText = String((stmt as { sql?: string }).sql ?? stmt);
			statements.push(sqlText);
			return originalExecute(stmt as never);
		}) as never;
		let summary: { remaining: number; usedLifetime: number; usedThisMonth: number };
		try {
			summary = await usageSummary('org-1');
		} finally {
			client.execute = originalExecute;
		}

		expect(summary).toEqual({ remaining: 99, usedLifetime: 8, usedThisMonth: 1 });
		// The consumption totals must come from SUM() queries, and NO query may
		// fetch the full consume rows just to add them up.
		expect(statements.some((s) => s.includes('SUM('))).toBe(true);
		expect(statements.some((s) => s.includes('from `credit_transactions`') && !s.includes('SUM('))).toBe(false);
	});

	test('a refund/dispute reversal never inflates used credits', async () => {
		await seedOrg('org-1', 0);
		// 100 purchased, 2 consumed, then fully refunded (the -100 reversal).
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 100, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1' });
		await consumeCredit(db, 'org-1', 'c1');
		await consumeCredit(db, 'org-1', 'c2');
		await applyLedgerDelta(db, { orgId: 'org-1', delta: -100, reason: 'refund', refType: 'charge', refId: 'ch_1' });

		const summary = await usageSummary('org-1');
		// Only the two consumption rows count as "used" — the -100 refund
		// reversal is money leaving the ledger, not moderation usage.
		expect(summary.usedLifetime).toBe(2);
		expect(summary.usedThisMonth).toBe(2);
	});

	test('monthStartIso is the first of the current UTC month', () => {
		expect(monthStartIso()).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
	});

	test('zero usage for a fresh org', async () => {
		await seedOrg('org-1', 0);
		const summary = await usageSummary('org-1');
		expect(summary).toEqual({ remaining: 0, usedLifetime: 0, usedThisMonth: 0 });
	});
});
