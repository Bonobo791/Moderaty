<!--
	The lifetime deal: hosted forever for one $49 payment, capped at the
	first 1,000 users. AI scoring runs on the buyer's own OpenAI API key
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
	stamp="First 1000 users"
	mint
	kicker="Lifetime"
	price="$49"
	priceNote="once, forever"
	bestFor={detailed ? 'Best for: early believers.' : ''}
	ticks={detailed ? TICKS_LIFETIME_DETAILED : TICKS_LIFETIME}
>
	{#snippet body()}
		Hosted forever for one payment. Unlimited comments, no meter — AI scoring runs on
		your own OpenAI API key, which you provide after purchase.
	{/snippet}
	{#snippet cta()}
		<a href={LOGIN_URL} class="btn-press primary-btn">Connect YouTube channel</a>
		<p class="refund-note">Full refund within 7 days of purchase (CDC Art. 49).</p>
	{/snippet}
</PlanCard>
