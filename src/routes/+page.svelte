<script lang="ts">
	import Nav from '$lib/components/landing/Nav.svelte';
	import Hero from '$lib/components/landing/Hero.svelte';
	import TrustBar from '$lib/components/landing/TrustBar.svelte';
	import Benefits from '$lib/components/landing/Benefits.svelte';
	import HowItWorks from '$lib/components/landing/HowItWorks.svelte';
	import Digest from '$lib/components/landing/Digest.svelte';
	import Numbers from '$lib/components/landing/Numbers.svelte';
	import Regulars from '$lib/components/landing/Regulars.svelte';
	import Manifesto from '$lib/components/landing/Manifesto.svelte';
	import Pricing from '$lib/components/landing/Pricing.svelte';
	import CostMath from '$lib/components/landing/pricing/CostMath.svelte';
	import Faq from '$lib/components/landing/Faq.svelte';
	import FinalCta from '$lib/components/landing/FinalCta.svelte';
	import Footer from '$lib/components/landing/Footer.svelte';
	import { FAQ_ENTRIES } from '$lib/landing/faq';
	import { jsonLd } from '$lib/landing/json-ld';

	const productDescription = 'Moderaty checks top-level YouTube comments with your rules and AI scoring. Review uncertain decisions, audit actions, and collect viewer feedback.';

	const softwareApplication = {
		'@context': 'https://schema.org',
		'@type': 'SoftwareApplication',
		name: 'Moderaty',
		applicationCategory: 'SecurityApplication',
		operatingSystem: 'Web',
		description: productDescription,
		offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
		license: 'https://polyformproject.org/licenses/shield/1.0.0'
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
		content={productDescription}
	/>
	<meta property="og:type" content="website" />
	<meta property="og:title" content="Moderaty | Comment Protection for YouTube Creators" />
	<meta
		property="og:description"
		content={productDescription}
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
	<Digest />
	<Numbers />
	<Regulars />
	<Manifesto />
	<Pricing />
	<CostMath />
	<Faq />
	<FinalCta />
</main>
<Footer />
