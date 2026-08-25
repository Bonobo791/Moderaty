<!--
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher

Licensed under the PolyForm Shield License 1.0.0; you may not use
this file except in compliance with the License. You may obtain a
copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.

The software is provided "as is", without warranty or condition of
any kind, express or implied. See the License for the specific
language governing permissions and limitations under the License.
A copy of the License is included in the LICENSE file at the
repository root.

Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md
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
