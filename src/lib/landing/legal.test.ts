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
import { REFUND_NOTICE_TEXT } from '../server/legal';
import { FAQ_ENTRIES } from './faq';
import { LEGAL_DOCS, LEGAL_EFFECTIVE_DATE, LEGAL_VERSION } from './legal';
import { PRICING_FAQ_ENTRIES } from './pricing-faq';

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

// Guard for the comment-PII change: the app stores comment text (≤500 chars)
// with the moderation outcome but never persists author identifiers. Public
// copy must say exactly that — the earlier "processed and discarded, never
// stored" claim contradicted the database and had to be corrected everywhere.
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

	it('the legal documents state that author identifiers are never stored', () => {
		for (const doc of ['privacy', 'dpa', 'terms'] as const) {
			expect(readComponent(doc), doc).toMatch(/author identifiers?[^.]*never (persistently )?stored|never store[^.]*author identifiers/i);
		}
	});

	// PR #40 review: Privacy §3.4 claimed "we cannot identify a comment's
	// author". That is unsupported — the comments table stores the YouTube
	// comment ID, and while the channel owner's access remains active that ID
	// could re-identify the author via YouTube. The defensible claim is
	// narrower: identifiers are not persistently stored or linked in
	// Moderaty's own database. Note §3.3's "whose age we cannot identify" is
	// about age and must NOT trip this guard.
	it('Privacy §3.4 does not make the absolute no-identification claim', () => {
		const match = readComponent('privacy').match(/<strong>3\.4<\/strong>([\s\S]*?)<\/p>/);
		expect(match, 'Privacy §3.4 paragraph not found').not.toBeNull();
		const s34 = match?.[1] ?? '';
		expect(s34).not.toMatch(/cannot identify a comment's author/i);
		expect(s34).not.toMatch(/link stored comment text back/i);
		// the scoped branch convention is "never stored from comments" (§3.2,
		// with the user-rule carve-out) — the unscoped absolute is banned here
		expect(s34).not.toMatch(/never store author identifiers/i);
		expect(s34).toMatch(/not persistently stored or linked/i);
		expect(s34).toMatch(/YouTube comment ID/i);
		expect(s34).toMatch(/5 business days/i);
	});

	// PR #40 review: rules.pattern with type 'user' persists an owner-entered
	// authorChannelId (matched in memory by rules.ts). The "never stored" claim
	// covers identifiers taken FROM comments; the owner-configured blocklist is
	// a documented exception and every authoritative surface must say so.
	it('scopes the claim: identifiers entered in user rules are carved out', () => {
		expect(readComponent('privacy')).toMatch(/blocked-user|user rules?[^.]*configuration/i);
		expect(readComponent('terms')).toMatch(/user rules?/i);
		expect(readComponent('dpa')).toMatch(/user rules?/i);
		const schema = readFileSync(new URL('../server/db/schema.ts', import.meta.url), 'utf8');
		expect(schema).toMatch(/user rules?/i);
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
				expect(text, `${name} still promises: ${pattern}`).not.toMatch(pattern);
			}
		}
	});

	it('Terms declares purchases final and credits non-refundable outside the withdrawal period', () => {
		const terms = readComponent('terms');
		expect(terms).toMatch(/all purchases are final/i);
		expect(terms).toMatch(/NOT REFUNDABLE/);
	});

	it('every commercial surface ties its refund mention to the 7-day window and the final-sale rule', () => {
		for (const name of ['hosted plan panel', 'consent refund notice', 'pricing FAQ']) {
			expect(surfaces[name], name).toMatch(/CDC Art\. 49/);
			expect(surfaces[name], name).toMatch(/final|not refunded/i);
		}
	});
});
