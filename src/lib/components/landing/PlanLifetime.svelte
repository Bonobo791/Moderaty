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

<!--
	The lifetime BYOK deal: hosted forever for one $49 payment with the
	buyer's own OpenAI key, capped at the first 1,000 users. Card markup and
	styles live in PlanCard.svelte.
-->

<script lang="ts">
	import PlanCard from './PlanCard.svelte';
	import { LOGIN_URL, OPENAI_MODERATION_URL, OPENAI_PRICING_URL } from '$lib/landing/links';
	import { TICKS_LIFETIME, TICKS_LIFETIME_DETAILED } from '$lib/landing/plans';

	let { detailed = false }: { detailed?: boolean } = $props();
</script>

<PlanCard
	stamp="First 1000 users"
	mint
	kicker="Lifetime BYOK"
	price="$49"
	priceNote="once, forever"
	bestFor={detailed ? 'Best for: early believers with their own OpenAI key.' : ''}
	ticks={detailed ? TICKS_LIFETIME_DETAILED : TICKS_LIFETIME}
>
	{#snippet body()}
		Hosted forever for one payment. Bring your own OpenAI key: toxicity scoring rides OpenAI's
		moderation endpoint, <a href={OPENAI_MODERATION_URL} target="_blank" rel="noreferrer" class="inline-link">free to use</a>,
		and tone analysis runs on <a href={OPENAI_PRICING_URL} target="_blank" rel="noreferrer" class="inline-link">gpt-4.1-nano</a>, fractions of a cent per comment — so after the $49
		your running cost is near zero. Unlimited comments, no meter.
	{/snippet}
	{#snippet cta()}
		<a href={LOGIN_URL} class="btn-press primary-btn">Connect YouTube channel</a>
		<p class="refund-note">Full refund within 7 days of purchase (CDC Art. 49).</p>
	{/snippet}
</PlanCard>
