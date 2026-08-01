<!--
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
-->

<script lang="ts">
	// I12 exception (approved for static marketing routes, same as the
	// homepage): this page is fully static and prerendered — there is no data
	// loading, so loading/empty/error states cannot occur and SSR always
	// renders the populated page.
	import Nav from '$lib/components/landing/Nav.svelte';
	import Footer from '$lib/components/landing/Footer.svelte';
	import LegalDoc from '$lib/components/landing/legal/LegalDoc.svelte';
	import Dpa from '$lib/components/landing/legal/Dpa.svelte';
	import { DPA_DOC as doc } from '$lib/landing/legal';

	const toc = [
		{ id: 's1', label: '1. Purpose and Scope' },
		{ id: 's2', label: '2. Definitions' },
		{ id: 's3', label: '3. Roles of the Parties' },
		{ id: 's4', label: '4. Subject Matter, Duration, Nature and Purpose' },
		{ id: 's5', label: '5. Controller Obligations and Lawful Basis' },
		{ id: 's6', label: '6. Processor Obligations' },
		{ id: 's7', label: '7. Data Minimization and Process-and-Discard' },
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
	];
</script>

<svelte:head>
	<title>{doc.title} | Moderaty</title>
	<meta name="description" content={doc.description} />
	<meta property="og:type" content="website" />
	<meta property="og:title" content="{doc.title} | Moderaty" />
	<meta property="og:description" content={doc.description} />
</svelte:head>

<Nav />
<main>
	<LegalDoc
		kicker="Acordo de Tratamento de Dados Pessoais"
		title={doc.title}
		version={doc.version}
		effectiveDate={doc.effectiveDate}
		{toc}
	>
		<Dpa />
	</LegalDoc>
</main>
<Footer />
