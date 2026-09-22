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

// SSR pins for the feedback digest page: owner-only controls must not
// render for members/admins (the actions throw a bare 403 error page —
// codex), and a recorded deferral must surface as a banner instead of a
// silent "No digest yet" (codex). Render is lazy — assert on .body.

import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';

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
		ch: { id: 'UC1', title: 'Channel UC1' },
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
