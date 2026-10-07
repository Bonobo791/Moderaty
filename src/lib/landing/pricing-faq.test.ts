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
	'../../routes/pricing/+page.svelte',
	'../../routes/+page.svelte'
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
 * copy, but ONLY when anchored to the legal basis. A refund/cancel
 * claim without "CDC Art. 49" on the same line is still an unsupported
 * billing claim and fails here.
 */
const REFUND_ANCHOR = /CDC Art\. 49/;
// Credit consumption and purchased-balance copy describe the verified ledger,
// not a refund promise. Refund/cancellation promises still need the legal anchor.
const REFUND_CLAIM = /refund|cancel|money[\s-]+back|reimburs|credits?\s+(?:back|(?:(?:is|are|will\s+be)\s+)?returned)/i;

/** Never supported, anchored or not: expiry, rollover, trials, discounts, fees. */
const UNSUPPORTED_CLAIM = /expir|rollover|roll over|trial|discount|\bfees?\b/i;

/** Reject unsupported billing claims and require the legal anchor for refund wording. */
function assertSupportedPricingClaim(line: string) {
	expect(line).not.toMatch(UNSUPPORTED_CLAIM);
	if (REFUND_CLAIM.test(line)) {
		expect(line).toMatch(REFUND_ANCHOR);
	}
}

const REFUND_PROMISES = [
	'Get your money back within 7 days.',
	'A money-back guarantee applies.',
	'Get a reimbursement within 7 days.',
	'We reimburse payments within 7 days.',
	'Get a refund within 7 days.',
	'You can cancel within 7 days.',
	'Get your credits back within 7 days.',
	'Your credits are returned within 7 days.',
	'Your credit is returned within 7 days.',
	'Unused credits will be returned within 7 days.'
];

describe('pricing copy guardrails', () => {
	it.each(REFUND_PROMISES)('rejects an unanchored refund promise: %s', (line) => {
		expect(() => assertSupportedPricingClaim(line)).toThrow();
	});

	it.each(REFUND_PROMISES)('accepts a legally anchored refund promise: %s', (line) => {
		expect(() => assertSupportedPricingClaim(`${line} CDC Art. 49.`)).not.toThrow();
	});

	it.each([
		'One credit is used for each moderation score.',
		'Feedback digest classifications also use credits.',
		'400 purchased credits left.',
		'Top-up purchase: 500 credits ($20.40).'
	])('accepts credit accounting without a refund anchor: %s', (line) => {
		expect(() => assertSupportedPricingClaim(line)).not.toThrow();
	});

	it('discloses zero-usage recurrence and separate moderation and digest classifications', () => {
		const subscription = PRICING_FAQ_ENTRIES.find(({ q }) => q === 'Is there a subscription?')?.a;
		expect(subscription).toMatch(/even (?:with|when).*no (?:comments|AI classifications)/i);
		expect(subscription).toContain('100 AI classifications');
		const usage = PRICING_FAQ_ENTRIES.find(({ q }) => /run out/.test(q))?.a;
		expect(usage).toMatch(/one credit.*moderation.*one.*digest/i);
		expect(usage).toMatch(/400.*(?:left|remain)/i);
		expect(usage).toMatch(/requested history.*again/i);
	});

	it('limits the calculator to hosted monthly purchases and excludes BYOK provider costs', () => {
		const calculator = readFileSync(new URL('../components/landing/pricing/CostMath.svelte', import.meta.url), 'utf8');
		expect(calculator).toMatch(/zero purchased (?:credits|balance)/i);
		expect(calculator).toMatch(/full.*100.*allowance/i);
		expect(calculator).toMatch(/both.*bundles.*available/i);
		expect(calculator).toMatch(/independent.*zero-balance/i);
		expect(calculator).toMatch(/lifetime.*\$49.*once/i);
		expect(calculator).toMatch(/OpenAI.*(?:separate|excluded|outside)/i);
		expect(calculator).not.toMatch(/free tier is waving/i);
	});
	it('ships exactly the 8 pricing FAQ pairs, each a real question with a real answer', () => {
		expect(PRICING_FAQ_ENTRIES).toHaveLength(8);
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

	it('keeps automation opt-in and refund promises anchored to the legal policy', () => {
		// the approved policy is present, verbatim
		expect(PRICING_COPY.join(' ')).toContain(APPROVED_POLICY);
		for (const line of CLAIM_LINES) {
			assertSupportedPricingClaim(line);
		}
	});
});

it('describes PolyForm as source-available consistently across homepage and pricing surfaces', () => {
	const sources = [
		...COMPONENT_SURFACES,
		'../components/landing/TrustBar.svelte',
		'../components/landing/FinalCta.svelte',
		'./faq.ts',
		'./pricing-faq.ts'
	].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));
	for (const text of sources) {
		expect(text).not.toMatch(/\bopen[ -]source\b/i);
		if (/PolyForm/.test(text)) expect(text).toMatch(/source-available/i);
	}
	expect(PRICING_FAQ_ENTRIES.find(({ q }) => q === 'Why is self-hosting free?')?.a).toContain('PolyForm Shield 1.0.0');
});

it('discloses irreversible moderation actions instead of promising universal undo', () => {
	const howItWorks = readFileSync(new URL('../components/landing/HowItWorks.svelte', import.meta.url), 'utf8');
	for (const text of [TICKS_SELF_HOSTED_DETAILED.join(' '), howItWorks]) {
		expect(text).not.toMatch(/every action reversible|reversible, always|crash mid-run never repeats an action/i);
		expect(text).toMatch(/held and rejected comments can be restored/i);
		expect(text).toMatch(/deletions? (?:are|is) permanent/i);
		expect(text).toMatch(/author bans? cannot be lifted in Moderaty/i);
	}
});

it('preserves the approved hosted and lifetime offers with BYOK disclosure', () => {
	const subscription = PRICING_FAQ_ENTRIES.find(({ q }) => q === 'Is there a subscription?')?.a;
	expect(subscription).toContain('$5 a month');
	expect(subscription).toContain('100 AI classifications');
	const lifetime = PRICING_FAQ_ENTRIES.find(({ q }) => q === 'What is the $49 lifetime deal?')?.a;
	expect(lifetime).toContain('First 1,000 users');
	expect(lifetime).toContain('one $49 payment');
	expect(lifetime).toContain('hosted forever');
	expect(lifetime).toContain('your own OpenAI API key');
});

it('explains channel setup and video context alongside comment moderation on shared CTAs', () => {
	for (const path of ['../components/landing/FinalCta.svelte', '../components/landing/TrustBar.svelte']) {
		const text = readFileSync(new URL(path, import.meta.url), 'utf8');
		expect(text).not.toMatch(/used only on your comments/i);
		expect(text).toContain('channel setup');
		expect(text).toContain('comment moderation');
		expect(text).toContain('video titles and descriptions');
	}
});
