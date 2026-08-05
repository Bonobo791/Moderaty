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
	The lifetime deal: hosted forever for one $49 payment, capped at the
	first 1,000 users. We run the AI — buyers never touch a key. Card markup
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
		Hosted forever for one payment. We run the AI for you — no key to manage, nothing to
		configure. Unlimited comments, no meter.
	{/snippet}
	{#snippet cta()}
		<a href={LOGIN_URL} class="btn-press primary-btn">Connect YouTube channel</a>
		<p class="refund-note">Full refund within 7 days of purchase (CDC Art. 49).</p>
	{/snippet}
</PlanCard>
