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
import { PRIVACY_NOTICE_TEXT, REFUND_NOTICE_TEXT, AUTO_TOPUP_CONSENT_TEXT } from '../server/legal';
import { FAQ_ENTRIES } from './faq';
import { LEGAL_DOCS, LEGAL_EFFECTIVE_DATE, LEGAL_VERSION } from './legal';import { PRICING_FAQ_ENTRIES } from './pricing-faq';

const COMPONENTS: Record<string, string> = {
	terms: 'Terms.svelte',
	privacy: 'Privacy.svelte',
	dpa: 'Dpa.svelte'
};

function readComponent(slug: string): string {
	return readFileSync(
		new URL(`../components/landing/legal/${COMPONENTS[slug]}`, import.meta.url),
		'utf8'
	);
}

function readRoute(slug: string, file: string): string {
	return readFileSync(new URL(`../../routes/${slug}/${file}`, import.meta.url), 'utf8');
}

describe('LEGAL_DOCS', () => {
	it('the billing terms (auto top-up authorization, bundle refunds) shipped under a NEW legal version', () => {
		// The STRIPE BILLING commit rewrote Terms §6.1/§6.2 materially (bundle
		// model, unscheduled auto top-up authorization) — that is exactly the
		// "material legal-doc change" that must bump LEGAL_VERSION so the
		// re-consent gate (hasCurrentConsent) routes every user back through
		// /consent. Never let billing terms ride along under an old version.
		expect(LEGAL_VERSION).toBe('1.7');
	});

	it('lists exactly the three published legal documents', () => {
		expect(LEGAL_DOCS.map((d) => d.slug)).toEqual(['terms', 'privacy', 'dpa']);
		expect(LEGAL_DOCS.map((d) => d.label)).toEqual(['Terms', 'Privacy', 'DPA']);
	});

	it('every doc carries the shared version, effective date, title, and description', () => {
		for (const doc of LEGAL_DOCS) {
			expect(doc.version).toBe(LEGAL_VERSION);
			expect(doc.effectiveDate).toBe(LEGAL_EFFECTIVE_DATE);
			expect(doc.effectiveDate.length).toBeGreaterThan(0);
			expect(doc.title.length).toBeGreaterThan(0);
			expect(doc.description.length).toBeGreaterThan(0);
		}
	});

	it('slugs are unique and route-safe', () => {
		const slugs = LEGAL_DOCS.map((d) => d.slug);
		expect(new Set(slugs).size).toBe(slugs.length);
		for (const slug of slugs) {
			expect(slug).toMatch(/^[a-z]+$/);
		}
	});

	it('every doc carries a kicker and a non-empty toc with unique anchor ids', () => {
		for (const doc of LEGAL_DOCS) {
			expect(doc.kicker.length).toBeGreaterThan(0);
			expect(doc.toc.length).toBeGreaterThan(0);
			const ids = doc.toc.map((t) => t.id);
			expect(new Set(ids).size).toBe(ids.length);
			for (const entry of doc.toc) {
				expect(readComponent(doc.slug)).toContain(`id="${entry.id}"`);
			}
		}
	});
});

// Guards for findings from the PR #35 review. Each test fails if the reviewed
// content regresses.
describe('legal page content (PR #35 review)', () => {
	it('links the Google Privacy Policy over HTTPS everywhere', () => {
		for (const doc of LEGAL_DOCS) {
			expect(readComponent(doc.slug)).not.toContain('http://www.google.com/policies/privacy');
		}
	});

	it('spells the statutory Portuguese names with diacritics', () => {
		for (const doc of LEGAL_DOCS) {
			expect(readComponent(doc.slug)).not.toMatch(/Protecao|Politica/);
		}
	});

	it('wraps every Terms highlight clause in a block element', () => {
		const bare = readComponent('terms')
			.split('\n')
			.filter((line) => line.trimStart().startsWith('<strong class="highlight"'));
		expect(bare).toEqual([]);
	});

	it('discloses the same sub-processors in the Privacy Policy as in DPA Annex III', () => {
		const privacy = readComponent('privacy');
		for (const provider of ['Netlify', 'Turso', 'OpenAI', 'Stripe']) {
			expect(privacy).toContain(provider);
		}
	});

	it('names Stripe as the user-billing processor, disclosed but outside the comment-data DPA scope', () => {
		expect(readComponent('privacy')).toMatch(/Stripe, Inc\. \(payment processing/);
		const dpa = readComponent('dpa');
		// The Annex III note names Stripe as the processor of user billing data
		// acting for Moderaty; it must never appear as an Annex III sub-processor
		// table row, since it handles no Comment Data.
		expect(dpa).toMatch(/Stripe, Inc\.[\s\S]*outside the scope of this DPA/);
		expect(dpa).not.toMatch(/<td>\s*Stripe/);
	});

	it('does not claim a Portuguese version is already published', () => {
		expect(readComponent('terms')).not.toContain('published in English and Portuguese');
		expect(readComponent('privacy')).not.toContain('published in English and Portuguese');
	});

	it('prerenders every legal route', () => {
		for (const doc of LEGAL_DOCS) {
			expect(readRoute(doc.slug, '+page.ts')).toContain('export const prerender = true');
		}
	});
});

// Guard for the comment-PII storage reality: the app stores comment text
// (≤500 chars) with the moderation outcome, plus the commenter's normalized
// public handle on the audit-log/moderation-action record for a strict 30
// days (cron sweep) with on-demand per-channel erasure from the log page.
// Other author identifiers (display name, author channel ID) are still never
// persisted. Public copy must say exactly that — the earlier absolute
// "author identifiers never stored from comments" claim became false when
// handle retention shipped and is banned below.
describe('storage claims match implementation (comment PII)', () => {
	const surfaces: Record<string, string> = {
		'Terms of Service': readComponent('terms'),
		'Privacy Policy': readComponent('privacy'),
		DPA: readComponent('dpa'),
		footer: readFileSync(new URL('../components/landing/Footer.svelte', import.meta.url), 'utf8'),
		FAQ: FAQ_ENTRIES.map((f) => `${f.q} ${f.a}`).join('\n'),
		'doc descriptions': LEGAL_DOCS.map((d) => d.description).join('\n')
	};

	it('no surface claims comments are discarded or never stored', () => {
		const RETIRED_CLAIMS = [
			/process-and-discard/i,
			/processed and discarded/i,
			/classified and discarded/i,
			/no comment bodies/i,
			/without comment bodies/i,
			/excludes comment bodies/i,
			/immediate discard of raw comment content/i,
			/comments are [^.]*never stored/i,
			/comment (text|content) is never (persistently )?stored/i
		];
		for (const [name, text] of Object.entries(surfaces)) {
			for (const pattern of RETIRED_CLAIMS) {
				expect(text, `${name} still claims: ${pattern}`).not.toMatch(pattern);
			}
		}
	});

	// PR #40 review: comment text is retained in Moderation Outcome Data, so
	// statutory connection logs are not the "sole/only retention exception" —
	// that phrasing contradicts Terms §4.2 / DPA §7 wherever it appears.
	it('statutory logs are not framed as the sole retention exception', () => {
		for (const doc of ['terms', 'dpa'] as const) {
			expect(readComponent(doc), doc).not.toMatch(
				/sole documented retention exception|only retention exception/i
			);
			expect(readComponent(doc), doc).toMatch(/Marco Civil[^.]*Moderation Outcome Data/i);
		}
	});

	// PR #40 review: author identifiers are processed in memory only — never
	// cache, disk, or any "ephemeral storage" a definition could smuggle in.
	it('no surface authorizes ephemeral storage for author identifiers', () => {
		for (const [name, text] of Object.entries(surfaces)) {
			expect(text, name).not.toMatch(/ephemeral\s+storage/i);
		}
	});

	// The current promise: the commenter's normalized public handle appears in
	// the activity log for up to 30 days, is erased automatically by the cron
	// sweep, and can be erased on demand at any time. Every surface that makes
	// the storage promise must carry the full mechanism — a partial or
	// absolute claim is drift.
	it('every surface states the 30-day handle retention promise', () => {
		const HANDLE_PROMISE =
			/handle[\s\S]{0,160}activity log[\s\S]{0,160}30 days[\s\S]{0,160}automatically[\s\S]{0,160}on demand/i;
		for (const [name, text] of Object.entries(surfaces)) {
			expect(text, `${name} is missing the 30-day handle retention promise`).toMatch(
				HANDLE_PROMISE
			);
		}
	});

	// The retired absolute claim: author identifiers were said to be never
	// stored from comments. False since handle retention shipped — these
	// phrasings must never silently return.
	it('no surface repeats the retired never-stored author-identifier claim', () => {
		const RETIRED_AUTHOR_CLAIMS = [
			/never stored from comments/i,
			/processed in memory at decision time and are never stored/i,
			/author identifiers? are processed in memory only and never stored/i,
			/comment author (identities|identifiers) are never (persistently )?stored/i,
			/author identities are never stored/i,
			/author identifiers? were never stored/i,
			/excludes author identifiers/i,
			/processed transiently and never stored/i
		];
		for (const [name, text] of Object.entries(surfaces)) {
			for (const pattern of RETIRED_AUTHOR_CLAIMS) {
				expect(text, `${name} still claims: ${pattern}`).not.toMatch(pattern);
			}
		}
	});

	// The companion minimization claim: handles aside, no author channel IDs
	// and no author profiles are kept anywhere.
	it('the legal documents state no author channel IDs or profiles are kept', () => {
		for (const doc of ['privacy', 'dpa', 'terms'] as const) {
			expect(readComponent(doc), doc).toMatch(
				/no author channel\s+(IDs?|identifiers?)[^.]{0,30}(kept|retained|stored)/i
			);
		}
	});

	// PR #40 review: Privacy §3.4 claimed "we cannot identify a comment's
	// author". That is unsupported — the comments table stores the YouTube
	// comment ID, and while the channel owner's access remains active that ID
	// could re-identify the author via YouTube. The defensible claim is
	// narrower: beyond the 30-day activity-log handle, identifiers are not
	// persistently stored or linked in Moderaty's own database. Note §3.3's
	// "whose age we cannot identify" is about age and must NOT trip this guard.
	it('Privacy §3.4 does not make the absolute no-identification claim', () => {
		const match = readComponent('privacy').match(/<strong>3\.4<\/strong>([\s\S]*?)<\/p>/);
		expect(match, 'Privacy §3.4 paragraph not found').not.toBeNull();
		const s34 = match?.[1] ?? '';
		expect(s34).not.toMatch(/cannot identify a comment's author/i);
		expect(s34).not.toMatch(/link stored comment text back/i);
		expect(s34).not.toMatch(/never store author identifiers/i);
		// the claim must be scoped by the handle exception, not absolute
		expect(s34).toMatch(/public handle/i);
		expect(s34).toMatch(/not persistently stored or linked/i);
		expect(s34).toMatch(/YouTube comment ID/i);
		expect(s34).toMatch(/5 business days/i);
	});

	// PR #40 review: rules.pattern with type 'user' persists an owner-entered
	// authorChannelId (matched in memory by rules.ts), and the rules page's
	// protected handles are likewise owner-entered configuration. The handle
	// retention promise covers identifiers taken FROM comments; the
	// owner-configured identifiers are a documented exception and every
	// authoritative surface must say so.
	it('scopes the claim: identifiers entered in user rules are carved out', () => {
		expect(readComponent('privacy')).toMatch(/blocked-user|user rules?[^.]*configuration/i);
		expect(readComponent('terms')).toMatch(/user rules?/i);
		expect(readComponent('dpa')).toMatch(/user rules?/i);
		const schema = readFileSync(new URL('../server/db/schema.ts', import.meta.url), 'utf8');
		expect(schema).toMatch(/user rules?/i);
	});

	// Privacy marketing claims (homepage TrustBar, the LGPD FAQ answer, and the
	// consent-page privacy notice) must be scoped to "what your account needs
	// to run": account data IS stored while the account exists (Privacy §2), so
	// an absolute zero-data claim would contradict the Policy.
	it('user-data privacy claims are scoped to account needs, never absolute', () => {
		const trustBar = readFileSync(new URL('../components/landing/TrustBar.svelte', import.meta.url), 'utf8');
		const lgpdFaq = FAQ_ENTRIES.find((f) => f.q === 'Is Moderaty LGPD compliant?');
		expect(lgpdFaq, 'LGPD FAQ entry missing').toBeDefined();
		const ABSOLUTE = [/we (do not|don't) store/i, /stores? nothing about you\b(?![^.]*beyond)/i];
		for (const text of [trustBar, lgpdFaq?.a ?? '', PRIVACY_NOTICE_TEXT]) {
			expect(text).toMatch(/account needs to run/i);
			for (const pattern of ABSOLUTE) {
				expect(text).not.toMatch(pattern);
			}
		}
	});
});

// Guard for the PR #38 review finding: the consent notice, hosted plan panel,
// and pricing FAQ promised refunds of unused credits beyond the Terms §7
// 7-day withdrawal window. Maintainer-directed policy: refunds exist ONLY
// inside the 7-day CDC Art. 49 window; outside it all sales are final — no
// refunds of unused credits, not on account closure, not on our termination,
// not on price or Terms changes — except where applicable law requires.
describe('refund policy consistency (PR #38 review)', () => {
	const surfaces: Record<string, string> = {
		'Terms of Service': readComponent('terms'),
		'hosted plan panel': readFileSync(
			new URL('../components/landing/PlanHosted.svelte', import.meta.url),
			'utf8'
		),
		'consent refund notice': REFUND_NOTICE_TEXT,
		'pricing FAQ': PRICING_FAQ_ENTRIES.map((f) => `${f.q} ${f.a}`).join('\n')
	};

	it('no surface promises refunds of unused credits outside the 7-day window', () => {
		const RETIRED_PROMISES = [
			/always refunded/i,
			/refunded when you close/i,
			/upon cancellation of your account/i,
			/refund(ing|s)? of (your )?unconsumed Credits/i,
			/refund unconsumed Credits/i
		];
		for (const [name, text] of Object.entries(surfaces)) {
			for (const pattern of RETIRED_PROMISES) {
				expect(text, `${name} still carries a retired promise: ${pattern}`).not.toMatch(pattern);
			}
		}
		for (const name of ['hosted plan panel', 'consent refund notice', 'pricing FAQ']) {
			expect(surfaces[name], name).toMatch(/full refund/i);
		}
	});

	// Maintainer-directed: post-window finality is stated ONLY in the Terms
	// (§7.2-7.3) and other legally required places — consumer surfaces show
	// the 7-day full refund without the "after that, all sales are final" tail.
	it('states post-window finality only in the Terms, never on consumer surfaces', () => {
		const FINALITY = [
			/sales are final/i,
			/purchases are final/i,
			/not refunded/i,
			/not refundable/i,
			/no refunds?\b.*\bafter\b/i,
			/refunds?\b.*\b(?:not available|unavailable|not refundable|not refunded)\b.*\b(?:after|outside)\b/i,
			/(?:unused|unconsumed) credits?\b.*\b(?:excluded|not refundable|not refunded)\b/i
		];
		for (const name of ['hosted plan panel', 'consent refund notice', 'pricing FAQ']) {
			for (const pattern of FINALITY) {
				expect(surfaces[name], `${name} states finality: ${pattern}`).not.toMatch(pattern);
			}
		}
		const terms = surfaces['Terms of Service'];
		expect(terms).toMatch(/purchases are final/i);
		expect(terms).toMatch(/not refundable/i);
	});

// Guard for the billing integration: the Usage page's auto top-up consent
// checkbox (Stripe's unscheduled-top-ups compliance requirement) must be
// grounded verbatim in the Terms — the form can never drift from the logged
// contract sentence.
describe('auto top-up consent (billing integration)', () => {
	it('the consent checkbox sentence appears verbatim in Terms §6.2', () => {
		const terms = readComponent('terms');
		const s62Start = terms.indexOf('<strong>6.2</strong>');
		const s62 = terms.slice(s62Start, terms.indexOf('</p>', s62Start));
		expect(s62).toContain(AUTO_TOPUP_CONSENT_TEXT);
	});
});

// Guard for the PR #47 review findings: §6 introduced subscription, lifetime,
// and top-up charges, but §1.2 and §7.3 still framed acceptance and
// post-window finality around "purchasing credits" only, and §6.2-6.3 sent
// users to an "account settings" page that does not exist. Acceptance,
// finality, and cancellation must cover every charge type through a mechanism
// that actually exists today (the Section 21 contact channels).
describe('Terms billing scope (PR #47 review)', () => {
	it('acceptance and post-window finality cover every charge type, not credits only', () => {
		const terms = readComponent('terms');
		const s12start = terms.indexOf('<strong>1.2</strong>');
		const s12 = terms.slice(s12start, terms.indexOf('</p>', s12start));
		expect(s12).not.toMatch(/purchasing credits/i);
		expect(s12).toMatch(/making a purchase/i);
		const s73start = terms.indexOf('<strong class="highlight">7.3');
		const s73 = terms.slice(s73start, terms.indexOf('</strong>', s73start));
		expect(s73).not.toMatch(/BY PURCHASING CREDITS/);
		expect(s73).toMatch(/PURCHASES ARE NOT REFUNDABLE/i);
		expect(s73).toMatch(/SUBSCRIPTION CHARGES, THE LIFETIME PLAN, AND TOP-UP CREDITS/i);
	});

	it('billing changes use the contact channel, not a settings UI that does not exist', () => {
		expect(readComponent('terms')).not.toMatch(/in your account settings/i);
	});
});

	it('Terms §7.1 carries the statutory no-deductions language', () => {
		const terms = readComponent('terms');
		expect(terms).toMatch(/at any title/i);
		expect(terms).toMatch(/without deductions of any kind/i);
		expect(terms).toMatch(/monetarily updated/i);
	});

	// The undo feature's honesty guard: §9.4 must disclose exactly which
	// moderation actions cannot be reversed (YouTube offers no API for them).
	it('Terms §9.4 discloses which moderation actions are reversible and which are not', () => {
		const terms = readComponent('terms');
		const s94 = terms.slice(terms.indexOf('<strong>9.4</strong>'), terms.indexOf('id="s10"'));
		expect(s94).toMatch(/audit log/i);
		expect(s94).toMatch(/hold and reject actions can be reversed/i);
		expect(s94).toMatch(/deleted comments? cannot be (?:restored|reversed|undone)/i);
		expect(s94).toMatch(/author bans? cannot be (?:lifted|reversed|undone)/i);
	});
});

// PR #26 post-merge review triage (codeant findings): the OAuth scope is
// youtube.force-ssl — YouTube offers no comments-only scope — so copy must
// not claim Google asks for "comment access only". And user rules act before
// AI scoring (pipeline: a rule match short-circuits aiDecision), so the FAQ
// may not claim that ONLY a 0.95+ AI score triggers an automatic ban.
describe('OAuth scope and ban claims match implementation', () => {
	it('no surface claims Google asks for comment access only', () => {
		const scopeSurfaces: Record<string, string> = {
			FAQ: FAQ_ENTRIES.map((f) => `${f.q} ${f.a}`).join('\n'),
			FinalCta: readFileSync(
				new URL('../components/landing/FinalCta.svelte', import.meta.url),
				'utf8'
			),
			TrustBar: readFileSync(
				new URL('../components/landing/TrustBar.svelte', import.meta.url),
				'utf8'
			)
		};
		for (const [name, text] of Object.entries(scopeSurfaces)) {
			expect(text, `${name} still claims comment-only access`).not.toMatch(
				/comment access only/i
			);
		}
	});

	it('the FAQ acknowledges rule-based bans alongside the AI threshold', () => {
		// Rules act before AI scoring (pipeline: a rule match short-circuits
		// aiDecision), so the ban answer must not present 0.95 as the only
		// path to an automatic ban.
		const banFaq = FAQ_ENTRIES.find((f) => f.q === 'Will Moderaty ban my real fans?');
		expect(banFaq, 'ban FAQ entry missing').toBeDefined();
		expect(banFaq?.a).toMatch(/ban rule bans/i);
	});

	it('the FAQ acknowledges tone-score bans alongside toxicity', () => {
		// pipeline.ts passes toneScore through the same aiOutcome AUTO_BAN=0.95
		// threshold, so a 0.95+ tone score also bans automatically; the ban
		// answer must not present toxicity as the only AI path.
		const banFaq = FAQ_ENTRIES.find((f) => f.q === 'Will Moderaty ban my real fans?');
		expect(banFaq, 'ban FAQ entry missing').toBeDefined();
		expect(banFaq?.a).toMatch(/0\.95 or higher.*toxicity or tone analysis.*trigger an automatic ban/i);
	});

	it('the access FAQ discloses video title/description reads', () => {
		// youtube.ts calls videos.list to read video titles/descriptions as
		// tone-scoring context (pipeline.ts), so "only to read and moderate
		// comments" understates what the token is used for.
		const accessFaq = FAQ_ENTRIES.find(
			(f) => f.q === 'What YouTube account access does Moderaty need?'
		);
		expect(accessFaq, 'access FAQ entry missing').toBeDefined();
		expect(accessFaq?.a).toMatch(/read.*titles? and descriptions?.*context.*tone analysis/i);
	});

	it('the access FAQ discloses listing the account channels when connecting', () => {
		// callback/+server.ts fetchOwnedChannels paginates channels.list
		// (part=snippet, mine=true) over EVERY channel the Google account owns
		// (brand accounts included) so the picker can list them, and parks that
		// list in an encrypted state-keyed cookie while the user picks — so
		// "read and moderate comments ... nothing else" understates what the
		// token is used for.
		const accessFaq = FAQ_ENTRIES.find(
			(f) => f.q === 'What YouTube account access does Moderaty need?'
		);
		expect(accessFaq, 'access FAQ entry missing').toBeDefined();
		expect(accessFaq?.a).toMatch(/list.*channels.*(Google account|account owns).*(pick|choose)/i);
	});
});

// AI-cost claims match implementation, take two: the maintainer pulled the
// mechanism detail (free moderation endpoint, gpt-4.1-nano pricing) from the
// site entirely — public copy says "AI", nothing more. No surface may claim
// the AI or the model cost is free/zero, and no surface may name the
// endpoint, the model, or per-token prices.
describe('AI-cost claims match implementation', () => {
	const aiCostSurfaces: Record<string, string> = {
		'plan ticks': readFileSync(new URL('./plans.ts', import.meta.url), 'utf8'),
		'pricing FAQ': PRICING_FAQ_ENTRIES.map((f) => `${f.q} ${f.a}`).join('\n'),
		PricingHero: readFileSync(
			new URL('../components/landing/pricing/PricingHero.svelte', import.meta.url),
			'utf8'
		),
		PlanSelfHosted: readFileSync(
			new URL('../components/landing/PlanSelfHosted.svelte', import.meta.url),
			'utf8'
		),
		PlanLifetime: readFileSync(
			new URL('../components/landing/PlanLifetime.svelte', import.meta.url),
			'utf8'
		),
		CostMath: readFileSync(
			new URL('../components/landing/pricing/CostMath.svelte', import.meta.url),
			'utf8'
		)
	};

	it('no surface claims the AI or the model cost is free or zero', () => {
		const RETIRED = [
			/the AI is free/i,
			/model cost is zero/i,
			/nothing but electricity/i,
			/usually \$0/i,
			/stays free to run/i,
			/running cost is likely zero/i
		];
		for (const [name, text] of Object.entries(aiCostSurfaces)) {
			for (const pattern of RETIRED) {
				expect(text, `${name} still claims free AI: ${pattern}`).not.toMatch(pattern);
			}
		}
	});

	it('no surface names the moderation endpoint, the model, or token pricing', () => {
		const MECHANISM = [/moderation endpoint/i, /gpt-4\.1-nano/i, /v1\/moderations/i, /fractions of a cent/i];
		for (const [name, text] of Object.entries(aiCostSurfaces)) {
			for (const pattern of MECHANISM) {
				expect(text, `${name} still names AI internals: ${pattern}`).not.toMatch(pattern);
			}
		}
	});
});

// Lifetime BYOK claims removed: there is no per-account key flow — hosted
// scoring (lifetime included) runs on the deployment's env.OPENAI_API_KEY
// (moderation.ts, tone.ts), so "lifetime buyers score on their own account"
// and "we never see the key" were false for hosted buyers. BYOK claims may
// only appear where they are true: the self-hosted tier. Restore the lifetime
// claims only when the per-account key flow ships.
describe('lifetime BYOK claims match the missing key flow', () => {
	const lifetimeSurfaces: Record<string, string> = {
		PlanLifetime: readFileSync(
			new URL('../components/landing/PlanLifetime.svelte', import.meta.url),
			'utf8'
		),
		'homepage pricing section': readFileSync(
			new URL('../components/landing/Pricing.svelte', import.meta.url),
			'utf8'
		),
		'pricing page meta': readRoute('pricing', '+page.svelte')
	};

	it('no surface ties the lifetime plan to BYOK or a buyer-owned key', () => {
		const RETIRED = [/lifetime[^.]*BYOK|BYOK[^.]*lifetime/i, /lifetime[^.;]*own OpenAI key/i];
		for (const [name, text] of Object.entries(lifetimeSurfaces)) {
			for (const pattern of RETIRED) {
				expect(text, `${name} still sells lifetime BYOK: ${pattern}`).not.toMatch(pattern);
			}
		}
		const lifetimeTicks = readFileSync(new URL('./plans.ts', import.meta.url), 'utf8');
		expect(lifetimeTicks).not.toMatch(/Your OpenAI key, your model cost/);
		const lifetimeFaq = PRICING_FAQ_ENTRIES.find((f) => f.q === 'What is the $49 lifetime deal?');
		expect(lifetimeFaq?.a).not.toMatch(/own OpenAI key/i);
	});

	it('Terms §6.1 clause (c) no longer promises lifetime buyers their own key', () => {
		const terms = readComponent('terms');
		const s61 = terms.slice(terms.indexOf('<strong>6.1</strong>'));
		expect(s61.slice(0, s61.indexOf('</p>'))).not.toMatch(/\(c\)[^;]*OpenAI key/i);
	});

	it('the BYOK FAQ answer is scoped to self-hosting, where the claim is true', () => {
		const byok = PRICING_FAQ_ENTRIES.find((f) => f.q === 'What does BYOK mean?');
		expect(byok, 'BYOK FAQ entry missing').toBeDefined();
		expect(byok?.a).toMatch(/self-host/i);
		expect(byok?.a).not.toMatch(/lifetime/i);
	});
});
