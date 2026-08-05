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
	The self-hosted plan panel: the bigger half of the pricing story, because
	protection is the product and hosting is the convenience. `detailed` swaps
	in the longer tick list and the "best for" line for the /pricing page.
	Card markup and styles live in PlanCard.svelte.
-->

<script lang="ts">
	import PlanCard from './PlanCard.svelte';
	import { GITHUB_URL, OPENAI_MODERATION_URL, OPENAI_PRICING_URL } from '$lib/landing/links';
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
		The whole product, AGPL-3.0. Bring your own OpenAI key: toxicity scoring rides OpenAI's
		moderation endpoint, <a href={OPENAI_MODERATION_URL} target="_blank" rel="noreferrer" class="inline-link">free to use</a>,
		and tone analysis runs on <a href={OPENAI_PRICING_URL} target="_blank" rel="noreferrer" class="inline-link">gpt-4.1-nano</a>, fractions of a cent per comment. Protection on your
		hardware for electricity and pennies.
	{/snippet}
	{#snippet cta()}
		<a href={GITHUB_URL} target="_blank" rel="noreferrer" class="btn-press ghost-btn">Self-host on GitHub</a>
	{/snippet}
</PlanCard>
