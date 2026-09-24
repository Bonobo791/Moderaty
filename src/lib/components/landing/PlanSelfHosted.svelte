<!--
	The self-hosted plan panel: the bigger half of the pricing story, because
	protection is the product and hosting is the convenience. `detailed` swaps
	in the longer tick list and the "best for" line for the /pricing page.
	Card markup and styles live in PlanCard.svelte.
-->

<script lang="ts">
	import PlanCard from './PlanCard.svelte';
	import { GITHUB_URL } from '$lib/landing/links';
	import { TICKS_SELF_HOSTED, TICKS_SELF_HOSTED_DETAILED } from '$lib/landing/plans';

	let { detailed = false }: { detailed?: boolean } = $props();
</script>

<PlanCard
	stamp="Free forever"
	mint
	kicker="Self-hosted"
	price="$0"
	priceNote="forever"
	bestFor={detailed ? 'Best for: creators who have a server, a Raspberry Pi, or opinions about Docker.' : ''}
	ticks={detailed ? TICKS_SELF_HOSTED_DETAILED : TICKS_SELF_HOSTED}
>
	{#snippet body()}
		The whole product, PolyForm Shield 1.0.0. Bring your own OpenAI key for the AI scoring. On your hardware
		the running cost is near zero.
	{/snippet}
	{#snippet cta()}
		<a href={GITHUB_URL} target="_blank" rel="noreferrer" class="btn-press ghost-btn">Self-host on GitHub</a>
	{/snippet}
</PlanCard>
