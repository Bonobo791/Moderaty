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

export const LEGAL_EFFECTIVE_DATE = '17 August 2026';
// 1.10: LICENSE SWAP — the self-hosted grant changed to the
// PolyForm Shield License 1.0.0 (Terms §6.1(a); footer, FAQ, pricing, and
// the license link updated to match the LICENSE file). Material change:
// users without a 1.10 consent row are routed back through /consent.
// 1.9: CONTACT FORM — the Privacy Policy documents the opt-in contact form
// (name, e-mail, opt-in consent recorded with the exact checkbox sentence;
// verification e-mail via Mailjet) and names Mailjet as the transactional
// e-mail provider in the sharing list; DPA Annex III replaces the e-mail
// provider placeholder; Terms §21 adds the /contact form as a contact
// channel. Material change: users without a 1.9 consent row are routed
// back through /consent.
// 1.8: BILLABLE SCOPE — Terms §6.1(d) corrected to match the product: a
// credit is consumed only by AI-scored comments on live runs; rule matches
// and protected handles are never charged (the previous "every comment the
// Service processes" wording was broader than the implementation).
// 1.7: STRIPE BILLING — Terms §6.1/§6.2 rewritten (prepaid credit bundles
// replace the subscription model; §6.2 authorizes UNSCHEDULED automatic
// top-ups charged to the saved card; §7 refund policy: credits reverse only
// on full refunds, auto top-up disabled on disputes). Material change:
// users without a 1.7 consent row are routed back through /consent.
// 1.6: commenter handles are now retained in the activity log for up to 30
// days (automatic + on-demand erasure), so the "author identifiers never
// stored from comments" promise was rewritten across the Privacy Policy,
// Terms, DPA, footer, and FAQ.
// 1.5: Terms §6.1(c) corrected — the lifetime hosted plan has no per-account
// key flow (hosted scoring runs on the deployment's OPENAI_API_KEY), so the
// "your own OpenAI key" promise was removed from the lifetime clause.
export const LEGAL_VERSION = '1.10';
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
