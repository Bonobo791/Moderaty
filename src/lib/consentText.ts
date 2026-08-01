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

// Single-sourcing for the /consent checkbox sentence: the page receives
// CONSENT_CHECKBOX_TEXT from the load (the same constant the consent log
// stores as "the exact text shown") and renders it through this splitter, so
// the visible sentence can never drift from the logged one. Shared (not
// server-only) so the Svelte page can import it.

export type ConsentSegment = { text: string; href?: string };

/** Document titles linked inside the consent sentence, in sentence order. */
const CONSENT_DOC_LINKS = [
	{ title: 'Terms of Service', href: '/terms' },
	{ title: 'Privacy Policy', href: '/privacy' },
	{ title: 'Data Processing Agreement', href: '/dpa' }
];

/**
 * Splits the consent sentence into text and link segments, preserving every
 * character. Fails loudly when a document title is absent — the sentence and
 * its links are a legal artifact and must never silently degrade.
 */
export function segmentConsentText(text: string): ConsentSegment[] {
	const segments: ConsentSegment[] = [];
	let rest = text;
	for (const doc of CONSENT_DOC_LINKS) {
		const at = rest.indexOf(doc.title);
		if (at === -1) throw new Error(`consent sentence is missing the "${doc.title}" link target`);
		if (at > 0) segments.push({ text: rest.slice(0, at) });
		segments.push({ text: doc.title, href: doc.href });
		rest = rest.slice(at + doc.title.length);
	}
	if (rest) segments.push({ text: rest });
	return segments;
}
