// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { describe, expect, it } from 'vitest';
import { PRICING_FAQ_ENTRIES } from './pricing-faq';
import {
	TICKS_HOSTED,
	TICKS_HOSTED_DETAILED,
	TICKS_SELF_HOSTED,
	TICKS_SELF_HOSTED_DETAILED
} from './plans';

/** Every line of pricing copy the guardrail polices: FAQ plus plan ticks. */
const PRICING_COPY = [
	...PRICING_FAQ_ENTRIES.flatMap((f) => [f.q, f.a]),
	...TICKS_SELF_HOSTED,
	...TICKS_SELF_HOSTED_DETAILED,
	...TICKS_HOSTED,
	...TICKS_HOSTED_DETAILED
];

/** The one billing policy the product actually has, stated verbatim. */
const APPROVED_POLICY = 'Nothing renews, nothing auto-charges';

/**
 * Anything else is an unsupported billing claim: refunds, expiry, rollover,
 * cancellation, trials, discounts, fees, or credit retention.
 */
const UNSUPPORTED_CLAIM = /refund|expir|rollover|roll over|cancel|trial|discount|\bfees?\b|credit/i;

describe('pricing copy guardrails', () => {
	it('ships exactly the 5 pricing FAQ pairs, each a real question with a real answer', () => {
		expect(PRICING_FAQ_ENTRIES).toHaveLength(5);
		for (const { q, a } of PRICING_FAQ_ENTRIES) {
			expect(q.endsWith('?')).toBe(true);
			expect(a.length).toBeGreaterThan(40);
		}
	});

	it('uses no em-dashes or en-dashes anywhere in pricing FAQ copy', () => {
		for (const { q, a } of PRICING_FAQ_ENTRIES) {
			expect(q).not.toMatch(/[—–]/);
			expect(a).not.toMatch(/[—–]/);
		}
	});

	it('makes no billing-policy claims beyond nothing-renews-nothing-auto-charges', () => {
		// the approved policy is present, verbatim
		expect(PRICING_COPY.join(' ')).toContain(APPROVED_POLICY);
		// and no unsupported claim appears anywhere in pricing copy
		for (const line of PRICING_COPY) {
			expect(line).not.toMatch(UNSUPPORTED_CLAIM);
		}
	});
});
