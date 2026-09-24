import { beforeEach, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { TEST_OWNER, setupTestDb, testDb } from '$lib/server/testdb';
import { channels, comments, feedbackDigests, feedbackFindings, findingEvidence } from '$lib/server/db/schema';

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

// Distinct created_at per seeded row — identical defaults make the page's
// newest-first ordering rely on a tie-break that isn't there (cubic).
let digestSeq = 0;

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

function postReveal(channelId: string, evidenceId: string, user: typeof OWNER | typeof MEMBER | null = OWNER) {
	const form = new FormData();
	form.set('evidenceId', evidenceId);
	return actions.reveal({
		params: { id: channelId },
		request: new Request('http://localhost/', { method: 'POST', body: form }),
		locals: { user }
	} as never);
}

async function seedRevealEvidence(channelId: string, commentId: string, text: string) {
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
		.values({ findingId: finding.id, commentId, sanitizedExcerpt: 'audio trouble', hasAbuse: 1 })
		.returning({ id: findingEvidence.id });
	return evidence.id;
}

test('reveal returns only the raw comment text for evidence on the requested channel', async () => {
	await seedChannel('UC1');
	const evidenceId = await seedRevealEvidence('UC1', 'c1', 'raw original text');

	const result = await postReveal('UC1', String(evidenceId));
	expect(result).toEqual({ scope: 'reveal', evidenceId, text: 'raw original text' });
	expect(JSON.stringify(result)).not.toContain('Author Secret');
	expect(JSON.stringify(result)).not.toContain('author-secret');
});

test('reveal allows a non-owner organization member to read evidence', async () => {
	await seedChannel('UC1');
	const evidenceId = await seedRevealEvidence('UC1', 'c1', 'member-visible raw text');

	await expect(postReveal('UC1', String(evidenceId), MEMBER)).resolves.toEqual({
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
