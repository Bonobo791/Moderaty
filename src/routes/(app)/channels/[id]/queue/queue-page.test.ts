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

// SSR pins for the redesigned review queue (redesign Commit 6): underlined
// .row-action Approve/Reject posting to the unchanged actions, the
// flash → collapse optimistic-exit machinery, the spec empty-state copy,
// and the deduped (visually hidden) section heading.
//
// Gotchas: the render is lazy — assert on render(...).body. The optimistic
// flags only exist client-side, so the flash/collapse classes are pinned on
// the component source (readFileSync), the same pattern as page-states.test.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';

import Page from './+page.svelte';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '+page.svelte'), 'utf8');
const appCss = readFileSync(join(here, '..', '..', '..', '..', '..', 'app.css'), 'utf8');

const PENDING = [
	{ id: 'c1', text: 'borderline take one', publishedAt: '2026-07-01T00:00:00Z' },
	{ id: 'c2', text: 'borderline take two', publishedAt: '2026-07-02T00:00:00Z' }
];

function renderQueue(data: unknown, form: unknown = null) {
	return render(Page, { props: { data, form } as never }).body;
}

describe('queue row actions (SSR)', () => {
	it('renders Approve/Reject as underlined row-action text buttons posting to the existing actions', () => {
		const body = renderQueue({ pending: PENDING });
		expect(body).toContain('action="?/approve"');
		expect(body).toContain('action="?/reject"');
		// Scoped-hash safe: the hash trails the authored classes in the attribute.
		expect(body.match(/class="row-action approve[ "]/g)).toHaveLength(2);
		expect(body.match(/class="row-action reject[ "]/g)).toHaveLength(2);
		expect(body).toContain('name="commentId" value="c1"');
		// Old decision-button chrome is gone; I13 labels stay.
		expect(body).not.toContain('class="btn secondary small"');
		expect(body).toContain('aria-label="Approve comment: borderline take one"');
		expect(body).toContain('aria-label="Reject comment: borderline take one"');
	});

	it('wraps each row in the flash/collapse machinery keyed for optimistic exit', () => {
		const body = renderQueue({ pending: PENDING });
		expect(body.match(/class="row-wrap[ "]/g)).toHaveLength(2);
		expect(body.match(/class="queue-row[ "]/g)).toHaveLength(2);
		// The single queue-list state is keyed by comment id — no duplicate rows
		// when an autoRefresh revalidation lands mid-animation.
		expect(source).toContain('{#each visible as c (c.id)}');
		expect(source).toContain('filter((c) => !gone[c.id])');
	});

	it('keeps the Delete/Ban inline confirm flow on plain buttons', () => {
		const body = renderQueue({ pending: PENDING });
		expect(body).toContain('aria-label="Delete comment: borderline take one"');
		expect(body).toContain('aria-label="Ban author of comment: borderline take one"');
		expect(body).toContain('btn danger small');
	});
});

describe('queue optimistic flow (source pins)', () => {
	it('wires both decision forms through use:enhance', () => {
		expect(source).toContain("use:enhance={decide(c.id, 'approve')}");
		expect(source).toContain("use:enhance={decide(c.id, 'reject')}");
	});

	it('implements the spec timings and flash colors', () => {
		expect(source).toContain('FLASH_MS = 200');
		expect(source).toContain('EXIT_MS = 220');
		expect(source).toContain('rgba(61, 220, 132, 0.12)');
		expect(source).toContain('rgba(255, 49, 49, 0.12)');
		expect(source).toContain('220ms var(--ease-out)');
		expect(source).toContain('class:flash-approve');
		expect(source).toContain('class:flash-reject');
		expect(source).toContain('class:exiting');
	});

	it('restores the row loudly on action failure and revalidates either way', () => {
		// The failure branch clears the optimistic flags (server state wins)
		// and update() surfaces form.error in the error-box — no silent path.
		const failureBranch = source.match(/result\.type === 'success'[\s\S]*?else \{([\s\S]*?)\}\s*\n\s*await update\(\);/);
		expect(failureBranch, 'success/else/await update() structure present').not.toBeNull();
		expect(failureBranch![1]).toContain('clearDecision(id)');
		expect(source).toContain('form?.error');
	});

	it('collapses flash, exit, and route transitions under prefers-reduced-motion', () => {
		expect(appCss).toMatch(/prefers-reduced-motion: reduce[\s\S]*?\.row-wrap, \.queue-row \{ transition: none; \}/);
		expect(appCss).toMatch(/prefers-reduced-motion: reduce[\s\S]*?\.route-enter \{ animation: none; \}/);
	});
});

describe('queue empty state and heading (SSR)', () => {
	it('renders the verbatim spec empty copy only when the queue is empty', () => {
		const empty = renderQueue({ pending: [] });
		expect(empty).toContain('Queue is clear. The rope holds.');
		const populated = renderQueue({ pending: PENDING });
		expect(populated).not.toContain('Queue is clear. The rope holds.');
	});

	it('styles the empty state to spec: --text-2, 14px, 48px padding', () => {
		expect(source).toMatch(/\.queue-empty \{[\s\S]*?padding: 48px 0;[\s\S]*?font-size: 14px;[\s\S]*?color: var\(--text-2\);/);
	});

	it('keeps an accessible section heading without the redundant visible h1', () => {
		const body = renderQueue({ pending: PENDING });
		expect(body).toContain('<h2 class="sr-only">Review queue</h2>');
		expect(body).not.toContain('<h1');
		expect(body).not.toContain('Review queue —');
	});
});
