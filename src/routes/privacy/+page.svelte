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
	import Privacy from '$lib/components/landing/legal/Privacy.svelte';
	import { PRIVACY_DOC as doc } from '$lib/landing/legal';

	const toc = [
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
		kicker="Política de Privacidade"
		title={doc.title}
		version={doc.version}
		effectiveDate={doc.effectiveDate}
		{toc}
	>
		<Privacy />
	</LegalDoc>
</main>
<Footer />
