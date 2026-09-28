// SSR pins for the feedback digest page: owner-only controls must not
// render for members/admins (the actions throw a bare 403 error page —
// codex), and a recorded deferral must surface as a banner instead of a
// silent "No digest yet" (codex). Render is lazy — assert on .body.

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
		latest: null,
		findings: [],
		settings: SETTINGS,
		orgRole: 'owner',
		...over
	};
}

describe('feedback page role gating (SSR)', () => {
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

	it('shows the billing notice to every role and keeps history and preview forms owner-only', () => {
		for (const role of ['owner', 'member', 'admin']) {
			const body = renderFeedback(pageData({ orgRole: role }));
			expect(body).toContain('Feedback uses 1 credit per comment processed on metered plans, in addition to moderation. Historical analysis uses the same credits. Your one free feedback dry run uses no credits.');
			expect(body).toContain('Limited to 1 free feedback dry run per channel.');
			expect(body).toContain('This one free feedback preview is used when it starts, even if it later fails. No credits are charged.');
			if (role === 'owner') {
				expect(body).toContain('action="?/analyzeHistory"');
				expect(body).toContain('action="?/dryRun"');
				expect(body).toContain('This one free feedback preview is used when it starts, even if it later fails. No credits are charged.');
			} else {
				expect(body).not.toContain('action="?/analyzeHistory"');
				expect(body).not.toContain('action="?/dryRun"');
			}
		}
	});

	it('both historical feedback forms use the shared month presets', () => {
		const body = renderFeedback(pageData());
		for (const months of HISTORY_MONTH_PRESETS) expect(body).toContain(`value="${months}"`);
	});

	it('disables history and feedback preview when history is active, settings are off, allowance used, or channel paused', () => {
		const activeHistory = renderFeedback(pageData({ history: { active: true, boundary: '2025-01-01T00:00:00.000Z' }, settings: { ...SETTINGS, cadence: 'manual' } }));
		expect(activeHistory).toContain('Historical feedback analysis is continuing in the background under cron, including on manual digest cadence.');
		expect(activeHistory).toContain('History analysis active');

		const disabled = renderFeedback(pageData({ settings: { ...SETTINGS, enabled: false }, history: { active: true, boundary: '2025-01-01T00:00:00.000Z' }, dryRunUsed: true, ch: { id: 'UC1', title: 'Channel UC1', active: false } }));
		expect(disabled).toContain('Feedback preview already used');
		expect(disabled).toContain('This channel has used its feedback preview allowance.');
		expect(disabled).toContain('paused while this channel is paused or feedback is turned off');
		expect(disabled).toMatch(/<button[^>]*disabled[^>]*>History analysis active<\/button>/);
		expect(disabled).toMatch(/<button[^>]*disabled[^>]*>Feedback preview already used<\/button>/);

		const failedAttempt = renderFeedback(pageData(), { scope: 'feedbackDryRun', attempted: true, error: 'provider failure' });
		expect(failedAttempt).toContain('This channel has used its feedback preview allowance.');
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
		expect(body).toContain('Preview covers only the first page, up to 100 comments; run historical analysis for the full window.');
		expect(body).toContain('More comments are available beyond this preview page.');
		expect(body).toContain('When is the next stream?');
		expect(body).not.toContain('action="?/reveal"');
		expect(body).not.toContain('Show original comment');
	});

	it('renders an empty feedback preview without implying a full-history scan', () => {
		const body = renderFeedback(pageData(), {
			scope: 'feedbackDryRun',
			ok: true,
			preview: { commentsClassified: 0, commentsFailed: 0, pooled: 0, hasMore: false, findings: [] }
		});
		expect(body).toContain('No grouped findings in this preview');
		expect(body).toContain('Preview covers only the first page, up to 100 comments');
	});
});

describe('feedback page deferred banner (SSR)', () => {
	it('surfaces a credit deferral instead of a silent empty state', () => {
		const body = renderFeedback(
			pageData({
				orgRole: 'member',
				digests: [{ ...COMPLETE_DIGEST, id: 8, status: 'deferred', error: 'credits', creditsUsed: null }]
			})
		);
		expect(body).toContain('credits');
		expect(body).not.toContain('No digest yet');
	});

	it('explains that a historical batch needs enough credits and links to Usage', () => {
		const body = renderFeedback(pageData({
			settings: { ...SETTINGS, cadence: 'manual' },
			history: { active: true, boundary: '2025-01-01T00:00:00.000Z' },
			digests: [{ ...COMPLETE_DIGEST, id: 8, status: 'deferred', error: 'credits', creditsUsed: null }]
		}));
		expect(body).toContain('There are not enough credits for this batch.');
		expect(body).toContain('Add credits on the Usage page');
		expect(body).toContain('href="/usage"');
		expect(body).toContain('historical analysis retries automatically.');
		expect(body).not.toContain('after the blocker is resolved');
	});

	it('uses deadline-specific historical retry guidance', () => {
		const body = renderFeedback(pageData({
			history: { active: true, boundary: '2025-01-01T00:00:00.000Z' },
			digests: [{ ...COMPLETE_DIGEST, id: 8, status: 'deferred', error: 'deadline', creditsUsed: null }]
		}));
		expect(body).toContain('The time limit was reached. Historical analysis retries on the next cron tick.');
	});

	it('explains a historical batch credit shortfall with actionable Usage link copy', () => {
		const body = renderFeedback(pageData({
			settings: { ...SETTINGS, cadence: 'manual' },
			history: { active: true, boundary: '2025-01-01T00:00:00.000Z' },
			digests: [{ ...COMPLETE_DIGEST, id: 8, status: 'deferred', error: 'credits', creditsUsed: null }]
		}));
		expect(body).toContain('There are not enough credits for this batch.');
		expect(body).toContain('Add credits on the Usage page; historical analysis retries automatically.');
		expect(body).toContain('href="/usage"');
		expect(body).not.toContain('out of credits');
		expect(body).not.toContain('after the blocker is resolved');
	});

	it('uses deadline-specific historical retry guidance', () => {
		const body = renderFeedback(pageData({
			history: { active: true, boundary: '2025-01-01T00:00:00.000Z' },
			digests: [{ ...COMPLETE_DIGEST, id: 8, status: 'deferred', error: 'deadline', creditsUsed: null }]
		}));
		expect(body).toContain('The time limit was reached. Historical analysis retries on the next cron tick.');
	});

	it('a deferred row older than the latest complete digest does not banner', () => {
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
		expect(noFindings).toContain('No recurring feedback this window');
	});

	it('renders form and newest-run errors as accessible error boxes', () => {
		const formError = renderFeedback(pageData(), { error: 'boom' });
		expect(formError).toMatch(/class="[^"]*error-box[^"]*" role="alert">boom<\/div>/);

		const failed = { ...COMPLETE_DIGEST, id: 8, status: 'failed', error: 'scoring' };
		const failedRun = renderFeedback(pageData({ digests: [failed] }));
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
