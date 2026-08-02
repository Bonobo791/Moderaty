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

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRICING_FAQ_ENTRIES } from './pricing-faq';
import {
	TICKS_HOSTED,
	TICKS_HOSTED_DETAILED,
	TICKS_LIFETIME,
	TICKS_LIFETIME_DETAILED,
	TICKS_SELF_HOSTED,
	TICKS_SELF_HOSTED_DETAILED
} from './plans';

/** Every line of pricing copy the guardrail polices: FAQ plus plan ticks. */
const PRICING_COPY = [
	...PRICING_FAQ_ENTRIES.flatMap((f) => [f.q, f.a]),
	...TICKS_SELF_HOSTED,
	...TICKS_SELF_HOSTED_DETAILED,
	...TICKS_HOSTED,
	...TICKS_HOSTED_DETAILED,
	...TICKS_LIFETIME,
	...TICKS_LIFETIME_DETAILED
];

/**
 * Lines that can carry a billing claim: answers and ticks. Questions are
 * excluded — a question names a topic ("Can I get a refund?"), the answer
 * makes the claim, and the claim is where the legal anchor must live.
 *
 * PR #47 review: the visible billing copy lives in Svelte components too,
 * not only in the data sources — a plan panel or hero line could introduce
 * an unsupported claim while this test kept passing. Every component that
 * renders pricing copy is read and policed line by line as well.
 */
const COMPONENT_SURFACES = [
	'../components/landing/PlanSelfHosted.svelte',
	'../components/landing/PlanHosted.svelte',
	'../components/landing/PlanLifetime.svelte',
	'../components/landing/Pricing.svelte',
	'../components/landing/pricing/PricingHero.svelte',
	'../components/landing/pricing/CostMath.svelte',
	'../../routes/pricing/+page.svelte'
];

const COMPONENT_CLAIM_LINES = COMPONENT_SURFACES.flatMap((path) =>
	readFileSync(new URL(path, import.meta.url), 'utf8').split('\n')
);

const CLAIM_LINES = [
	...PRICING_FAQ_ENTRIES.map((f) => f.a),
	...TICKS_SELF_HOSTED,
	...TICKS_SELF_HOSTED_DETAILED,
	...TICKS_HOSTED,
	...TICKS_HOSTED_DETAILED,
	...TICKS_LIFETIME,
	...TICKS_LIFETIME_DETAILED,
	...COMPONENT_CLAIM_LINES
];

/**
 * The automation policy the product actually has, stated verbatim: the hosted
 * plan renews monthly, and top-up automation is opt-in (Terms §6.2).
 */
const APPROVED_POLICY = 'Automatic top-up is opt-in';

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
	it('ships exactly the 7 pricing FAQ pairs, each a real question with a real answer', () => {
		expect(PRICING_FAQ_ENTRIES).toHaveLength(7);
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

	it('makes no billing-policy claims beyond opt-in automation', () => {
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
