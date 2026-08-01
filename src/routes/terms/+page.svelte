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
	import Terms from '$lib/components/landing/legal/Terms.svelte';
	import { TERMS_DOC as doc } from '$lib/landing/legal';

	const toc = [
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
		kicker="Termos de Serviço"
		title={doc.title}
		version={doc.version}
		effectiveDate={doc.effectiveDate}
		{toc}
	>
		<Terms />
	</LegalDoc>
</main>
<Footer />
