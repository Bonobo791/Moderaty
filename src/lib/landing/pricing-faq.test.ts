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

/**
 * Lines that can carry a billing claim: answers and ticks. Questions are
 * excluded — a question names a topic ("Can I get a refund?"), the answer
 * makes the claim, and the claim is where the legal anchor must live.
 */
const CLAIM_LINES = [
	...PRICING_FAQ_ENTRIES.map((f) => f.a),
	...TICKS_SELF_HOSTED,
	...TICKS_SELF_HOSTED_DETAILED,
	...TICKS_HOSTED,
	...TICKS_HOSTED_DETAILED
];

/** The one billing policy the product actually has, stated verbatim. */
const APPROVED_POLICY = 'Nothing renews, nothing auto-charges';

/**
 * Policy expansion (feat-consumer-copy, user-directed): now that the Terms of
 * Service publish a refund policy (§7 — CDC Art. 49 7-day withdrawal; outside
 * that window all sales are final, unused credits included), refund claims
 * are allowed in pricing
 * copy, but ONLY when anchored to the legal basis. A refund/credit/cancel
 * claim without "CDC Art. 49" on the same line is still an unsupported
 * billing claim and fails here.
 */
const REFUND_ANCHOR = /CDC Art\. 49/;
const REFUND_CLAIM = /refund|credit|cancel/i;

/** Never supported, anchored or not: expiry, rollover, trials, discounts, fees. */
const UNSUPPORTED_CLAIM = /expir|rollover|roll over|trial|discount|\bfees?\b/i;

describe('pricing copy guardrails', () => {
	it('ships exactly the 6 pricing FAQ pairs, each a real question with a real answer', () => {
		expect(PRICING_FAQ_ENTRIES).toHaveLength(6);
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
		for (const line of CLAIM_LINES) {
			// never supported, anchored or not
			expect(line).not.toMatch(UNSUPPORTED_CLAIM);
			// refund claims only with the ToS §7 legal anchor on the same line
			if (REFUND_CLAIM.test(line)) {
				expect(line).toMatch(REFUND_ANCHOR);
			}
		}
	});
});
