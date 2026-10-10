<!--
	The lifetime deal: hosted forever for one $49 payment, capped at the
	1,000 lifetime places. AI scoring runs on the buyer's own OpenAI API key
	(Terms §6.1(c)) — the card must say so before purchase. Card markup
	and styles live in PlanCard.svelte.
-->

<script lang="ts">
	import PlanCard from './PlanCard.svelte';
	import { LOGIN_URL } from '$lib/landing/links';
	import { TICKS_LIFETIME, TICKS_LIFETIME_DETAILED } from '$lib/landing/plans';

	let { detailed = false }: { detailed?: boolean } = $props();
</script>

<PlanCard
	stamp="1,000 lifetime places"
	mint
	kicker="Lifetime"
	price="$49"
	priceNote="once, forever"
	bestFor={detailed ? 'Best for creators who want hosted access without a monthly subscription and can provide an OpenAI key.' : ''}
	ticks={detailed ? TICKS_LIFETIME_DETAILED : TICKS_LIFETIME}
>
	{#snippet body()}
		One $49 payment for hosted Moderaty and unlimited moderated comments. AI scoring requires your own OpenAI API key, which you must provide and keep valid. OpenAI charges for that usage separately.
	{/snippet}
	{#snippet cta()}
		<a href={LOGIN_URL} data-moderaty-event="connect_click" data-moderaty-placement="plan_lifetime" class="btn-press primary-btn">Connect YouTube channel</a>
		<p class="refund-note">Full refund within 7 days of purchase (CDC Art. 49).</p>
	{/snippet}
</PlanCard>
