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
	// Shared page frame for the legal routes: head metadata, Nav, the LegalDoc
	// shell, and Footer. Each route supplies its doc metadata (legal.ts) and
	// its content component — nothing here is document-specific.
	import type { Component } from 'svelte';
	import Nav from '$lib/components/landing/Nav.svelte';
	import Footer from '$lib/components/landing/Footer.svelte';
	import LegalDoc from '$lib/components/landing/legal/LegalDoc.svelte';
	import type { LegalDoc as LegalDocMeta } from '$lib/landing/legal';

	let { doc, content: Content }: { doc: LegalDocMeta; content: Component } = $props();
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
		kicker={doc.kicker}
		title={doc.title}
		version={doc.version}
		effectiveDate={doc.effectiveDate}
		toc={doc.toc}
	>
		<Content />
	</LegalDoc>
</main>
<Footer />
