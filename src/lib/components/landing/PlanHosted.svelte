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
	The hosted plan panel: same engine, our servers, metered like a utility.
	The CTA is the standard "Connect YouTube channel" pill into the OAuth
	flow. `detailed` swaps in the longer tick list and the "best for" line.
-->

<script lang="ts">
	import Icon from './Icon.svelte';
	import { LOGIN_URL } from '$lib/landing/links';
	import { TICKS_HOSTED, TICKS_HOSTED_DETAILED } from '$lib/landing/plans';

	let { detailed = false }: { detailed?: boolean } = $props();

	const ticks = $derived(detailed ? TICKS_HOSTED_DETAILED : TICKS_HOSTED);
</script>

<article class="plan">
	<span class="stamp plan-stamp v-ban">1 cent per comment</span>
	<h3 class="kicker">Hosted</h3>
	<div class="price-row">
		<span class="price">$5</span>
		<span class="price-note">= 500 comments</span>
	</div>
	{#if detailed}
		<p class="best-for">Best for: creators who want the hammer without the homework.</p>
	{/if}
	<p class="plan-body">
		Same engine, our servers. Buy a pack when you need one, skip months when you don't.
	</p>
	<ul class="ticks">
		{#each ticks as t}
			<li class="tick">
				<span class="tick-icon ban"><Icon name="check" size={16} /></span>
				<span class="tick-text">{t}</span>
			</li>
		{/each}
	</ul>
	<div class="plan-cta">
		<a href={LOGIN_URL} class="btn-press primary-btn">Connect YouTube channel</a>
		<p class="refund-note">
			Full refund within 7 days of purchase (CDC Art. 49). Unused credits are always refunded.
		</p>
	</div>
</article>

<style>
	.plan {
		position: relative;
		display: flex;
		height: 100%;
		flex-direction: column;
		border-radius: var(--radius);
		border: 1px solid var(--line);
		background: var(--surface);
		padding: 28px;
	}
	.plan-stamp {
		position: absolute;
		top: -12px;
		right: 24px;
		transform: rotate(-8deg);
	}
	.v-ban {
		color: var(--ban);
		border-color: var(--ban);
	}
	.kicker {
		font-family: var(--font-mono);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: rgb(244 244 248 / 0.55);
		margin: 0;
	}
	.price-row {
		margin-top: 16px;
		display: flex;
		align-items: baseline;
		gap: 12px;
	}
	.price {
		font-size: 60px;
		font-weight: 800;
		letter-spacing: -0.02em;
		line-height: 1;
		color: var(--paper);
	}
	.price-note {
		font-family: var(--font-mono);
		font-size: 14px;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: rgb(244 244 248 / 0.55);
	}
	.best-for {
		margin: 12px 0 0;
		font-family: var(--font-mono);
		font-size: 11px;
		text-transform: uppercase;
		line-height: 1.6;
		letter-spacing: 0.12em;
		color: rgb(244 244 248 / 0.45);
	}
	.plan-body {
		margin: 16px 0 0;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.7);
	}
	.ticks {
		margin: 24px 0 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.tick {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}
	.tick-icon {
		margin-top: 4px;
		flex-shrink: 0;
		display: inline-flex;
	}
	.ban {
		color: var(--ban);
	}
	.tick-text {
		line-height: 1.6;
		color: rgb(244 244 248 / 0.75);
	}
	.plan-cta {
		margin-top: auto;
		padding-top: 32px;
	}
	.refund-note {
		margin: 16px 0 0;
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 1.7;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: rgb(244 244 248 / 0.45);
	}
	.primary-btn {
		display: inline-block;
		border-radius: 999px;
		background: var(--ban);
		padding: 12px 24px;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
		text-decoration: none;
	}
	@media (min-width: 768px) {
		.plan {
			padding: 32px;
		}
	}
</style>
