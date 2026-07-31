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
	import Nav from '$lib/components/landing/Nav.svelte';
	import Hero from '$lib/components/landing/Hero.svelte';
	import TrustBar from '$lib/components/landing/TrustBar.svelte';
	import Benefits from '$lib/components/landing/Benefits.svelte';
	import HowItWorks from '$lib/components/landing/HowItWorks.svelte';
	import Numbers from '$lib/components/landing/Numbers.svelte';
	import Regulars from '$lib/components/landing/Regulars.svelte';
	import Manifesto from '$lib/components/landing/Manifesto.svelte';
	import Faq from '$lib/components/landing/Faq.svelte';
	import FinalCta from '$lib/components/landing/FinalCta.svelte';
	import Footer from '$lib/components/landing/Footer.svelte';
	import { FAQ_ENTRIES } from '$lib/landing/faq';
	import { jsonLd } from '$lib/landing/json-ld';

	const softwareApplication = {
		'@context': 'https://schema.org',
		'@type': 'SoftwareApplication',
		name: 'Moderaty',
		applicationCategory: 'SecurityApplication',
		operatingSystem: 'Web',
		description:
			'Comment protection for YouTube creators. Reads every comment, enforces your rules instantly, scores the rest with AI across 13 toxicity categories, and holds the borderline for one-click review.',
		offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
		license: 'https://www.gnu.org/licenses/agpl-3.0.html'
	};

	const faqPage = {
		'@context': 'https://schema.org',
		'@type': 'FAQPage',
		mainEntity: FAQ_ENTRIES.map((f) => ({
			'@type': 'Question',
			name: f.q,
			acceptedAnswer: { '@type': 'Answer', text: f.a }
		}))
	};
</script>

<svelte:head>
	<title>Moderaty | Comment Protection for YouTube Creators</title>
	<meta
		name="description"
		content="Moderaty reads every YouTube comment so you never have to. Your rules plus AI enforce your norms around the clock, hold the borderline, and log everything. Free, open source."
	/>
	<meta property="og:type" content="website" />
	<meta property="og:title" content="Never read another hate comment." />
	<meta
		property="og:description"
		content="Comment protection for YouTube creators. Your community's norms, enforced while you sleep."
	/>
	<meta name="twitter:card" content="summary_large_image" />
	<!-- relative for now — must become an absolute URL at deploy time -->
	<meta property="og:image" content="/og.png" />
	<meta name="twitter:image" content="/og.png" />
	{@html jsonLd(softwareApplication)}
	{@html jsonLd(faqPage)}
</svelte:head>

<Nav />
<main>
	<Hero />
	<TrustBar />
	<Benefits />
	<HowItWorks />
	<Numbers />
	<Regulars />
	<Manifesto />
	<Faq />
	<FinalCta />
</main>
<Footer />
