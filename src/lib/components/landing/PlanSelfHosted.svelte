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
-->

<script lang="ts">
	import Icon from './Icon.svelte';
	import { GITHUB_URL, OPENAI_MODERATION_URL } from '$lib/landing/links';
	import { TICKS_SELF_HOSTED, TICKS_SELF_HOSTED_DETAILED } from '$lib/landing/plans';

	let { detailed = false }: { detailed?: boolean } = $props();

	const ticks = $derived(detailed ? TICKS_SELF_HOSTED_DETAILED : TICKS_SELF_HOSTED);
</script>

<article class="plan">
	<span class="stamp plan-stamp v-mint">Free forever</span>
	<h3 class="kicker">Self-hosted</h3>
	<div class="price-row">
		<span class="price">$0</span>
		<span class="price-note mint">forever</span>
	</div>
	{#if detailed}
		<p class="best-for">Best for: creators who have a server, a Raspberry Pi, or opinions about Docker.</p>
	{/if}
	<p class="plan-body">
		The whole product, AGPL-3.0. Bring your own OpenAI key. OpenAI's moderation endpoint is
		<a href={OPENAI_MODERATION_URL} target="_blank" rel="noreferrer" class="inline-link">free to use</a>,
		so protection runs on your hardware for nothing but electricity.
	</p>
	<ul class="ticks">
		{#each ticks as t}
			<li class="tick">
				<span class="tick-icon mint"><Icon name="check" size={16} /></span>
				<span class="tick-text">{t}</span>
			</li>
		{/each}
	</ul>
	<div class="plan-cta">
		<a href={GITHUB_URL} target="_blank" rel="noreferrer" class="btn-press ghost-btn">
			Self-host on GitHub
		</a>
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
	.v-mint {
		color: var(--mint);
		border-color: var(--mint);
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
	}
	.mint {
		color: var(--mint);
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
	.inline-link {
		color: inherit;
		text-decoration: underline;
		text-decoration-color: rgb(244 244 248 / 0.4);
		text-underline-offset: 2px;
		transition: color 200ms ease;
	}
	.inline-link:hover {
		color: var(--ban);
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
	.tick-text {
		line-height: 1.6;
		color: rgb(244 244 248 / 0.75);
	}
	.plan-cta {
		margin-top: auto;
		padding-top: 32px;
	}
	.ghost-btn {
		display: inline-block;
		border-radius: 999px;
		border: 1px solid var(--line);
		padding: 12px 24px;
		font-size: 14px;
		font-weight: 500;
		color: var(--paper);
		text-decoration: none;
		transition: border-color 200ms ease;
	}
	.ghost-btn:hover {
		border-color: rgb(244 244 248 / 0.4);
	}
	@media (min-width: 768px) {
		.plan {
			padding: 32px;
		}
	}
</style>
