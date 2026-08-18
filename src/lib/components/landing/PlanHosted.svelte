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

Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
-->

<!--
	The hosted plan panel: same engine, our servers, $5 a month auto-renewed
	with 100 comments included and opt-in top-up automation. The CTA is the
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
	priceNote="a month, 100 comments"
	bestFor={detailed ? 'Best for: creators who want the hammer without the homework.' : ''}
	ticks={detailed ? TICKS_HOSTED_DETAILED : TICKS_HOSTED}
>
	{#snippet body()}
		Same engine, our servers. 100 moderated comments every month, renewed automatically. Run out
		and top up at the same nickel a comment.
	{/snippet}
	{#snippet cta()}
		<a href={LOGIN_URL} class="btn-press primary-btn">Connect YouTube channel</a>
		<p class="refund-note">Full refund within 7 days of purchase (CDC Art. 49).</p>
	{/snippet}
</PlanCard>
