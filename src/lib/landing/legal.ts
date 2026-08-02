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

export const LEGAL_EFFECTIVE_DATE = '1 August 2026';
export const LEGAL_VERSION = '1.3';
export const LEGAL_KICKER = 'YouTube Comment Moderation Service';

export const TERMS_DOC: LegalDoc = {
	slug: 'terms',
	label: 'Terms',
	kicker: LEGAL_KICKER,
	title: 'Terms of Service',
	version: LEGAL_VERSION,
	effectiveDate: LEGAL_EFFECTIVE_DATE,
	description:
		'The binding contract for using Moderaty: eligibility, the service, YouTube API terms, credits and billing, refunds, acceptable use, liability, and governing law (Brazil).',
	toc: [
		{ id: 's1', label: '1. Agreement and Acceptance' },
		{ id: 's2', label: '2. Definitions' },
		{ id: 's3', label: '3. Eligibility and Your Account' },
		{ id: 's4', label: '4. The Service' },
		{ id: 's5', label: '5. YouTube API Services and Third-Party Terms' },
		{ id: 's6', label: '6. Credits, Billing and Auto Top-Up' },
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
};

export const PRIVACY_DOC: LegalDoc = {
	slug: 'privacy',
	label: 'Privacy',
	kicker: LEGAL_KICKER,
	title: 'Privacy Policy',
	version: LEGAL_VERSION,
	effectiveDate: LEGAL_EFFECTIVE_DATE,
	description:
		'How Moderaty processes personal data under the LGPD: what we collect, legal bases, retention, YouTube API disclosures, international transfers, and your rights.',
	toc: [
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
};

export const DPA_DOC: LegalDoc = {
	slug: 'dpa',
	label: 'DPA',
	kicker: LEGAL_KICKER,
	title: 'Data Processing Agreement',
	version: LEGAL_VERSION,
	effectiveDate: LEGAL_EFFECTIVE_DATE,
	description:
		'The LGPD data processing agreement between you (controller) and Moderaty (processor) for YouTube comment data: comment-data minimization (author identifiers never stored from comments), sub-processors, and ANPD transfer clauses.',
	toc: [
		{ id: 's1', label: '1. Purpose and Scope' },
		{ id: 's2', label: '2. Definitions' },
		{ id: 's3', label: '3. Roles of the Parties' },
		{ id: 's4', label: '4. Subject Matter, Duration, Nature and Purpose' },
		{ id: 's5', label: '5. Controller Obligations and Lawful Basis' },
		{ id: 's6', label: '6. Processor Obligations' },
		{ id: 's7', label: '7. Data Minimization and Author-Identifier Non-Retention' },
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
};

export const LEGAL_DOCS: LegalDoc[] = [TERMS_DOC, PRIVACY_DOC, DPA_DOC];
