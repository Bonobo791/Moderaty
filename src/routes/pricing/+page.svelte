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
	// I12 exception (approved for static marketing routes, same as the
	// homepage): this page is fully static and prerendered — there is no data
	// loading, so loading/empty/error states cannot occur and SSR always
	// renders the populated page.
	import Nav from '$lib/components/landing/Nav.svelte';
	import PricingHero from '$lib/components/landing/pricing/PricingHero.svelte';
	import PricingPlans from '$lib/components/landing/pricing/PricingPlans.svelte';
	import CostMath from '$lib/components/landing/pricing/CostMath.svelte';
	import WhyFree from '$lib/components/landing/pricing/WhyFree.svelte';
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
		content="Free and open source when self-hosted (PolyForm Shield, bring your own key). Hosted: $5 a month for 100 moderated comments, auto-renewed, 5¢ top-ups. First 1,000 users: $49 once for lifetime hosting."
	/>
	<meta property="og:type" content="website" />
	<meta property="og:title" content="Protection, priced like a utility." />
	<meta
		property="og:description"
		content="Free and open source when self-hosted. Hosted: $5 a month for 100 comments, or $49 once for lifetime hosting (first 1,000 users)."
	/>
	{@html jsonLd(faqPage)}
</svelte:head>

<Nav />
<main>
	<PricingHero />
	<PricingPlans />
	<CostMath />
	<WhyFree />
	<PricingFaq />
	<FinalCta />
</main>
<Footer />
