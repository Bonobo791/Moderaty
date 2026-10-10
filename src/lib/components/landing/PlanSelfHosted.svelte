<!--
	The self-hosted plan panel: the bigger half of the pricing story, because
	protection is the product and hosting is the convenience. `detailed` swaps
	in the longer tick list and the "best for" line for the /pricing page.
	Card markup and styles live in PlanCard.svelte.
-->

<script lang="ts">
	import PlanCard from './PlanCard.svelte';
	import { GITHUB_URL, POLYFORM_URL } from '$lib/landing/links';
	import { TICKS_SELF_HOSTED, TICKS_SELF_HOSTED_DETAILED } from '$lib/landing/plans';

	let { detailed = false }: { detailed?: boolean } = $props();
</script>

<PlanCard
	stamp="No Moderaty charge"
	mint
	kicker="Self-hosted"
	price="$0"
	priceNote="from Moderaty"
	bestFor={detailed ? 'Best for creators who can operate their own server.' : ''}
	ticks={detailed ? TICKS_SELF_HOSTED_DETAILED : TICKS_SELF_HOSTED}
>
	{#snippet body()}
		Source-available under <a href={POLYFORM_URL} target="_blank" rel="noopener noreferrer">PolyForm Shield 1.0.0</a>. You run Moderaty on your own infrastructure and provide your OpenAI key. Provider and API charges vary by setup and use.
	{/snippet}
	{#snippet cta()}
		<a href={GITHUB_URL} data-moderaty-event="source_click" data-moderaty-placement="plan_self_hosted" target="_blank" rel="noreferrer" class="btn-press ghost-btn">Self-host on GitHub</a>
	{/snippet}
</PlanCard>
