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
