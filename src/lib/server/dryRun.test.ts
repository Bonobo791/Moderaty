import { and, eq } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';

import { setupTestDb, testDb } from './testdb';
import { channels } from './db/schema';
import { claimDryRun } from './dryRun';

setupTestDb(['channels']);

async function seedChannel(id: string, over: Record<string, unknown> = {}) {
	await testDb().db.insert(channels).values({ id, userId: 'user-1', orgId: 'org-1', title: id, refreshTokenEnc: 'enc', ...over });
}

async function release(id: string, orgId: string, lease: string) {
	await testDb().db.update(channels).set({ leaseExpiresAt: null }).where(and(eq(channels.id, id), eq(channels.orgId, orgId), eq(channels.leaseExpiresAt, lease)));
}

test('claims one allowance per selected feature and channel', async () => {
	await seedChannel('UC1');
	await seedChannel('UC2');

	const moderation = await claimDryRun('UC1', 'org-1', 'moderation');
	expect('lease' in moderation).toBe(true);
	if (!('lease' in moderation)) throw new Error('expected moderation claim');
	let row = (await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())!;
	expect(row.moderationDryRunUsedAt).toBeTruthy();
	expect(row.feedbackDryRunUsedAt).toBeNull();
	expect(row.leaseExpiresAt).toBe(moderation.lease);
	await release('UC1', 'org-1', moderation.lease);

	const feedback = await claimDryRun('UC1', 'org-1', 'feedback');
	expect('lease' in feedback).toBe(true);
	if (!('lease' in feedback)) throw new Error('expected feedback claim');
	row = (await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())!;
	expect(row.feedbackDryRunUsedAt).toBeTruthy();
	await release('UC1', 'org-1', feedback.lease);

	const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		expect(await claimDryRun('UC1', 'org-1', 'feedback')).toMatchObject({
			status: 409,
			error: 'Limited to 1 free feedback dry run per channel. This channel has already used it.'
		});
		expect(warning).toHaveBeenCalledWith('dry-run claim denied:', { channelId: 'UC1', feature: 'feedback', status: 409 });
	} finally {
		warning.mockRestore();
	}
	const otherChannel = await claimDryRun('UC2', 'org-1', 'feedback');
	expect('lease' in otherChannel).toBe(true);
});

test('scoped claims distinguish missing tenant, paused, busy, and used allowances without consuming them', async () => {
	await seedChannel('UC1');
	await seedChannel('UCpaused', { active: 0 });
	await seedChannel('UCbusy', { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
	const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		expect(await claimDryRun('UC1', 'org-other', 'feedback')).toMatchObject({ status: 404 });
		expect(await claimDryRun('missing', 'org-1', 'feedback')).toMatchObject({ status: 404 });
		expect(await claimDryRun('UCpaused', 'org-1', 'feedback')).toMatchObject({ status: 409, error: expect.stringContaining('paused') });
		expect(await claimDryRun('UCbusy', 'org-1', 'feedback')).toMatchObject({ status: 409, error: expect.stringContaining('busy') });
	} finally {
		warning.mockRestore();
	}
	for (const id of ['UC1', 'UCpaused', 'UCbusy']) {
		const row = await testDb().db.select().from(channels).where(eq(channels.id, id)).get();
		expect(row?.feedbackDryRunUsedAt).toBeNull();
	}
});

test('concurrent claimants produce one winner and one denial', async () => {
	await seedChannel('UC1');
	const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		const claims = await Promise.all([
			claimDryRun('UC1', 'org-1', 'feedback'),
			claimDryRun('UC1', 'org-1', 'feedback')
		]);
		expect(claims.filter((claim) => 'lease' in claim)).toHaveLength(1);
		expect(claims.filter((claim) => 'status' in claim)).toHaveLength(1);
	} finally {
		warning.mockRestore();
	}
});
