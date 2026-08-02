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
	The shared plan panel: one card, one copy of the styles, every tier is a
	thin wrapper (PlanSelfHosted, PlanHosted, PlanLifetime). `mint` selects the
	mint accent (free/lifetime deals); the default is the pink `--ban` accent.
	CTA button and inline-link styles are global-scoped under .plan-cta /
	.plan-body because snippets render in the wrapper's scope.
-->

<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	let {
		stamp,
		mint = false,
		kicker,
		price,
		priceNote,
		bestFor = '',
		ticks,
		body,
		cta
	}: {
		stamp: string;
		mint?: boolean;
		kicker: string;
		price: string;
		priceNote: string;
		bestFor?: string;
		ticks: string[];
		body: Snippet;
		cta: Snippet;
	} = $props();
</script>

<article class="plan">
	<span class="stamp plan-stamp" class:v-mint={mint} class:v-ban={!mint}>{stamp}</span>
	<h3 class="kicker">{kicker}</h3>
	<div class="price-row">
		<span class="price">{price}</span>
		<span class="price-note" class:mint>{priceNote}</span>
	</div>
	{#if bestFor}
		<p class="best-for">{bestFor}</p>
	{/if}
	<p class="plan-body">{@render body()}</p>
	<ul class="ticks">
		{#each ticks as t}
			<li class="tick">
				<span class="tick-icon" class:mint class:ban={!mint}><Icon name="check" size={16} /></span>
				<span class="tick-text">{t}</span>
			</li>
		{/each}
	</ul>
	<div class="plan-cta">{@render cta()}</div>
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
	.mint {
		color: var(--mint);
	}
	.ban {
		color: var(--ban);
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
	.tick-text {
		line-height: 1.6;
		color: rgb(244 244 248 / 0.75);
	}
	.plan-cta {
		margin-top: auto;
		padding-top: 32px;
	}
	:global(.plan-cta .primary-btn) {
		display: inline-block;
		border-radius: 999px;
		background: var(--ban);
		padding: 12px 24px;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
		text-decoration: none;
	}
	:global(.plan-cta .ghost-btn) {
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
	:global(.plan-cta .ghost-btn:hover) {
		border-color: rgb(244 244 248 / 0.4);
	}
	:global(.plan-cta .refund-note) {
		margin: 16px 0 0;
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 1.7;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: rgb(244 244 248 / 0.45);
	}
	:global(.plan-body .inline-link) {
		color: inherit;
		text-decoration: underline;
		text-decoration-color: rgb(244 244 248 / 0.4);
		text-underline-offset: 2px;
		transition: color 200ms ease;
	}
	:global(.plan-body .inline-link:hover) {
		color: var(--ban);
	}
	@media (min-width: 768px) {
		.plan {
			padding: 32px;
		}
	}
</style>
