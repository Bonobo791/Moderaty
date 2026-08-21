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

import { describe, expect, it } from 'vitest';
import {
	INITIAL_COUNTS,
	FINAL_COUNTS,
	SCRIPT,
	applyArrival,
	applyVerdict,
	initialQueueState
} from './queue-script';

describe('Bonk Queue counter logic', () => {
	it('every arrival increments incoming and nothing else', () => {
		const next = applyArrival(INITIAL_COUNTS);
		expect(next.incoming).toBe(INITIAL_COUNTS.incoming + 1);
		expect(next.actioned).toBe(INITIAL_COUNTS.actioned);
		expect(next.yours).toBe(INITIAL_COUNTS.yours);
	});

	it.each(['BANNED', 'DELETED', 'REJECTED'] as const)(
		'%s increments actioned and leaves the human pile alone',
		(verdict) => {
			const next = applyVerdict(INITIAL_COUNTS, verdict);
			expect(next.actioned).toBe(INITIAL_COUNTS.actioned + 1);
			expect(next.yours).toBe(INITIAL_COUNTS.yours);
			expect(next.incoming).toBe(INITIAL_COUNTS.incoming);
		}
	);

	it('HELD goes to the human: yours +1 on top of the tool action', () => {
		const next = applyVerdict(INITIAL_COUNTS, 'HELD');
		expect(next.yours).toBe(INITIAL_COUNTS.yours + 1);
		expect(next.actioned).toBe(INITIAL_COUNTS.actioned + 1);
	});

	it('APPROVED is still a tool action: actioned +1, yours untouched', () => {
		const next = applyVerdict(INITIAL_COUNTS, 'APPROVED');
		expect(next.actioned).toBe(INITIAL_COUNTS.actioned + 1);
		expect(next.yours).toBe(INITIAL_COUNTS.yours);
	});

	it('a full scripted pass lands exactly on the illustrative night: 47/41/6', () => {
		let counts = INITIAL_COUNTS;
		for (const item of SCRIPT) {
			counts = applyVerdict(applyArrival(counts), item.verdict);
		}
		expect(counts).toEqual(FINAL_COUNTS);
	});

	it('the reduced-motion end state is the labeled illustrative night: 47/41/6', () => {
		expect(FINAL_COUNTS).toEqual({ incoming: 47, actioned: 41, yours: 6 });
	});

	it('the SSR/no-JS state is the completed night: settled tail rows and final counts', () => {
		const state = initialQueueState();
		expect(state.counts).toEqual(FINAL_COUNTS);
		expect(state.rows).toHaveLength(4);
		expect(state.rows.map((r) => r.item)).toEqual(SCRIPT.slice(-4));
		expect(state.rows.every((r) => r.state === 'settled')).toBe(true);
		expect(new Set(state.rows.map((r) => r.key)).size).toBe(4);
	});

	it('the script is exactly the 8-entry illustrative night (slice(-4) tail equivalence holds)', () => {
		expect(SCRIPT).toHaveLength(8);
	});

	it('the script never ships an empty queue or an unstyled verdict', () => {
		expect(SCRIPT.length).toBeGreaterThanOrEqual(4);
		for (const item of SCRIPT) {
			expect(item.author.length).toBeGreaterThan(0);
			expect(item.text.length).toBeGreaterThan(0);
			expect(item.reason.length).toBeGreaterThan(0);
		}
	});
});
