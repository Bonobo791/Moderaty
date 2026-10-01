// SSR pins for the feedback digest page: owner-only controls must not
// render for members/admins (the actions throw a bare 403 error page —
// codex), and a recorded deferral must surface as a banner instead of a
// silent "No digest yet" (codex). Render is lazy — assert on .body.

import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';

import { HISTORY_MONTH_PRESETS } from '$lib/historyWindow';
import { concealEvidence } from '$lib/server/feedbackSanitize';

import Page from './+page.svelte';

const SETTINGS = { enabled: true, cadence: 'weekly', categories: ['question', 'criticism'], threshold: 3 };

const COMPLETE_DIGEST = {
	id: 7,
	windowStart: '2026-01-01T00:00:00.000Z',
	windowEnd: '2026-02-01T00:00:00.000Z',
	status: 'complete',
	commentsClassified: 4,
	commentsFailed: 0,
	pooledCount: 1,
	creditsUsed: 4,
	error: null,
	createdAt: '2026-02-02T00:00:00.000Z'
};

function renderFeedback(data: Record<string, unknown>, form: unknown = null) {
	return render(Page, { props: { data, form } as never }).body;
}

function pageData(over: Record<string, unknown> = {}) {
	return {
		ch: { id: 'UC1', title: 'Channel UC1', active: true },
		history: { active: false, boundary: null },
		dryRunUsed: false,
		dryRunDeployment: false,
		digests: [],
		// The banner's transient row arrives independently of the paginated
		// history list — a test that wants the banner sets it explicitly.
		currentAttempt: null,
		latest: null,
		findings: [],
		settings: SETTINGS,
		orgRole: 'owner',
		...over
	};
}

describe('feedback page role gating (SSR)', () => {
	it('does not mistake feedback excluded by category settings for below-threshold themes', () => {
		const settings = { ...SETTINGS, categories: ['question'] };
		const digest = { ...COMPLETE_DIGEST, commentsClassified: 4, pooledCount: 4 };
		const preview = { commentsClassified: 4, commentsFailed: 0, pooled: 4, hasMore: false, findings: [] };
		for (const body of [
			renderFeedback(pageData({ settings, latest: digest })),
			renderFeedback(pageData({ settings }), { scope: 'feedbackDryRun', ok: true, preview })
		]) {
			expect(body).toContain('No recurring feedback to show.');
			expect(body).toContain('Themes may be below the minimum-comments threshold or in categories excluded by the feedback settings.');
			expect(body).not.toContain('No themes met');
			expect(body).not.toContain('No recurring feedback found in these comments.');
		}
	});

	it('shows an informational recovery notice and an empty state even with pooled comments', () => {
		const digest = { ...COMPLETE_DIGEST, clusteringDegraded: 1 };
		const body = renderFeedback(pageData({ latest: digest, digests: [digest] }));
		expect(body).toContain('Some comments could not be grouped reliably.');
		expect(body).toContain('No recurring feedback to show.');
		expect(body).toContain('Plus 1 other comment');
		expect(body).not.toContain('Latest digest run failed');
	});

	it('reads the recovery notice from the selected historical digest, not the latest digest', () => {
		const degraded = { ...COMPLETE_DIGEST, clusteringDegraded: 1 };
		const healthy = { ...COMPLETE_DIGEST, id: 8, clusteringDegraded: 0 };
		expect(renderFeedback(pageData({ latest: healthy, selected: degraded }))).toContain('Some comments could not be grouped reliably.');
		expect(renderFeedback(pageData({ latest: degraded, selected: healthy }))).not.toContain('Some comments could not be grouped reliably.');
		expect(renderFeedback(pageData({ latest: { ...COMPLETE_DIGEST, clusteringDegraded: null } }))).not.toContain('Some comments could not be grouped reliably.');
	});

	it('shows recovery information in an empty preview without the failed-run banner', () => {
		const body = renderFeedback(pageData(), { scope: 'feedbackDryRun', ok: true, preview: {
			commentsClassified: 3, commentsFailed: 0, clusteringDegraded: true, pooled: 3, hasMore: false, findings: []
		} });
		expect(body).toContain('Some comments could not be grouped reliably.');
		expect(body).toContain('No recurring feedback to show.');
		expect(body).toContain('role="status"');
		expect(body).not.toContain('Latest digest run failed');
	});
	it('hides Generate now and the settings form from a member — both actions 403 anyway', () => {
		const body = renderFeedback(pageData({ orgRole: 'member' }));
		expect(body).not.toContain('action="?/generate"');
		expect(body).not.toContain('action="?/settings"');
		expect(body).not.toContain('Generate now');
		// Read-only settings: a member still sees WHAT is configured.
		expect(body).toContain('Once a week');
	});

	it('renders both controls for the owner', () => {
		const body = renderFeedback(pageData());
		expect(body).toContain('action="?/generate"');
		expect(body).toContain('action="?/settings"');
	});

	it('hides the controls from admins as well — arming credit spend is owner-only', () => {
		const body = renderFeedback(pageData({ orgRole: 'admin' }));
		expect(body).not.toContain('action="?/generate"');
		expect(body).not.toContain('action="?/settings"');
	});

	it('keeps history and preview forms owner-only', () => {
		for (const role of ['owner', 'member', 'admin']) {
			const body = renderFeedback(pageData({ orgRole: role }));
			if (role === 'owner') {
				expect(body).toContain('action="?/analyzeHistory"');
				expect(body).toContain('action="?/dryRun"');
				// The one dry-run message: allowance, first-page scope, and the
				// used-on-start rule consolidated into a single note.
				expect(body).toContain('1 free feedback dry run per channel — scores only the first YouTube page (up to 100 comments) and changes no moderation state. Used when it starts, even if it fails. No credits are charged.');
			} else {
				expect(body).not.toContain('action="?/analyzeHistory"');
				expect(body).not.toContain('action="?/dryRun"');
				expect(body).not.toContain('1 free feedback dry run per channel');
			}
		}
	});

	it('both historical feedback forms use the shared month presets', () => {
		const body = renderFeedback(pageData());
		for (const months of HISTORY_MONTH_PRESETS) expect(body).toContain(`value="${months}"`);
	});

	it('disables history and feedback preview when history is active, settings are off, allowance used, or channel paused', () => {
		const activeHistory = renderFeedback(pageData({ history: { active: true, boundary: '2025-01-01T00:00:00.000Z' }, settings: { ...SETTINGS, cadence: 'manual' } }));
		expect(activeHistory).toContain('History scan in progress — the next batch runs automatically, even while digests are set to manual. No action needed.');
		expect(activeHistory).toContain('History scan in progress');

		const disabled = renderFeedback(pageData({ settings: { ...SETTINGS, enabled: false }, history: { active: true, boundary: '2025-01-01T00:00:00.000Z' }, dryRunUsed: true, ch: { id: 'UC1', title: 'Channel UC1', active: false } }));
		expect(disabled).toContain('Feedback preview already used');
		expect(disabled).toContain('1 free feedback dry run per channel');
		expect(disabled).toContain('History scan paused — resume the channel and re-enable feedback to continue from where it stopped.');
		expect(disabled).toMatch(/<button[^>]*disabled[^>]*>History scan in progress<\/button>/);
		expect(disabled).toMatch(/<button[^>]*disabled[^>]*>Feedback preview already used<\/button>/);

		const failedAttempt = renderFeedback(pageData(), { scope: 'feedbackDryRun', attempted: true, error: 'provider failure' });
		expect(failedAttempt).toContain('1 free feedback dry run per channel');
		expect(failedAttempt).toMatch(/<button[^>]*disabled[^>]*>Feedback preview already used<\/button>/);
	});

	it('renders preview findings as sanitized, read-only excerpts with a first-page disclosure', () => {
		const body = renderFeedback(pageData(), {
			scope: 'feedbackDryRun',
			ok: true,
			preview: {
				commentsClassified: 4,
				commentsFailed: 1,
				pooled: 2,
				hasMore: true,
				findings: [{
					category: 'question',
					summary: 'Three viewers asked about timing',
					supporterCount: 3,
					evidence: [{ sanitizedExcerpt: 'When is the next stream?', hasAbuse: 0 }, { sanitizedExcerpt: 'Wording concealed', hasAbuse: 1 }]
				}]
			}
		});
		expect(body).toContain('4 classified · 1 failed · 2 pooled · 0 credits used');
		// First-page disclosure now lives in the one dry-run note plus the
		// results caption — the preview never reads as a full-history scan.
		expect(body).toContain('scores only the first YouTube page (up to 100 comments)');
		expect(body).toContain('Run a history scan to cover the full window.');
		expect(body).toContain('More comments are available beyond this preview page.');
		expect(body).toContain('When is the next stream?');
		expect(body).not.toContain('action="?/reveal"');
		expect(body).not.toContain('Show original comment');
	});

	it('keeps recovered preview findings distinct when category and summary match', () => {
		const findings = ['Theme evidence', 'Original claim evidence'].map((sanitizedExcerpt) => ({
			category: 'question',
			summary: '3 comments asked: visa procedures',
			supporterCount: 3,
			evidence: [{ sanitizedExcerpt, hasAbuse: 0 }]
		}));
		const body = renderFeedback(pageData(), {
			scope: 'feedbackDryRun',
			ok: true,
			preview: {
				commentsClassified: 6, commentsFailed: 0, pooled: 0,
				hasMore: false, clusteringDegraded: true, findings
			}
		});
		expect(body.match(/question: 3 comments asked: visa procedures/g)).toHaveLength(2);
		expect(body).toContain('Theme evidence');
		expect(body).toContain('Original claim evidence');
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(source).toContain('{#each feedbackPreview.findings as finding, index (index)}');
	});

	it('renders an empty feedback preview without implying a full-history scan', () => {
		const body = renderFeedback(pageData(), {
			scope: 'feedbackDryRun',
			ok: true,
			preview: { commentsClassified: 0, commentsFailed: 0, pooled: 0, hasMore: false, findings: [] }
		});
		expect(body).toContain('No recurring feedback to show.');
		expect(body).toContain('scores only the first YouTube page (up to 100 comments)');
		expect(body).toContain('Run a history scan to cover the full window.');
	});
});

describe('feedback page deferred banner (SSR)', () => {
	it('surfaces a credit deferral instead of a silent empty state', () => {
		const deferred = { ...COMPLETE_DIGEST, id: 8, status: 'deferred', error: 'credits', creditsUsed: null };
		const body = renderFeedback(
			pageData({ orgRole: 'member', digests: [deferred], currentAttempt: deferred })
		);
		expect(body).toContain('credits');
		expect(body).not.toContain('No digest yet');
	});

	it('explains that a historical batch needs enough credits and links to Usage', () => {
		const deferred = { ...COMPLETE_DIGEST, id: 8, status: 'deferred', error: 'credits', creditsUsed: null };
		const body = renderFeedback(pageData({
			settings: { ...SETTINGS, cadence: 'manual' },
			history: { active: true, boundary: '2025-01-01T00:00:00.000Z' },
			digests: [deferred],
			currentAttempt: deferred
		}));
		expect(body).toContain('There are not enough credits for this batch.');
		expect(body).toContain('Add credits on the Usage page');
		expect(body).toContain('href="/usage"');
		expect(body).toContain('the history scan retries automatically.');
		expect(body).not.toContain('after the blocker is resolved');
	});

	it('uses deadline-specific historical retry guidance', () => {
		const deferred = { ...COMPLETE_DIGEST, id: 8, status: 'deferred', error: 'deadline', creditsUsed: null };
		const body = renderFeedback(pageData({
			history: { active: true, boundary: '2025-01-01T00:00:00.000Z' },
			digests: [deferred],
			currentAttempt: deferred
		}));
		expect(body).toContain('The time limit was reached. The history scan retries automatically.');
	});

	it('explains a historical batch credit shortfall with actionable Usage link copy', () => {
		const deferred = { ...COMPLETE_DIGEST, id: 8, status: 'deferred', error: 'credits', creditsUsed: null };
		const body = renderFeedback(pageData({
			settings: { ...SETTINGS, cadence: 'manual' },
			history: { active: true, boundary: '2025-01-01T00:00:00.000Z' },
			digests: [deferred],
			currentAttempt: deferred
		}));
		expect(body).toContain('There are not enough credits for this batch.');
		expect(body).toContain('Add credits on the Usage page; the history scan retries automatically.');
		expect(body).toContain('href="/usage"');
		expect(body).not.toContain('out of credits');
		expect(body).not.toContain('after the blocker is resolved');
	});

	it('a deferred row older than the latest complete digest does not banner', () => {
		// The transient row sits in the history list but is stale — the load
		// reports currentAttempt: null for anything older than the latest
		// complete digest.
		const body = renderFeedback(
			pageData({
				digests: [COMPLETE_DIGEST, { ...COMPLETE_DIGEST, id: 6, status: 'deferred', error: 'credits', creditsUsed: null }],
				latest: COMPLETE_DIGEST
			})
		);
		expect(body).not.toContain('out of credits');
	});
});

const POPULATED_FINDINGS = [
	{
		id: 11,
		category: 'question',
		summary: 'Two viewers asked when the next stream starts',
		supporterCount: 2,
		evidence: [
			{ id: 101, sanitizedExcerpt: 'When does the stream start?', hasAbuse: 0 },
			{ id: 102, sanitizedExcerpt: 'What time is the next stream?', hasAbuse: 0 }
		]
	},
	{
		id: 12,
		category: 'correction',
		summary: 'Three viewers corrected the episode number',
		supporterCount: 3,
		evidence: [{ id: 103, sanitizedExcerpt: 'This is episode four, not five.', hasAbuse: 0 }]
	}
];

function populatedData(findings: unknown[] = POPULATED_FINDINGS) {
	const latest = { ...COMPLETE_DIGEST, pooledCount: 0 };
	return pageData({ digests: [latest], latest, findings });
}

describe('feedback page digest history links (SSR)', () => {
	// A multi-page history drain produces one complete digest per page —
	// every row in the list must link to its own findings or earlier pages'
	// paid work is invisible (codex).
	const OLDER = { ...COMPLETE_DIGEST, id: 3, createdAt: '2026-01-05T00:00:00.000Z' };

	it('links each complete digest row to its findings and marks the shown one', () => {
		const body = renderFeedback(
			pageData({ latest: COMPLETE_DIGEST, selected: COMPLETE_DIGEST, digests: [COMPLETE_DIGEST, OLDER], findings: [] })
		);
		expect(body).toContain('href="?digest=7"');
		expect(body).toContain('href="?digest=3"');
		expect(body).toContain('aria-current="true"');
	});

	it('failed rows have no findings link — there is nothing paid to show', () => {
		const body = renderFeedback(
			pageData({
				latest: COMPLETE_DIGEST,
				selected: COMPLETE_DIGEST,
				digests: [{ ...COMPLETE_DIGEST, id: 9, status: 'failed', error: 'scoring' }, COMPLETE_DIGEST],
				findings: []
			})
		);
		expect(body).not.toContain('?digest=9');
	});

	it('offers a way back to the latest digest while an older one is selected', () => {
		const body = renderFeedback(
			pageData({ latest: COMPLETE_DIGEST, selected: OLDER, digests: [COMPLETE_DIGEST, OLDER], findings: [] })
		);
		expect(body).toContain('Back to latest digest');
	});

	it('links a finished preview row to its findings and labels preview lifecycle rows', () => {
		// A completed dry run is a real, selectable result; pending/failed
		// previews have no findings to show and stay unlinked text (MOD-232).
		const preview = { ...COMPLETE_DIGEST, id: 9, status: 'dry-run', creditsUsed: null };
		const pending = { ...COMPLETE_DIGEST, id: 10, status: 'dry-run-pending', creditsUsed: null };
		const failedPreview = { ...COMPLETE_DIGEST, id: 11, status: 'dry-run-failed', error: 'preview', creditsUsed: null };
		const body = renderFeedback(
			pageData({
				latest: COMPLETE_DIGEST,
				selected: COMPLETE_DIGEST,
				digests: [failedPreview, pending, preview, COMPLETE_DIGEST],
				findings: []
			})
		);
		expect(body).toContain('href="?digest=9"');
		expect(body).not.toContain('?digest=10');
		expect(body).not.toContain('?digest=11');
		expect(body).toContain('free preview');
		expect(body).toContain('preview in progress');
		expect(body).toContain('preview failed');
	});

	it('labels a selected preview as a free preview instead of unmetered', () => {
		// creditsUsed is null on preview rows — rendering it as "unmetered"
		// would read as a BYOK run; the preview never touched credits.
		const preview = { ...COMPLETE_DIGEST, id: 9, status: 'dry-run', creditsUsed: null };
		const body = renderFeedback(pageData({ digests: [preview], selected: preview, findings: [] }));
		expect(body).toContain('free preview');
		expect(body).not.toContain('unmetered');
	});
});

describe('feedback page I12 states (SSR)', () => {
	it('renders a loading skeleton without settings controls while digest data is unresolved', () => {
		const body = renderFeedback(pageData({ digests: undefined }));
		expect(body).toContain('aria-busy="true"');
		expect(body).toContain('aria-label="Loading"');
		expect(body).not.toContain('action="?/settings"');
	});

	it('renders both empty states for no digest and a complete digest with no recurring feedback', () => {
		const noDigest = renderFeedback(pageData());
		expect(noDigest).toContain('No digest yet');

		const latest = { ...COMPLETE_DIGEST, pooledCount: 0 };
		const noFindings = renderFeedback(pageData({ digests: [latest], latest }));
		expect(noFindings).toContain('No recurring feedback to show.');
	});

	it('renders form and newest-run errors as accessible error boxes', () => {
		const formError = renderFeedback(pageData(), { error: 'boom' });
		expect(formError).toMatch(/class="[^"]*error-box[^"]*" role="alert">\s*boom/);

		const failed = { ...COMPLETE_DIGEST, id: 8, status: 'failed', error: 'scoring' };
		const failedRun = renderFeedback(pageData({ digests: [failed], currentAttempt: failed }));
		expect(failedRun).toContain('Latest digest run failed');
	});

	it('renders populated findings by category with collapsed evidence and generation time', () => {
		const body = renderFeedback(populatedData());
		expect(body).toContain('Recurring questions');
		expect(body).toContain('Corrections');
		expect(body).toContain('Two viewers asked when the next stream starts');
		expect(body).toContain('Three viewers corrected the episode number');
		expect(body).toContain('<details');
		expect(body).toContain('Show 2 supporting comments');
		expect(body).toContain('· generated ');
	});
});

describe('feedback evidence concealment and reveal fallback (SSR)', () => {
	const raw = 'you fucking idiot, the audio at 3:00 is blown out';
	const evidenceId = 201;
	const finding = {
		id: 21,
		category: 'criticism',
		summary: 'Two viewers reported blown-out audio',
		supporterCount: 2,
		evidence: [
			{
				id: evidenceId,
				sanitizedExcerpt: concealEvidence(raw, { hasAbuse: true }).text,
				hasAbuse: 1
			}
		]
	};
	const otherFinding = {
		id: 22,
		category: 'criticism',
		summary: 'Another finding',
		supporterCount: 2,
		evidence: [{ id: 202, sanitizedExcerpt: 'ordinary feedback', hasAbuse: 0 }]
	};

	it('never SSRs abusive raw evidence by default and labels its targeted reveal control', () => {
		const body = renderFeedback(populatedData([finding]));
		expect(body).not.toContain('fucking');
		expect(body).not.toContain('idiot');
		expect(body).not.toContain(raw);
		expect(body).toContain('aria-label="Show original comment 1 for “Two viewers reported blown-out audio”"');
	});

	it('asks before revealing abusive evidence without rendering its raw text', () => {
		const body = renderFeedback(populatedData([finding]), {
			scope: 'reveal',
			evidenceId,
			confirmationRequired: true
		});
		expect(body).toContain('This comment contains abusive wording. Show it anyway?');
		expect(body).toContain('name="evidenceId" value="201"');
		expect(body).toContain('name="confirmedAbuse" value="yes"');
		expect(body).toContain('Show the abusive comment');
		expect(body).not.toContain('fucking');
		expect(body).not.toContain('idiot');
		expect(body).not.toContain(raw);
	});

	it('renders a successful no-JS reveal for only the matching evidence item', () => {
		const body = renderFeedback(populatedData([finding]), {
			scope: 'reveal',
			evidenceId,
			text: 'RAW ORIGINAL'
		});
		expect(body.match(/RAW ORIGINAL/g)).toHaveLength(1);
		expect(body).toContain('aria-label="Hide original comment 1 for “Two viewers reported blown-out audio”"');
		expect(body).not.toMatch(/class="[^"]*error-box[^"]*" role="alert"/);
	});

	it('renders a no-JS reveal failure inline instead of in the page-level banner', () => {
		const body = renderFeedback(populatedData([finding]), {
			scope: 'reveal',
			evidenceId,
			error: 'The original comment is no longer available.'
		});
		expect(body).toMatch(/class="[^"]*reveal-error[^"]*" role="alert">The original comment is no longer available\.<\/div>/);
		expect(body.match(/The original comment is no longer available\./g)).toHaveLength(1);
		expect(body.indexOf('reveal-error')).toBeGreaterThan(body.indexOf('class="evidence'));
	});

	it.each([
		{ state: 'success', form: { scope: 'reveal', evidenceId, text: 'RAW ORIGINAL' } },
		{ state: 'failure', form: { scope: 'reveal', evidenceId, error: 'The original comment is no longer available.' } },
		{ state: 'confirmation', form: { scope: 'reveal', evidenceId, confirmationRequired: true } }
	])('opens only the finding containing the targeted evidence on no-JS $state', ({ form }) => {
		const body = renderFeedback(populatedData([finding, otherFinding]), form);
		const details = body.match(/<details[^>]*>/g) ?? [];
		expect(details).toHaveLength(2);
		expect(details[0]).toMatch(/\sopen(?:\s|=|>)/);
		expect(details[1]).not.toMatch(/\sopen(?:\s|=|>)/);
	});
});
