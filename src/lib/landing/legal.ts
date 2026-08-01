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

export type LegalDoc = {
	/** Route slug under the site root, e.g. `terms` → `/terms`. */
	slug: string;
	/** Short label used in the footer link list. */
	label: string;
	title: string;
	version: string;
	effectiveDate: string;
	description: string;
};

export const LEGAL_EFFECTIVE_DATE = '1 August 2026';
export const LEGAL_VERSION = '1.0';

export const TERMS_DOC: LegalDoc = {
	slug: 'terms',
	label: 'Terms',
	title: 'Terms of Service',
	version: LEGAL_VERSION,
	effectiveDate: LEGAL_EFFECTIVE_DATE,
	description:
		'The binding contract for using Moderaty: eligibility, the service, YouTube API terms, credits and billing, refunds, acceptable use, liability, and governing law (Brazil).'
};

export const PRIVACY_DOC: LegalDoc = {
	slug: 'privacy',
	label: 'Privacy',
	title: 'Privacy Policy',
	version: LEGAL_VERSION,
	effectiveDate: LEGAL_EFFECTIVE_DATE,
	description:
		'How Moderaty processes personal data under the LGPD: what we collect, legal bases, retention, YouTube API disclosures, international transfers, and your rights.'
};

export const DPA_DOC: LegalDoc = {
	slug: 'dpa',
	label: 'DPA',
	title: 'Data Processing Agreement',
	version: LEGAL_VERSION,
	effectiveDate: LEGAL_EFFECTIVE_DATE,
	description:
		'The LGPD data processing agreement between you (controller) and Moderaty (processor) for YouTube comment data: process-and-discard architecture, sub-processors, and ANPD transfer clauses.'
};

export const LEGAL_DOCS: LegalDoc[] = [TERMS_DOC, PRIVACY_DOC, DPA_DOC];
