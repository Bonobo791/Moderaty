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

export type LegalTocEntry = { id: string; label: string };

export type LegalDoc = {
	/** Route slug under the site root, e.g. `terms` → `/terms`. */
	slug: string;
	/** Short label used in the footer link list. */
	label: string;
	/** Mono kicker rendered above the title (the docs' English subtitle). */
	kicker: string;
	title: string;
	version: string;
	effectiveDate: string;
	description: string;
	/** Anchored contents list; each id exists in the document component. */
	toc: LegalTocEntry[];
};

export const LEGAL_EFFECTIVE_DATE = '5 August 2026';
// 1.6: commenter handles are now retained in the activity log for up to 30
// days (automatic + on-demand erasure), so the "author identifiers never
// stored from comments" promise was rewritten across the Privacy Policy,
// Terms, DPA, footer, and FAQ.
// 1.5: Terms §6.1(c) corrected — the lifetime hosted plan has no per-account
// key flow (hosted scoring runs on the deployment's OPENAI_API_KEY), so the
// "your own OpenAI key" promise was removed from the lifetime clause.
export const LEGAL_VERSION = '1.6';
export const LEGAL_KICKER = 'YouTube Comment Moderation Service';

/**
 * Every published legal doc shares the kicker, version, and effective date;
 * only the identity and the table of contents differ. One builder keeps the
 * shared fields in a single place.
 */
function defineDoc(
	slug: string,
	label: string,
	title: string,
	description: string,
	toc: LegalTocEntry[]
): LegalDoc {
	return {
		slug,
		label,
		kicker: LEGAL_KICKER,
		title,
		version: LEGAL_VERSION,
		effectiveDate: LEGAL_EFFECTIVE_DATE,
		description,
		toc
	};
}

export const TERMS_DOC: LegalDoc = defineDoc(
	'terms',
	'Terms',
	'Terms of Service',
	'The binding contract for using Moderaty: eligibility, the service, YouTube API terms, plans, billing and auto top-up, refunds, acceptable use, liability, and governing law (Brazil).',
	[
		{ id: 's1', label: '1. Agreement and Acceptance' },
		{ id: 's2', label: '2. Definitions' },
		{ id: 's3', label: '3. Eligibility and Your Account' },
		{ id: 's4', label: '4. The Service' },
		{ id: 's5', label: '5. YouTube API Services and Third-Party Terms' },
		{ id: 's6', label: '6. Plans, Billing and Auto Top-Up' },
		{ id: 's7', label: '7. Right of Withdrawal and Refunds' },
		{ id: 's8', label: '8. Acceptable Use' },
		{ id: 's9', label: '9. Moderation Actions and Your Responsibility' },
		{ id: 's10', label: '10. Privacy and Data Protection' },
		{ id: 's11', label: '11. Intellectual Property' },
		{ id: 's12', label: '12. Third-Party Services and Platform Dependency' },
		{ id: 's13', label: '13. Service Availability, Changes and Suspension' },
		{ id: 's14', label: '14. Warranty Disclaimer' },
		{ id: 's15', label: '15. Limitation of Liability' },
		{ id: 's16', label: '16. Indemnification' },
		{ id: 's17', label: '17. Term and Termination' },
		{ id: 's18', label: '18. Changes to These Terms' },
		{ id: 's19', label: '19. Governing Law, Forum and Dispute Resolution' },
		{ id: 's20', label: '20. General Provisions' },
		{ id: 's21', label: '21. Contact and Data Protection Officer' }
	]
);

export const PRIVACY_DOC: LegalDoc = defineDoc(
	'privacy',
	'Privacy',
	'Privacy Policy',
	'How Moderaty processes personal data under the LGPD: what we collect, legal bases, retention, YouTube API disclosures, international transfers, and your rights.',
	[
		{ id: 's1', label: '1. Who We Are and What This Policy Covers' },
		{ id: 's2', label: '2. The Data We Process, and Why' },
		{ id: 's3', label: '3. Comment Data: We Are the Processor, Not the Controller' },
		{ id: 's4', label: '4. YouTube API Services Disclosures' },
		{ id: 's5', label: '5. Sharing and Recipients' },
		{ id: 's6', label: '6. International Data Transfers' },
		{ id: 's7', label: '7. Retention and Deletion' },
		{ id: 's8', label: '8. Security' },
		{ id: 's9', label: '9. Legitimate Interest Notice' },
		{ id: 's10', label: '10. Your Rights' },
		{ id: 's11', label: '11. Children and Adolescents' },
		{ id: 's12', label: '12. Cookies and Similar Technologies' },
		{ id: 's13', label: '13. Changes to This Policy' },
		{ id: 's14', label: '14. Language and Governing Law' }
	]
);

export const DPA_DOC: LegalDoc = defineDoc(
	'dpa',
	'DPA',
	'Data Processing Agreement',
	'The LGPD data processing agreement between you (controller) and Moderaty (processor) for YouTube comment data: comment-data minimization (commenter handles appear in the activity log for up to 30 days, then are erased automatically, and can be erased on demand; no other author identifiers stored), sub-processors, and ANPD transfer clauses.',
	[
		{ id: 's1', label: '1. Purpose and Scope' },
		{ id: 's2', label: '2. Definitions' },
		{ id: 's3', label: '3. Roles of the Parties' },
		{ id: 's4', label: '4. Subject Matter, Duration, Nature and Purpose' },
		{ id: 's5', label: '5. Controller Obligations and Lawful Basis' },
		{ id: 's6', label: '6. Processor Obligations' },
		{ id: 's7', label: '7. Data Minimization and Author-Identifier Retention Limits' },
		{ id: 's8', label: '8. Sensitive Personal Data' },
		{ id: 's9', label: '9. Data of Children and Adolescents' },
		{ id: 's10', label: '10. Sub-processors' },
		{ id: 's11', label: '11. International Data Transfers' },
		{ id: 's12', label: '12. Security Measures' },
		{ id: 's13', label: '13. Data Subject Requests' },
		{ id: 's14', label: '14. Personal Data Incident Notification' },
		{ id: 's15', label: '15. Statutory Log Retention (Marco Civil)' },
		{ id: 's16', label: '16. Audits and Compliance Documentation' },
		{ id: 's17', label: '17. Term, Termination and Deletion' },
		{ id: 's18', label: '18. Liability' },
		{ id: 's19', label: '19. Governing Law, Language and Disputes' },
		{ id: 's20', label: '20. Final Provisions' },
		{ id: 'signature', label: 'Signature Page' },
		{ id: 'annex-1', label: 'Annex I — Details of the Processing' },
		{ id: 'annex-2', label: 'Annex II — Technical and Organizational Measures' },
		{ id: 'annex-3', label: 'Annex III — Authorized Sub-processors' },
		{ id: 'annex-4', label: 'Annex IV — International Transfer Mechanism' }
	]
);

export const LEGAL_DOCS: LegalDoc[] = [TERMS_DOC, PRIVACY_DOC, DPA_DOC];
