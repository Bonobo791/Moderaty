<script lang="ts">
	// I12 exception (approved for static marketing routes, same as the
	// homepage): this page is fully static and prerendered — there is no data
	// loading, so loading/empty/error states cannot occur and SSR always
	// renders the populated page.
	import Nav from '$lib/components/landing/Nav.svelte';
	import PricingHero from '$lib/components/landing/pricing/PricingHero.svelte';
	import PricingPlans from '$lib/components/landing/pricing/PricingPlans.svelte';
	import CostMath from '$lib/components/landing/pricing/CostMath.svelte';
	import PricingFaq from '$lib/components/landing/pricing/PricingFaq.svelte';
	import FinalCta from '$lib/components/landing/FinalCta.svelte';
	import Footer from '$lib/components/landing/Footer.svelte';
	import { PRICING_FAQ_ENTRIES } from '$lib/landing/pricing-faq';
	import { jsonLd } from '$lib/landing/json-ld';

	const faqPage = {
		'@context': 'https://schema.org',
		'@type': 'FAQPage',
		mainEntity: PRICING_FAQ_ENTRIES.map((f) => ({
			'@type': 'Question',
			name: f.q,
			acceptedAnswer: { '@type': 'Answer', text: f.a }
		}))
	};
</script>

<svelte:head>
	<title>Pricing | Moderaty</title>
	<meta
		name="description"
		content="Self-hosted Moderaty costs $0 from Moderaty under the source-available PolyForm Shield license; infrastructure and OpenAI charges are separate. Hosted: $5 a month for 100 AI classifications shared by moderation scoring and feedback digests; top-ups: 500 or 2,000 credits for $20.40 or $64.65. First 1,000 purchases: $49 once for lifetime hosting, with your own OpenAI key."
	/>
	<meta property="og:type" content="website" />
	<meta property="og:title" content="Protection, priced like a utility." />
	<meta
		property="og:description"
		content="Self-hosted Moderaty costs $0 from Moderaty under the source-available PolyForm Shield license; infrastructure and OpenAI charges are separate. Hosted: $5 a month for 100 AI classifications shared by moderation scoring and feedback digests, or $49 once for lifetime hosting (first 1,000 purchases, your own OpenAI key)."
	/>
	{@html jsonLd(faqPage)}
</svelte:head>

<Nav />
<main>
	<PricingHero />
	<PricingPlans />
	<CostMath />
	<PricingFaq />
	<FinalCta />
</main>
<Footer />
