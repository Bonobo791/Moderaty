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

// Guard for the PR #39 review finding: Clause 11.3 made Annex III the record
// of Turso's enabled edge-replica regions, but the Annex III Turso row (and
// Privacy 6.3) deferred to separate "transfer records" — two record
// locations for the same authorization. There is exactly one: Annex III.
describe('replica-region record location (PR #39 review)', () => {
	it('Annex III itself states the enabled Turso replica regions, with no deferral', () => {
		const dpa = readComponent('dpa');
		const annex3 = dpa.slice(dpa.indexOf('id="annex-3"'), dpa.indexOf('id="annex-4"'));
		expect(annex3).not.toMatch(/transfer records/i);
		expect(annex3).toMatch(/edge replicas: none currently enabled/i);
	});

	it('Clause 11.3 keeps Annex III as the record and bars unrecorded regions', () => {
		expect(readComponent('dpa')).toMatch(
			/shall not enable database replicas in regions not recorded in Annex III/
		);
	});

	it('Privacy 6.3 points replica regions at the same single record', () => {
		const privacy = readComponent('privacy');
		expect(privacy).not.toMatch(/replicas[^.]*transfer records/i);
		expect(privacy).toContain('operate only in regions recorded in Annex III of the DPA');
	});
});
