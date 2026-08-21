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
