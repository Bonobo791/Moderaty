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
	The pricing FAQ. Entries come from $lib/landing/pricing-faq (single
	source, also feeding the page's FAQPage structured data). Native details,
	same interaction as the homepage FAQ.
-->

<script lang="ts">
	import Reveal from '../Reveal.svelte';
	import Icon from '../Icon.svelte';
	import { PRICING_FAQ_ENTRIES } from '$lib/landing/pricing-faq';
</script>

<section id="pricing-faq" class="section">
	<Reveal>
		<h2 class="section-title">Pricing questions, answered.</h2>
	</Reveal>
	<Reveal delay={0.05}>
		<div class="faq-list">
			{#each PRICING_FAQ_ENTRIES as f}
				<details class="faq-item">
					<summary class="faq-q">
						<span class="faq-q-text">{f.q}</span>
						<span class="faq-plus"><Icon name="plus" size={18} /></span>
					</summary>
					<p class="faq-a">{f.a}</p>
				</details>
			{/each}
		</div>
	</Reveal>
</section>

<style>
	.section {
		max-width: 768px;
		margin: 0 auto;
		padding: 96px 24px;
	}
	.section-title {
		font-family: var(--font-display);
		font-size: 40px;
		font-weight: 800;
		letter-spacing: -0.02em;
		color: var(--paper);
		margin: 0;
	}
	.faq-list {
		margin-top: 48px;
		border-top: 1px solid var(--line);
		border-bottom: 1px solid var(--line);
	}
	.faq-item {
		padding: 20px 0;
	}
	.faq-item + .faq-item {
		border-top: 1px solid var(--line);
	}
	.faq-q {
		display: flex;
		cursor: pointer;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		text-align: left;
	}
	.faq-q-text {
		font-size: 18px;
		font-weight: 600;
		color: var(--paper);
	}
	.faq-plus {
		flex-shrink: 0;
		display: inline-flex;
		color: rgb(244 244 248 / 0.5);
	}
	.faq-a {
		margin: 12px 0 0;
		max-width: 62ch;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.7);
	}
	@media (min-width: 768px) {
		.section-title {
			font-size: 48px;
		}
	}
</style>
