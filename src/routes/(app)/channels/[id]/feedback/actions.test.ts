// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

import { beforeEach, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { TEST_OWNER, setupTestDb, testDb } from '$lib/server/testdb';
import { channels, feedbackDigests, feedbackFindings, findingEvidence } from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({
	generateFeedbackDigest: vi.fn()
}));

// generateFeedbackDigest is the only job export mocked — enabledCategories
// stays real so the load projection is exercised end-to-end.
vi.mock('$lib/server/feedbackDigest', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/feedbackDigest')>();
	return { ...actual, generateFeedbackDigest: mocks.generateFeedbackDigest };
});

import { actions, load } from './+page.server';

setupTestDb(['finding_evidence', 'feedback_findings', 'feedback_digests', 'comments', 'channels']);

const OWNER = TEST_OWNER;

beforeEach(() => {
	mocks.generateFeedbackDigest.mockReset();
});

async function seedChannel(id: string, orgId: string | null = 'org-1', over: Record<string, unknown> = {}) {
	await testDb().db.insert(channels).values({ id, userId: 'user-1', orgId, title: `Channel ${id}`, refreshTokenEnc: 'enc', ...over });
}

function callLoad(channelId: string, user: typeof OWNER | null = OWNER) {
	return load({ params: { id: channelId }, locals: { user } } as never);
}

async function seedDigest(channelId: string, over: Record<string, unknown> = {}) {
	const [row] = await testDb().db
		.insert(feedbackDigests)
		.values({
			channelId,
			windowStart: '1970-01-01T00:00:00.000Z',
			windowEnd: '2026-01-07T00:00:00.000Z',
			status: 'complete',
			commentsClassified: 6,
			...over
		})
		.returning({ id: feedbackDigests.id });
	return row.id;
}

test('load returns the newest complete digest with findings and sanitized evidence', async () => {
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });
	const digestId = await seedDigest('UC1');
	const [finding] = await testDb().db
		.insert(feedbackFindings)
		.values({ digestId, category: 'question', summary: '3 viewers asked: when is the next video', supporterCount: 3 })
		.returning({ id: feedbackFindings.id });
	await testDb().db.insert(findingEvidence).values({
		findingId: finding.id,
		commentId: 'c1',
		sanitizedExcerpt: 'when is the next video',
		hasAbuse: 0
	});

	const data = (await callLoad('UC1')) as unknown as {
		latest: { id: number } | null;
		findings: { summary: string; evidence: { sanitizedExcerpt: string }[] }[];
		settings: { enabled: boolean; categories: string[] };
	};
	expect(data.latest?.id).toBe(digestId);
	expect(data.findings).toHaveLength(1);
	expect(data.findings[0].summary).toBe('3 viewers asked: when is the next video');
	expect(data.findings[0].evidence[0].sanitizedExcerpt).toBe('when is the next video');
	expect(data.settings).toMatchObject({ enabled: true, categories: ['question', 'criticism', 'correction', 'request'] });
	// The tenancy/secret columns must never reach the browser.
	expect(JSON.stringify(data)).not.toContain('refreshTokenEnc');
});

test('load surfaces a newer failed digest alongside the last complete one', async () => {
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });
	await seedDigest('UC1');
	await seedDigest('UC1', { status: 'failed', error: 'scoring', windowStart: '2026-01-07T00:00:00.000Z', windowEnd: '2026-01-14T00:00:00.000Z' });

	const data = (await callLoad('UC1')) as { digests: { status: string }[]; latest: { status: string } | null };
	expect(data.digests.map((d) => d.status)).toEqual(['failed', 'complete']);
	expect(data.latest?.status).toBe('complete');
});

test('load rejects a channel owned by another org with 404 — digest contents never leak', async () => {
	await seedChannel('UC1', 'org-2', { feedbackEnabled: 1 });
	await seedDigest('UC1');

	await expect(callLoad('UC1')).rejects.toMatchObject({ status: 404 });
});

test('load rejects a signed-out request with 401', async () => {
	await seedChannel('UC1');
	await expect(callLoad('UC1', null)).rejects.toMatchObject({ status: 401 });
});

function postSettings(channelId: string, fields: Record<string, string | string[]>, user: typeof OWNER | null = OWNER) {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		for (const v of Array.isArray(value) ? value : [value]) form.append(key, v);
	}
	return actions.settings({ params: { id: channelId }, request: new Request('http://localhost/', { method: 'POST', body: form }), locals: { user } } as never);
}

test('settings persists enabled, cadence, categories, and threshold', async () => {
	await seedChannel('UC1');
	const res = await postSettings('UC1', {
		enabled: 'on',
		cadence: 'per_100',
		category: ['request', 'question'], // reversed — stored in canonical order
		threshold: '5'
	});
	expect(res).toMatchObject({ ok: true, scope: 'settings' });
	const ch = await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get();
	expect(ch).toMatchObject({
		feedbackEnabled: 1,
		feedbackCadence: 'per_100',
		feedbackCategories: 'question,request',
		feedbackThreshold: 5
	});
});

test.each([{ cadence: 'daily' }, { cadence: 'hourly' }, { cadence: '' }])(
	'settings rejects cadence "$cadence" with 400 and changes nothing',
	async ({ cadence }) => {
		await seedChannel('UC1');
		const res = await postSettings('UC1', { cadence, category: 'question', threshold: '3' });
		expect(res).toMatchObject({ status: 400, data: { scope: 'settings' } });
		const ch = await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get();
		expect(ch?.feedbackCadence).toBeNull();
	}
);

test('settings rejects a forged category value loudly', async () => {
	await seedChannel('UC1');
	const res = await postSettings('UC1', { cadence: 'weekly', category: ['question', 'hate'], threshold: '3' });
	expect(res).toMatchObject({ status: 400, data: { scope: 'settings', error: 'Unknown feedback category.' } });
});

test('settings rejects an empty category mask — a digest with no categories is meaningless', async () => {
	await seedChannel('UC1');
	const res = await postSettings('UC1', { cadence: 'weekly', threshold: '3' });
	expect(res).toMatchObject({ status: 400, data: { scope: 'settings' } });
});

test.each([{ t: '1' }, { t: '11' }, { t: '2.5' }, { t: 'x' }])(
	'settings rejects threshold "$t" with 400',
	async ({ t }) => {
		await seedChannel('UC1');
		const res = await postSettings('UC1', { cadence: 'weekly', category: 'question', threshold: t });
		expect(res).toMatchObject({ status: 400, data: { scope: 'settings' } });
	}
);

test('settings rejects a cross-org channel with 404 and changes nothing', async () => {
	await seedChannel('UC1', 'org-2');
	// ownedChannel gates first — cross-org is a thrown 404 before any field parse.
	await expect(
		postSettings('UC1', { enabled: 'on', cadence: 'weekly', category: 'question', threshold: '3' })
	).rejects.toMatchObject({ status: 404 });
	const ch = await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get();
	expect(ch?.feedbackEnabled).toBeNull();
});

test('generate runs a forced digest and echoes the outcome', async () => {
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });
	mocks.generateFeedbackDigest.mockResolvedValue({ status: 'complete', findings: 2, commentsClassified: 6 });

	const res = await actions.generate({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);
	expect(mocks.generateFeedbackDigest).toHaveBeenCalledWith('UC1', { force: true, deadline: expect.any(Number) });
	expect(res).toMatchObject({ ok: true, scope: 'digest' });
});

test('generate refuses a disabled channel before calling the job', async () => {
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 0 });
	const res = await actions.generate({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);
	expect(res).toMatchObject({ status: 400 });
	expect(mocks.generateFeedbackDigest).not.toHaveBeenCalled();
});

test('generate maps a failed run to a loud 502, not a silent success', async () => {
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });
	mocks.generateFeedbackDigest.mockResolvedValue({ status: 'failed', reason: 'scoring' });
	const res = await actions.generate({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);
	expect(res).toMatchObject({ status: 502, data: { scope: 'digest' } });
});

test('generate maps a deferred run to a 409 the UI can show', async () => {
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });
	mocks.generateFeedbackDigest.mockResolvedValue({ status: 'deferred', reason: 'credits' });
	const res = await actions.generate({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);
	expect(res).toMatchObject({ status: 409, data: { scope: 'digest' } });
});

test('generate rejects a cross-org channel with 404', async () => {
	await seedChannel('UC1', 'org-2', { feedbackEnabled: 1 });
	await expect(
		actions.generate({ params: { id: 'UC1' }, locals: { user: OWNER } } as never)
	).rejects.toMatchObject({ status: 404 });
	expect(mocks.generateFeedbackDigest).not.toHaveBeenCalled();
});

// Feedback digests spend org credits (one per classified comment on metered
// orgs) — arming or triggering that spend is owner-only, same as every other
// money-moving action (codeant security finding).
const MEMBER = { ...OWNER, orgRole: 'member' as const };

test('settings rejects a non-owner member with 403 — arming credit spend is owner-only', async () => {
	await seedChannel('UC1');
	await expect(
		postSettings('UC1', { enabled: 'on', cadence: 'weekly', category: 'question', threshold: '3' }, MEMBER)
	).rejects.toMatchObject({ status: 403 });
	const ch = await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get();
	expect(ch?.feedbackEnabled).toBeNull();
});

test('generate rejects a non-owner member with 403 before calling the job', async () => {
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });
	await expect(
		actions.generate({ params: { id: 'UC1' }, locals: { user: MEMBER } } as never)
	).rejects.toMatchObject({ status: 403 });
	expect(mocks.generateFeedbackDigest).not.toHaveBeenCalled();
});
