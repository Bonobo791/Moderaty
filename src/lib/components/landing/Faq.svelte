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

<script lang="ts">
	import Reveal from './Reveal.svelte';
	import Icon from './Icon.svelte';
	import { FAQ_ENTRIES } from '$lib/landing/faq';
</script>

<section id="faq" class="section">
	<Reveal>
		<h2 class="section-title">Asked, answered.</h2>
	</Reveal>
	<Reveal delay={0.05}>
		<div class="faq-list">
			{#each FAQ_ENTRIES as f}
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
