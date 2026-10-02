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
		// Same for the preview lifecycle row (dry-run-pending/dry-run-failed).
		previewAttempt: null,
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
		const preview = { ...digest, id: 9, status: 'dry-run', creditsUsed: null };
		for (const body of [
			renderFeedback(pageData({ settings, latest: digest })),
			renderFeedback(pageData({ settings, digests: [preview], selected: preview }))
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

	it('shows recovery information on an empty saved preview without the failed-run banner', () => {
		// The inline preview-results block is gone (MOD-233): a finished
		// preview renders its persisted row like any complete digest.
		const preview = { ...COMPLETE_DIGEST, id: 9, status: 'dry-run', clusteringDegraded: 1, commentsClassified: 3, pooledCount: 3, creditsUsed: null };
		const body = renderFeedback(pageData({ digests: [preview], selected: preview }));
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
				// The one dry-run message: allowance, first-page scope, the
				// used-on-start rule, and where the async result lands.
				expect(body).toContain('1 free feedback dry run per channel — scores only the first YouTube page (up to 100 comments) and changes no moderation state or history coverage. Used when it starts, even if it fails. Results appear as a free preview under Recent digests; no credits are charged.');
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

	it('renders persisted preview findings as sanitized excerpts with real reveal affordances', () => {
		// Preview evidence is a real finding_evidence row now — its pinned
		// sourceText makes the reveal flow work exactly like a paid digest's
		// (MOD-232/233); the old inline block's read-only excerpt is gone.
		const preview = { ...COMPLETE_DIGEST, id: 9, status: 'dry-run', commentsClassified: 4, commentsFailed: 1, pooledCount: 2, creditsUsed: null };
		const findings = [{
			id: 41,
			category: 'question',
			summary: 'Three viewers asked about timing',
			supporterCount: 3,
			evidence: [
				{ id: 411, sanitizedExcerpt: 'When is the next stream?', hasAbuse: 0 },
				{ id: 412, sanitizedExcerpt: 'Wording concealed', hasAbuse: 1 }
			]
		}];
		const body = renderFeedback(pageData({ digests: [preview], selected: preview, findings }));
		expect(body).toContain('4 classified');
		expect(body).toContain('1 failed');
		expect(body).toContain('free preview');
		expect(body).not.toContain('credits used');
		// First-page disclosure lives in the dry-run settings note.
		expect(body).toContain('scores only the first YouTube page (up to 100 comments)');
		expect(body).toContain('When is the next stream?');
		expect(body).toContain('action="?/reveal"');
		expect(body).toContain('Show original comment');
		// The inline preview-results block was removed — no duplicate render path.
		expect(body).not.toContain('preview-results');
	});

	it('keeps recovered preview findings distinct when category and summary match', () => {
		const preview = { ...COMPLETE_DIGEST, id: 9, status: 'dry-run', clusteringDegraded: 1, creditsUsed: null };
		const findings = ['Theme evidence', 'Original claim evidence'].map((sanitizedExcerpt, i) => ({
			id: 50 + i,
			category: 'question',
			summary: '3 comments asked: visa procedures',
			supporterCount: 3,
			evidence: [{ id: 500 + i, sanitizedExcerpt, hasAbuse: 0 }]
		}));
		const body = renderFeedback(pageData({ digests: [preview], selected: preview, findings }));
		// The summary repeats inside aria labels — count the summary element
		// (Svelte appends a scoping class, so match the attribute prefix).
		expect(body.match(/<p class="finding-summary[^"]*">3 comments asked: visa procedures<\/p>/g)).toHaveLength(2);
		expect(body).toContain('Theme evidence');
		expect(body).toContain('Original claim evidence');
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		// Identical summaries must not collide: findings key by row id.
		expect(source).toContain('{#each group.findings as finding (finding.id)}');
		// The synchronous-preview render path is gone entirely (MOD-233).
		expect(source).not.toContain('const feedbackPreview =');
		expect(source).not.toContain('preview-results');
	});

	it('renders an empty saved preview without implying a full-history scan', () => {
		const preview = { ...COMPLETE_DIGEST, id: 9, status: 'dry-run', commentsClassified: 0, pooledCount: 0, creditsUsed: null };
		const body = renderFeedback(pageData({ digests: [preview], selected: preview, findings: [] }));
		expect(body).toContain('No recurring feedback to show.');
		expect(body).toContain('scores only the first YouTube page (up to 100 comments)');
		expect(body).not.toContain('preview-results');
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

describe('feedback page async preview banner (SSR)', () => {
	// MOD-233: the async preview returns immediately; the lifecycle row
	// (dry-run-pending → dry-run/dry-run-failed) is what the next
	// autoRefresh poll renders. previewAttempt is the newest such row.
	const PENDING = { ...COMPLETE_DIGEST, id: 9, status: 'dry-run-pending', creditsUsed: null, error: null };

	it('shows a running notice while the preview drains — info flash, not an error', () => {
		const body = renderFeedback(pageData({ digests: [PENDING], previewAttempt: PENDING }));
		expect(body).toContain('Free feedback preview is running');
		expect(body).toContain('Recent digests');
		// Informational flash, not an error box — nothing failed.
		expect(body).toContain('class="flash"');
		expect(body).not.toContain('preview failed');
		expect(body).not.toContain('error-box');
	});

	it('shows the running banner even when feedback is disabled — the preview still drains', () => {
		// An owner can disable feedback after kicking off the preview; the
		// lifecycle row keeps its banner outside the settings.enabled gate.
		const body = renderFeedback(
			pageData({ settings: { ...SETTINGS, enabled: false }, digests: [PENDING], previewAttempt: PENDING })
		);
		expect(body).toContain('Free feedback preview is running');
	});

	it('surfaces a failed preview with preview-specific copy — the one free attempt is spent', () => {
		const failed = { ...PENDING, status: 'dry-run-failed', error: 'preview' };
		const body = renderFeedback(pageData({ digests: [failed], previewAttempt: failed }));
		expect(body).toContain('error-box');
		expect(body).toContain('Free feedback preview failed');
		// No retry messaging: the attempt is spent, nothing re-queues it.
		expect(body).toContain('one free preview is spent');
		expect(body).not.toContain('retries automatically');
		// And it never reads as an ordinary paid-digest failure.
		expect(body).not.toContain('Latest digest run failed');
	});

	it('keeps a paid digest failure visible alongside a pending preview — neither hides the other', () => {
		// The pending preview must not shadow a real failed attempt behind a
		// banner the page cannot render (PR-170 triage invariant).
		const failedPaid = { ...COMPLETE_DIGEST, id: 6, status: 'failed', error: 'deadline' };
		const body = renderFeedback(pageData({
			digests: [PENDING, failedPaid],
			currentAttempt: failedPaid,
			previewAttempt: PENDING
		}));
		expect(body).toContain('Latest digest run failed');
		expect(body).toContain('Free feedback preview is running');
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

	it('renders a lone pending or failed preview row — the one-time preview is never invisible', () => {
		// With no selectable digest, `selected`/`currentAttempt` are null and
		// the old digests.length > 1 gate hid the only lifecycle row — after
		// reload the failed/running preview left no trace (codex/cubic).
		const failed = { ...COMPLETE_DIGEST, id: 9, status: 'dry-run-failed', error: 'preview', creditsUsed: null };
		const pending = { ...COMPLETE_DIGEST, id: 10, status: 'dry-run-pending', creditsUsed: null };
		const body = renderFeedback(pageData({ digests: [failed] }));
		expect(body).toContain('Digest history');
		expect(body).toContain('preview failed');
		expect(renderFeedback(pageData({ digests: [pending] }))).toContain('preview in progress');
		// A sole FINISHED preview gets a (self-pointing) history entry too —
		// only a lone complete digest stays list-free (cubic).
		const finished = { ...COMPLETE_DIGEST, id: 11, status: 'dry-run', creditsUsed: null };
		const solo = renderFeedback(pageData({ digests: [finished], selected: finished }));
		expect(solo).toContain('Digest history');
		expect(solo).toContain('href="?digest=11"');
	});

	it('renders a saved preview while feedback is disabled — the one-time result survives reload', () => {
		// The dry-run action only needs an active channel — settings.enabled
		// can stay off — so a preview run before enabling must not vanish
		// behind the "digest is off" card after reload (codex).
		const preview = { ...COMPLETE_DIGEST, id: 9, status: 'dry-run', creditsUsed: null };
		const body = renderFeedback(
			pageData({
				settings: { ...SETTINGS, enabled: false },
				digests: [preview],
				selected: preview,
				findings: POPULATED_FINDINGS
			})
		);
		expect(body).toContain('Feedback digest is off for this channel.');
		expect(body).toContain('free preview');
		expect(body).toContain('Two viewers asked when the next stream starts');
		// The enabled-only generate form must NOT leak into the disabled view.
		expect(body).not.toContain('action="?/generate"');
	});

	it('keeps the selected digest in history pagination links when no complete digest exists', () => {
		// With no paid digest, `selected` is a preview — paging the list must
		// keep ?digest= or the load falls back to a different row (cubic).
		const preview = { ...COMPLETE_DIGEST, id: 9, status: 'dry-run', creditsUsed: null };
		const older = { ...COMPLETE_DIGEST, id: 5, status: 'dry-run', creditsUsed: null };
		const body = renderFeedback(
			pageData({ digests: [preview, older], selected: preview, latest: null, historyNext: 5, findings: [] })
		);
		expect(body).toContain('?digest=9&amp;history=5');
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
