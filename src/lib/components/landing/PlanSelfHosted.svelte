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
