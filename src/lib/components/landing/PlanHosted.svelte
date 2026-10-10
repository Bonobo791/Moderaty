<!--
	The hosted plan panel: same engine, our servers, $5 a month auto-renewed
	with 100 AI classifications included and opt-in top-up automation. The CTA is the
	standard "Connect YouTube channel" pill into the OAuth flow. `detailed`
	swaps in the longer tick list and the "best for" line. Card markup and
	styles live in PlanCard.svelte.
-->

<script lang="ts">
	import PlanCard from './PlanCard.svelte';
	import { LOGIN_URL } from '$lib/landing/links';
	import { TICKS_HOSTED, TICKS_HOSTED_DETAILED } from '$lib/landing/plans';

	let { detailed = false }: { detailed?: boolean } = $props();
</script>

<PlanCard
	stamp="Renews monthly"
	kicker="Hosted"
	price="$5"
	priceNote="a month, 100 AI classifications"
	bestFor={detailed ? 'Best for creators who want Moderaty to host the service and manage the AI key.' : ''}
	ticks={detailed ? TICKS_HOSTED_DETAILED : TICKS_HOSTED}
>
	{#snippet body()}
		Moderaty runs the service and supplies the AI key. Each paid month includes 100 credits shared by moderation scoring and enabled feedback digests. Buy more only when needed: 500 credits for $20.40 or 2,000 for $64.65.
	{/snippet}
	{#snippet cta()}
		<a href={LOGIN_URL} data-moderaty-event="connect_click" data-moderaty-placement="plan_hosted" class="btn-press primary-btn">Connect YouTube channel</a>
		<p class="refund-note">Full refund within 7 days of purchase (CDC Art. 49).</p>
	{/snippet}
</PlanCard>
