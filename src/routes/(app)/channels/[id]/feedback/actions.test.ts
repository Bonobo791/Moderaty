import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { TEST_OWNER, setupTestDb, testDb } from '$lib/server/testdb';
import { encrypt } from '$lib/server/crypto';
import { channels, comments, feedbackDigests, feedbackFindings, feedbackHistoryComments, findingEvidence, organizations, stripeSubscriptionPeriods } from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({
	env: { DRY_RUN: 'false', ENCRYPTION_KEY: 'feedback-actions-test-key' } as Record<string, string | undefined>,
	generateFeedbackDigest: vi.fn(),
	previewFeedbackDigest: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

// generateFeedbackDigest is the only job export mocked — enabledCategories
// stays real so the load projection is exercised end-to-end.
vi.mock('$lib/server/feedbackDigest', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/feedbackDigest')>();
	return { ...actual, generateFeedbackDigest: mocks.generateFeedbackDigest, previewFeedbackDigest: mocks.previewFeedbackDigest };
});

import { actions, load } from './+page.server';

setupTestDb(['finding_evidence', 'feedback_findings', 'feedback_digests', 'feedback_history_comments', 'comments', 'channels', 'organizations', 'stripe_subscription_periods']);

const OWNER = TEST_OWNER;

// Distinct created_at per seeded row — identical defaults make the page's
// newest-first ordering rely on a tie-break that isn't there (cubic).
let digestSeq = 0;

beforeEach(async () => {
	mocks.env.DRY_RUN = 'false';
	mocks.generateFeedbackDigest.mockReset();
	mocks.previewFeedbackDigest.mockReset();
	await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Organization 1', plan: 'free', creditsRemaining: 100 });
});

afterEach(() => vi.restoreAllMocks());

async function seedChannel(id: string, orgId: string | null = 'org-1', over: Record<string, unknown> = {}) {
	await testDb().db.insert(channels).values({ id, userId: 'user-1', orgId, title: `Channel ${id}`, refreshTokenEnc: 'enc', ...over });
}

function callLoad(channelId: string, user: typeof OWNER | null = OWNER, query = '') {
	return load({
		params: { id: channelId },
		locals: { user },
		url: new URL(`http://localhost/channels/${channelId}/feedback${query ? `?${query}` : ''}`)
	} as never);
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
			createdAt: `2026-01-01T00:${String(digestSeq++ % 60).padStart(2, '0')}:00.000Z`,
			...over
		})
		.returning({ id: feedbackDigests.id });
	return row.id;
}

test('load returns the newest complete digest with findings and sanitized evidence', async () => {
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });
	const rawSource = 'raw source text must never reach the default load';
	await testDb().db.insert(comments).values({
		id: 'c1',
		channelId: 'UC1',
		text: rawSource,
		publishedAt: '2026-01-01T00:00:00.000Z',
		status: 'approved',
		decidedBy: 'ai'
	});
	const digestId = await seedDigest('UC1');
	const [finding] = await testDb().db
		.insert(feedbackFindings)
		.values({ digestId, category: 'question', summary: '3 comments asked: when is the next video', supporterCount: 3 })
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
	expect(data.findings[0].summary).toBe('3 comments asked: when is the next video');
	expect(data.findings[0].evidence[0].sanitizedExcerpt).toBe('when is the next video');
	expect(data.settings).toMatchObject({ enabled: true, categories: ['question', 'criticism', 'correction', 'request'] });
	// The default load stays concealed-only: neither secrets nor raw source text reach the browser.
	expect(JSON.stringify(data)).not.toContain('refreshTokenEnc');
	expect(JSON.stringify(data)).not.toContain(rawSource);
});

test('load exposes only history activity and preview-use state, never continuation tokens or raw text', async () => {
	await seedChannel('UC1', 'org-1', {
		feedbackEnabled: 1,
		feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z',
		feedbackHistoryPageToken: 'private-history-token',
		feedbackDryRunUsedAt: '2026-01-01T00:00:00.000Z'
	});
	await testDb().db.insert(feedbackHistoryComments).values({ id: 'private-id', channelId: 'UC1', text: 'private historical text', publishedAt: '2025-01-02T00:00:00.000Z' });

	const data = await callLoad('UC1');

	expect(data).toMatchObject({ history: { active: true, boundary: '2025-01-01T00:00:00.000Z' }, dryRunUsed: true });
	expect(JSON.stringify(data)).not.toContain('private-history-token');
	expect(JSON.stringify(data)).not.toContain('private-id');
	expect(JSON.stringify(data)).not.toContain('private historical text');
});

test('load surfaces a newer failed digest alongside the last complete one', async () => {
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });
	await seedDigest('UC1');
	await seedDigest('UC1', { status: 'failed', error: 'scoring', windowStart: '2026-01-07T00:00:00.000Z', windowEnd: '2026-01-14T00:00:00.000Z' });

	const data = (await callLoad('UC1')) as { digests: { status: string }[]; latest: { status: string } | null };
	expect(data.digests.map((d) => d.status)).toEqual(['failed', 'complete']);
	expect(data.latest?.status).toBe('complete');
});

test('load still finds the last complete digest when newer failed rows fill the history', async () => {
	// The 10-row history list is capped — a streak of failures must not bury
	// the last complete digest and make the page claim none exists (codex).
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });
	const completeId = await seedDigest('UC1');
	for (let i = 0; i < 11; i++) {
		await seedDigest('UC1', { status: 'failed', error: 'scoring', windowStart: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`, windowEnd: `2026-03-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` });
	}

	const data = (await callLoad('UC1')) as { latest: { id: number; status: string } | null };
	expect(data.latest).toMatchObject({ id: completeId, status: 'complete' });
});

test('?digest= selects an earlier complete digest and exposes its paid findings', async () => {
	// A multi-page history drain produces one complete digest per page — the
	// page must expose every batch's findings, not just the newest (codex).
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });
	const olderId = await seedDigest('UC1', { windowEnd: '2025-12-01T00:00:00.000Z' });
	const [olderFinding] = await testDb().db
		.insert(feedbackFindings)
		.values({ digestId: olderId, category: 'question', summary: 'page-one finding', supporterCount: 4 })
		.returning({ id: feedbackFindings.id });
	await testDb().db.insert(findingEvidence).values({ findingId: olderFinding.id, commentId: 'c1', sanitizedExcerpt: 'old evidence', hasAbuse: 0 });
	const newerId = await seedDigest('UC1');
	const [newerFinding] = await testDb().db
		.insert(feedbackFindings)
		.values({ digestId: newerId, category: 'request', summary: 'page-two finding', supporterCount: 2 })
		.returning({ id: feedbackFindings.id });
	await testDb().db.insert(findingEvidence).values({ findingId: newerFinding.id, commentId: 'c2', sanitizedExcerpt: 'new evidence', hasAbuse: 0 });

	const selected = (await callLoad('UC1', OWNER, `digest=${olderId}`)) as unknown as {
		latest: { id: number } | null;
		selected: { id: number } | null;
		findings: { summary: string }[];
	};
	expect(selected.latest?.id).toBe(newerId);
	expect(selected.selected?.id).toBe(olderId);
	expect(selected.findings.map((f) => f.summary)).toEqual(['page-one finding']);

	// No param: the newest complete digest is the default selection.
	const def = (await callLoad('UC1')) as unknown as { selected: { id: number } | null; findings: { summary: string }[] };
	expect(def.selected?.id).toBe(newerId);
	expect(def.findings.map((f) => f.summary)).toEqual(['page-two finding']);
});

test('a forged or stale ?digest= id falls back to the latest complete digest', async () => {
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });
	await seedChannel('UC2', 'org-1', { feedbackEnabled: 1 });
	const foreignId = await seedDigest('UC2');
	const ownId = await seedDigest('UC1');
	const failedId = await seedDigest('UC1', { status: 'failed', error: 'scoring' });

	for (const query of [`digest=${foreignId}`, `digest=${failedId}`, 'digest=abc', 'digest=99999']) {
		const data = (await callLoad('UC1', OWNER, query)) as unknown as { selected: { id: number } | null };
		expect(data.selected?.id).toBe(ownId);
	}
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

function postSettings(
	channelId: string,
	fields: Record<string, string | string[]>,
	user: (Omit<typeof OWNER, 'orgRole'> & { orgRole: string }) | null = OWNER
) {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		for (const v of Array.isArray(value) ? value : [value]) form.append(key, v);
	}
	return actions.settings({ params: { id: channelId }, request: new Request('http://localhost/', { method: 'POST', body: form }), locals: { user } } as never);
}

function postFeedbackAction(
	action: 'analyzeHistory' | 'dryRun',
	channelId: string,
	fields: Record<string, string>,
	user: (Omit<typeof OWNER, 'orgRole'> & { orgRole: string }) | null = OWNER
) {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return actions[action]({ params: { id: channelId }, request: new Request('http://localhost/', { method: 'POST', body: form }), locals: { user } } as never);
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

test('generate reports that an incomplete historical batch continues under cron on manual cadence', async () => {
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1, feedbackCadence: 'manual', feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z' });
	mocks.generateFeedbackDigest.mockResolvedValue({ status: 'complete', findings: 1, commentsClassified: 4, historyRemaining: true });

	const result = await actions.generate({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);

	expect(result).toMatchObject({ ok: true, scope: 'digest', message: expect.stringContaining('Historical analysis continues in the background on the next cron tick.') });
});

test('generate explains an empty history page continues from its next cron checkpoint', async () => {
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1, feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z' });
	mocks.generateFeedbackDigest.mockResolvedValue({ status: 'empty', historyRemaining: true });

	const result = await actions.generate({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);

	expect(result).toMatchObject({ ok: true, scope: 'digest', message: 'This history page was scanned. The next page continues on the next cron tick.' });
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
	expect(JSON.stringify(res)).toContain('cron');
});

test('a deferred run on manual cadence never promises a cron retry', async () => {
	// Manual cadence means cron never picks this channel — telling the user
	// it "will retry on the next cron tick" is a lie (codex).
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1, feedbackCadence: 'manual' });
	mocks.generateFeedbackDigest.mockResolvedValue({ status: 'deferred', reason: 'deadline' });
	const res = await actions.generate({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);
	expect(res).toMatchObject({ status: 409, data: { scope: 'digest' } });
	expect(JSON.stringify(res)).not.toContain('cron');
	expect(JSON.stringify(res)).toContain('Generate now');
});

test('generate claims the channel lease — a channel mid-scan returns 409 without calling the job', async () => {
	// Without the claim, a manual run can overlap a cron digest and the
	// failure path can clobber the concurrent success (codex).
	await seedChannel('UC1', 'org-1', {
		feedbackEnabled: 1,
		leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
	});
	const res = await actions.generate({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);
	expect(res).toMatchObject({ status: 409, data: { scope: 'digest' } });
	expect(mocks.generateFeedbackDigest).not.toHaveBeenCalled();
});

test('generate releases its lease when the run finishes', async () => {
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });
	mocks.generateFeedbackDigest.mockResolvedValue({ status: 'complete', findings: 0, commentsClassified: 2 });
	await actions.generate({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);
	const ch = await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get();
	expect(ch?.leaseExpiresAt).toBeNull();
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
const ADMIN = { ...OWNER, orgRole: 'admin' as const };

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

test('analyzeHistory queues one independent feedback checkpoint without running moderation synchronously', async () => {
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1, cursor: '2026-06-01T00:00:00.000Z', nextPageToken: 'live-page' });

	const result = await postFeedbackAction('analyzeHistory', 'UC1', { months: '3' });

	expect(result).toMatchObject({ ok: true, scope: 'history', message: 'Historical feedback analysis queued. Cron processes up to 100 comments per batch without changing moderation.' });
	const channel = (await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())!;
	expect(Date.parse(channel.feedbackHistoryBoundary ?? '')).toBeGreaterThan(Date.now() - 91 * 24 * 60 * 60 * 1000);
	expect(Date.parse(channel.feedbackHistoryBoundary ?? '')).toBeLessThanOrEqual(Date.now() - 89 * 24 * 60 * 60 * 1000);
	expect(channel.feedbackHistoryPageToken).toBeNull();
	// A fresh scan id per request scopes this run's charge anchors — the
	// value that lets an identical re-request debit again later.
	expect(channel.feedbackHistoryScanId).toEqual(expect.any(String));
	expect(channel.cursor).toBe('2026-06-01T00:00:00.000Z');
	expect(channel.nextPageToken).toBe('live-page');
	expect(mocks.generateFeedbackDigest).not.toHaveBeenCalled();
});

test('analyzeHistory will not reset an active feedback job or charge it again', async () => {
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1, feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z', feedbackHistoryScanId: 'scan-live', feedbackHistoryPageToken: 'page-2' });

	const result = await postFeedbackAction('analyzeHistory', 'UC1', { months: '1' });

	expect(result).toMatchObject({ status: 409, data: { scope: 'history' } });
	expect(await testDb().db.select({ id: channels.id }).from(channels).where(and(eq(channels.id, 'UC1'), eq(channels.feedbackHistoryBoundary, '2025-01-01T00:00:00.000Z'), eq(channels.feedbackHistoryScanId, 'scan-live'), eq(channels.feedbackHistoryPageToken, 'page-2'))).all()).toHaveLength(1);
});

test('a completed feedback history scan can be re-requested — the new run mints its own scan id', async () => {
	// The owner may re-analyze the identical window as often as they like:
	// each accepted request plants a fresh nonce so this run's charges are
	// new anchors rather than replays of the previous scan's (I4 billing).
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });

	const first = await postFeedbackAction('analyzeHistory', 'UC1', { months: '3' });
	expect(first).toMatchObject({ ok: true });
	const firstScanId = (await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())!.feedbackHistoryScanId;
	expect(firstScanId).toEqual(expect.any(String));

	// The drain finished: completion clears boundary, page token, and nonce.
	await testDb().db.update(channels)
		.set({ feedbackHistoryBoundary: null, feedbackHistoryPageToken: null, feedbackHistoryScanId: null })
		.where(eq(channels.id, 'UC1'));

	const second = await postFeedbackAction('analyzeHistory', 'UC1', { months: '3' });
	expect(second).toMatchObject({ ok: true });
	const secondScanId = (await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())!.feedbackHistoryScanId;
	expect(secondScanId).toEqual(expect.any(String));
	expect(secondScanId).not.toBe(firstScanId);
});

test.each([
	{ label: 'dry-run deployment', dryRun: 'true', active: 1, enabled: 1 },
	{ label: 'disabled feedback', dryRun: 'false', active: 1, enabled: 0 },
	{ label: 'paused channel', dryRun: 'false', active: 0, enabled: 1 }
])('analyzeHistory rejects a $label before checkpointing', async ({ dryRun, active, enabled }) => {
	mocks.env.DRY_RUN = dryRun;
	await seedChannel('UC1', 'org-1', { active, feedbackEnabled: enabled });

	const result = await postFeedbackAction('analyzeHistory', 'UC1', { months: '3' });

	expect(result).toMatchObject({ status: 409, data: { scope: 'history' } });
	expect((await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())?.feedbackHistoryBoundary).toBeNull();
});

test('analyzeHistory rejects invalid windows and callers without owner access', async () => {
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });
	expect(await postFeedbackAction('analyzeHistory', 'UC1', { months: 'all' })).toMatchObject({ status: 400 });
	await expect(postFeedbackAction('analyzeHistory', 'UC1', { months: '3' }, null)).rejects.toMatchObject({ status: 401 });
	await expect(postFeedbackAction('analyzeHistory', 'UC1', { months: '3' }, MEMBER)).rejects.toMatchObject({ status: 403 });
	await expect(postFeedbackAction('analyzeHistory', 'UC1', { months: '3' }, ADMIN)).rejects.toMatchObject({ status: 403 });
	mocks.env.DRY_RUN = 'invalid';
	await expect(postFeedbackAction('analyzeHistory', 'UC1', { months: '3' })).rejects.toMatchObject({ status: 500 });
	expect((await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())?.feedbackHistoryBoundary).toBeNull();
	mocks.env.DRY_RUN = 'false';
	await seedChannel('UC2', 'org-2', { feedbackEnabled: 1 });
	await expect(postFeedbackAction('analyzeHistory', 'UC2', { months: '3' })).rejects.toMatchObject({ status: 404 });
	expect(mocks.generateFeedbackDigest).not.toHaveBeenCalled();
});

async function updateOrg(orgId: string, values: Partial<typeof organizations.$inferInsert>) {
	await testDb().db.update(organizations).set(values).where(eq(organizations.id, orgId));
}

async function historyBoundaryOf(id: string) {
	return (await testDb().db.select().from(channels).where(eq(channels.id, id)).get())?.feedbackHistoryBoundary;
}

async function seedSubscriptionPeriod(options: { invoiceId: string; status: string; periodEnd?: 'past' | 'future'; includedCredits?: number; consumedCredits?: number }) {
	const now = Date.now();
	await testDb().db.insert(stripeSubscriptionPeriods).values({
		orgId: 'org-1',
		subscriptionId: `sub-${options.invoiceId}`,
		invoiceId: options.invoiceId,
		periodKey: options.invoiceId,
		periodStart: new Date(now - 86_400_000).toISOString(),
		periodEnd: new Date(options.periodEnd === 'past' ? now - 1 : now + 86_400_000).toISOString(),
		includedCredits: options.includedCredits ?? 100,
		consumedCredits: options.consumedCredits ?? 0,
		status: options.status
	});
}

// History analysis spends real money per classified comment — the same
// purchase/key gate as overview history must run BEFORE the checkpoint is
// planted, or a never-paying org drains the deployment key forever (codex).
test.each([
	{ name: 'a null balance', org: { creditsRemaining: null } },
	{ name: 'a zero balance', org: { creditsRemaining: 0 } },
	{ name: 'a Stripe customer with no completed purchase', org: { stripeCustomerId: 'cus-abandoned', creditsRemaining: null } },
	{
		name: 'an exhausted paid subscription period',
		org: { plan: 'hosted', creditsRemaining: null },
		period: { invoiceId: 'exhausted-period', status: 'paid', includedCredits: 50, consumedCredits: 50 }
	}
])('analyzeHistory denies an org with $name before checkpointing', async ({ org, period }) => {
	await updateOrg('org-1', org);
	if (period) await seedSubscriptionPeriod(period);
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		const res = (await postFeedbackAction('analyzeHistory', 'UC1', { months: '3' })) as { status: number; data: Record<string, unknown> };

		expect(res).toMatchObject({
			status: 402,
			data: { scope: 'history', historyAccess: 'purchase', error: expect.stringContaining('purchase credits, subscribe, or buy the lifetime deal') }
		});
		expect(await historyBoundaryOf('UC1')).toBeNull();
		expect(warnSpy).toHaveBeenCalledWith('feedback history analysis blocked:', { channelId: 'UC1', orgId: 'org-1', reason: 'purchase' });
	} finally {
		warnSpy.mockRestore();
	}
});

test.each([
	{ name: 'missing', openaiKeyEnc: null },
	{ name: 'encrypted whitespace', openaiKeyEnc: encrypt(' \t\n ') }
])('a lifetime org with a $name key cannot queue feedback history', async ({ openaiKeyEnc }) => {
	await updateOrg('org-1', { plan: 'lifetime', creditsRemaining: null, openaiKeyEnc });
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });

	const res = await postFeedbackAction('analyzeHistory', 'UC1', { months: '3' });

	expect(res).toMatchObject({
		status: 402,
		data: { scope: 'history', historyAccess: 'key', error: expect.stringContaining('your own OpenAI API key') }
	});
	expect(await historyBoundaryOf('UC1')).toBeNull();
});

test('a lifetime org with a CORRUPT stored key gets a loud 503 — not "add a key"', async () => {
	await updateOrg('org-1', { plan: 'lifetime', creditsRemaining: null, openaiKeyEnc: 'not-valid-encrypted-data' });
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		const res = await postFeedbackAction('analyzeHistory', 'UC1', { months: '3' });

		expect(res).toMatchObject({
			status: 503,
			data: { scope: 'history', error: 'Could not verify access to feedback history analysis. Please try again.' }
		});
		expect(await historyBoundaryOf('UC1')).toBeNull();
	} finally {
		errorSpy.mockRestore();
	}
});

test('a lifetime org with a stored key queues feedback history', async () => {
	await updateOrg('org-1', { plan: 'lifetime', creditsRemaining: null, openaiKeyEnc: encrypt('synthetic-lifetime-key') });
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });

	const res = await postFeedbackAction('analyzeHistory', 'UC1', { months: '3' });

	expect(res).toMatchObject({ ok: true, scope: 'history' });
	expect(await historyBoundaryOf('UC1')).not.toBeNull();
});

test('a failing access check is a loud 503, never a silently planted checkpoint', async () => {
	await testDb().db.delete(organizations).where(eq(organizations.id, 'org-1'));
	await seedChannel('UC1', 'org-1', { feedbackEnabled: 1 });
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		const res = await postFeedbackAction('analyzeHistory', 'UC1', { months: '3' });

		expect(res).toMatchObject({ status: 503, data: { scope: 'history' } });
		expect(await historyBoundaryOf('UC1')).toBeNull();
		expect(errorSpy).toHaveBeenCalledWith('feedback history access check failed:', 'UC1', expect.any(Error));
	} finally {
		errorSpy.mockRestore();
	}
});

test('feedback dry run returns a sanitized preview, claims its one-time allowance, and denies repeats', async () => {
	mocks.env.DRY_RUN = 'true';
	await seedChannel('UC1');
	const preview = { commentsClassified: 2, commentsFailed: 1, pooled: 1, hasMore: true, findings: [{ category: 'question', summary: '2 viewers asked about timing', supporterCount: 2, evidence: [{ sanitizedExcerpt: 'When is it?', hasAbuse: 0 }] }] };
	mocks.previewFeedbackDigest.mockResolvedValue(preview);

	const result = await postFeedbackAction('dryRun', 'UC1', { months: 'all' });

	expect(mocks.previewFeedbackDigest).toHaveBeenCalledWith('UC1', {
		boundary: '1970-01-01T00:00:00.000Z',
		deadline: expect.any(Number),
		// Bound to the claimed row — a delete/reconnect on the same channel id
		// must abort the preview instead of running the new connector (cubic).
		claim: { orgId: 'org-1', refreshTokenEnc: 'enc', leaseExpiresAt: expect.any(String) }
	});
	expect(result).toMatchObject({ ok: true, scope: 'feedbackDryRun', dryRunUsed: true, preview, message: 'Free feedback dry run complete. Limited to 1 per channel; no credits used.' });
	let channel = (await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())!;
	expect(channel.feedbackDryRunUsedAt).toBeTruthy();
	expect(channel.leaseExpiresAt).toBeNull();

	const denied = await postFeedbackAction('dryRun', 'UC1', { months: '3' });
	expect(denied).toMatchObject({ status: 409, data: { scope: 'feedbackDryRun', error: expect.stringContaining('Limited to 1 free feedback dry run') } });
	expect(mocks.previewFeedbackDigest).toHaveBeenCalledTimes(1);
	channel = (await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())!;
	expect(channel.feedbackDryRunUsedAt).toBeTruthy();
	expect(channel.leaseExpiresAt).toBeNull();
});

test('a failed feedback preview consumes its allowance and returns only a sanitized error', async () => {
	await seedChannel('UC1');
	mocks.previewFeedbackDigest.mockRejectedValue(new Error('private provider response token-123'));
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		const result = await postFeedbackAction('dryRun', 'UC1', { months: '3' });
		expect(result).toMatchObject({ status: 502, data: { scope: 'feedbackDryRun', attempted: true, error: expect.stringContaining('one free preview') } });
		expect(JSON.stringify(result)).not.toContain('token-123');
		expect(errorSpy).toHaveBeenCalledWith('feedback dry run failed for channel:', 'UC1', expect.any(Error));
		expect((await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())).toMatchObject({ feedbackDryRunUsedAt: expect.any(String), leaseExpiresAt: null });
		expect(await postFeedbackAction('dryRun', 'UC1', { months: '3' })).toMatchObject({ status: 409 });
		expect(mocks.previewFeedbackDigest).toHaveBeenCalledTimes(1);
	} finally {
		errorSpy.mockRestore();
	}
});

test('feedback dry run validates access and inputs before claiming its allowance', async () => {
	await seedChannel('UC1');
	await expect(postFeedbackAction('dryRun', 'UC1', { months: '2' }, null)).rejects.toMatchObject({ status: 401 });
	await expect(postFeedbackAction('dryRun', 'UC1', { months: '3' }, MEMBER)).rejects.toMatchObject({ status: 403 });
	await expect(postFeedbackAction('dryRun', 'UC1', { months: '3' }, ADMIN)).rejects.toMatchObject({ status: 403 });
	expect(await postFeedbackAction('dryRun', 'UC1', { months: '7' })).toMatchObject({ status: 400 });
	mocks.env.DRY_RUN = 'invalid';
	await expect(postFeedbackAction('dryRun', 'UC1', { months: '3' })).rejects.toMatchObject({ status: 500 });
	await seedChannel('UCpaused', 'org-1', { active: 0 });
	mocks.env.DRY_RUN = 'false';
	expect(await postFeedbackAction('dryRun', 'UCpaused', { months: '3' })).toMatchObject({ status: 409 });
	await seedChannel('UC2', 'org-2');
	await expect(postFeedbackAction('dryRun', 'UC2', { months: '3' })).rejects.toMatchObject({ status: 404 });
	for (const id of ['UC1', 'UCpaused', 'UC2']) {
		expect((await testDb().db.select().from(channels).where(eq(channels.id, id)).get())?.feedbackDryRunUsedAt).toBeNull();
	}
	expect(mocks.previewFeedbackDigest).not.toHaveBeenCalled();
});

function postReveal(
	channelId: string,
	evidenceId: string,
	user: typeof OWNER | typeof MEMBER | null = OWNER,
	confirmedAbuse?: string
) {
	const form = new FormData();
	form.set('evidenceId', evidenceId);
	if (confirmedAbuse !== undefined) form.set('confirmedAbuse', confirmedAbuse);
	return actions.reveal({
		params: { id: channelId },
		request: new Request('http://localhost/', { method: 'POST', body: form }),
		locals: { user }
	} as never);
}

async function seedRevealEvidence(channelId: string, commentId: string, text: string, hasAbuse = 1) {
	await testDb().db.insert(comments).values({
		id: commentId,
		channelId,
		authorChannelId: 'author-secret',
		authorName: 'Author Secret',
		text,
		publishedAt: '2026-01-01T00:00:00.000Z',
		status: 'approved',
		decidedBy: 'ai'
	});
	const digestId = await seedDigest(channelId);
	const [finding] = await testDb().db
		.insert(feedbackFindings)
		.values({ digestId, category: 'criticism', summary: 'Two viewers reported audio trouble', supporterCount: 2 })
		.returning({ id: feedbackFindings.id });
	const [evidence] = await testDb().db
		.insert(findingEvidence)
		.values({ findingId: finding.id, commentId, sanitizedExcerpt: 'audio trouble', hasAbuse })
		.returning({ id: findingEvidence.id });
	return evidence.id;
}

test('historical-only evidence stays concealed on load and reveals only after the abusive-content confirmation', async () => {
	await seedChannel('UC1');
	const raw = 'historical source with abusive wording';
	await testDb().db.insert(feedbackHistoryComments).values({ id: 'history-c1', channelId: 'UC1', text: raw, publishedAt: '2025-01-01T00:00:00.000Z' });
	const digestId = await seedDigest('UC1');
	const [finding] = await testDb().db.insert(feedbackFindings).values({ digestId, category: 'criticism', summary: 'Two viewers reported a problem', supporterCount: 2 }).returning({ id: feedbackFindings.id });
	const [evidence] = await testDb().db.insert(findingEvidence).values({ findingId: finding.id, commentId: 'history-c1', sanitizedExcerpt: 'concealed excerpt', hasAbuse: 1 }).returning({ id: findingEvidence.id });

	const loaded = await callLoad('UC1');
	expect(JSON.stringify(loaded)).not.toContain(raw);
	expect(await postReveal('UC1', String(evidence.id))).toEqual({ scope: 'reveal', evidenceId: evidence.id, confirmationRequired: true });
	await expect(postReveal('UC1', String(evidence.id), OWNER, 'yes')).resolves.toEqual({ scope: 'reveal', evidenceId: evidence.id, text: raw });
});

test('abusive evidence requires explicit confirmation before returning the raw comment', async () => {
	await seedChannel('UC1');
	const raw = 'raw abusive original text';
	const evidenceId = await seedRevealEvidence('UC1', 'c1', raw);

	const result = await postReveal('UC1', String(evidenceId));

	expect(result).toEqual({ scope: 'reveal', evidenceId, confirmationRequired: true });
	expect(JSON.stringify(result)).not.toContain(raw);
	expect(JSON.stringify(result)).not.toContain('Author Secret');
	expect(JSON.stringify(result)).not.toContain('author-secret');
});

test('a reveal returns the text its digest classified when a later scan refreshed the snapshot (codex)', async () => {
	// Scan-a analyzed 'OLD TEXT' and stored a digest; scan-b re-ran over the
	// edited comment and refreshed the shared feedback_history_comments row
	// to 'NEW TEXT'. The older digest is still selectable on the page — its
	// evidence row pins the text it actually classified, or revealing it
	// shows words the classifier never saw.
	await seedChannel('UC1');
	const digestId = await seedDigest('UC1');
	const [finding] = await testDb().db
		.insert(feedbackFindings)
		.values({ digestId, category: 'question', summary: 'A viewer asked about timing', supporterCount: 1 })
		.returning({ id: feedbackFindings.id });
	const [evidence] = await testDb().db
		.insert(findingEvidence)
		.values({ findingId: finding.id, commentId: 'edited', sanitizedExcerpt: 'concealed excerpt', hasAbuse: 0, sourceText: 'OLD TEXT' })
		.returning({ id: findingEvidence.id });
	await testDb().db
		.insert(feedbackHistoryComments)
		.values({ id: 'edited', channelId: 'UC1', text: 'NEW TEXT', publishedAt: '2025-01-01T00:00:00.000Z', scanId: 'scan-b' });

	await expect(postReveal('UC1', String(evidence.id))).resolves.toEqual({
		scope: 'reveal',
		evidenceId: evidence.id,
		text: 'OLD TEXT'
	});
});

test('a reveal prefers the historical snapshot when the comment exists in both stores (cubic)', async () => {
	// The digest classified the snapshot's text — when moderation later
	// re-stores the same comment (possibly edited since), the reveal must
	// show what the classifier actually saw, not the drifted live row.
	await seedChannel('UC1');
	const evidenceId = await seedRevealEvidence('UC1', 'dup', 'edited live text', 0);
	await testDb().db.insert(feedbackHistoryComments).values({ id: 'dup', channelId: 'UC1', text: 'original historical text', publishedAt: '2025-01-01T00:00:00.000Z' });

	await expect(postReveal('UC1', String(evidenceId))).resolves.toEqual({
		scope: 'reveal',
		evidenceId,
		text: 'original historical text'
	});
});

test('non-abusive evidence reveals immediately without confirmation', async () => {
	await seedChannel('UC1');
	const evidenceId = await seedRevealEvidence('UC1', 'c1', 'ordinary original text', 0);

	await expect(postReveal('UC1', String(evidenceId))).resolves.toEqual({
		scope: 'reveal',
		evidenceId,
		text: 'ordinary original text'
	});
});

test('reveal returns only the raw comment text for evidence on the requested channel', async () => {
	await seedChannel('UC1');
	const evidenceId = await seedRevealEvidence('UC1', 'c1', 'raw original text');

	const result = await postReveal('UC1', String(evidenceId), OWNER, 'yes');
	expect(result).toEqual({ scope: 'reveal', evidenceId, text: 'raw original text' });
	expect(JSON.stringify(result)).not.toContain('Author Secret');
	expect(JSON.stringify(result)).not.toContain('author-secret');
});

test('reveal allows a non-owner organization member to read evidence', async () => {
	await seedChannel('UC1');
	const evidenceId = await seedRevealEvidence('UC1', 'c1', 'member-visible raw text');

	await expect(postReveal('UC1', String(evidenceId), MEMBER, 'yes')).resolves.toEqual({
		scope: 'reveal',
		evidenceId,
		text: 'member-visible raw text'
	});
});

test('reveal rejects another organization channel with 404', async () => {
	await seedChannel('UC2', 'org-2');
	const evidenceId = await seedRevealEvidence('UC2', 'c2', 'other organization text');

	await expect(postReveal('UC2', String(evidenceId))).rejects.toMatchObject({ status: 404 });
});

test('reveal does not accept evidence belonging to a different channel digest', async () => {
	await seedChannel('UC1');
	await seedChannel('UC2');
	const evidenceId = await seedRevealEvidence('UC2', 'c2', 'different channel text');
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

	const result = await postReveal('UC1', String(evidenceId));
	expect(result).toMatchObject({
		status: 404,
		data: { scope: 'reveal', evidenceId, error: 'The original comment is no longer available.' }
	});
	expect(errorSpy).toHaveBeenCalledOnce();
	errorSpy.mockRestore();
});

test.each(['1.5', '0', '-1', '9007199254740992'])(
	'reveal rejects invalid evidence id %s with 400',
	async (evidenceId) => {
		await seedChannel('UC1');
		const result = await postReveal('UC1', evidenceId);
		expect(result).toMatchObject({
			status: 400,
			data: { scope: 'reveal', error: 'Invalid evidence id.' }
		});
	}
);

test('reveal returns 404 when the source comment has been deleted', async () => {
	await seedChannel('UC1');
	const evidenceId = await seedRevealEvidence('UC1', 'c1', 'soon deleted');
	await testDb().db.delete(comments).where(eq(comments.id, 'c1'));
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

	const result = await postReveal('UC1', String(evidenceId));
	expect(result).toMatchObject({
		status: 404,
		data: { scope: 'reveal', evidenceId, error: 'The original comment is no longer available.' }
	});
	expect(errorSpy).toHaveBeenCalledOnce();
	errorSpy.mockRestore();
});

test('a failed assertion does not leave console.error mocked for the next test', () => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	expect(() => expect('actual').toBe('expected')).toThrow();
});

test('console.error spies are restored before the next test', () => {
	expect(vi.isMockFunction(console.error)).toBe(false);
});
