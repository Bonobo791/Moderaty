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
</script>

<section class="section">
	<Reveal>
		<h2 class="section-title">What you get back</h2>
	</Reveal>
	<div class="grid">
		<Reveal class="chunk wide" delay={0.05}>
			<Icon name="sun-horizon" size={28} />
			<div class="numerals">
				<span class="numeral">47</span>
				<span class="numeral-label">in overnight</span>
				<span class="numeral mint">0</span>
				<span class="numeral-label">read by you</span>
			</div>
			<h3 class="chunk-title">Your mornings.</h3>
			<p class="chunk-body">
				47 comments arrived last night. 0 required you. The pile is handled before it becomes your
				day. You check the queue when you choose to, not when the badge number guilts you into it.
			</p>
		</Reveal>
		<div class="stack">
			<Reveal class="chunk" delay={0.1}>
				<Icon name="users-three" size={28} />
				<h3 class="chunk-title">A comment section that stays yours at 10,000.</h3>
				<p class="chunk-body">
					Growth usually means losing your comment culture to whoever shows up loudest. Your norms
					get enforced the same way on comment #10 and comment #10,000, including the night a video
					blows up and the brigade arrives.
				</p>
			</Reveal>
			<Reveal class="chunk" delay={0.15}>
				<Icon name="handshake" size={28} />
				<h3 class="chunk-title">Sponsor-safe, without the read.</h3>
				<p class="chunk-body">
					Brands audit comment sections before they sign. Yours stays clean, and you didn't pay for
					it with your own evening.
				</p>
			</Reveal>
		</div>
	</div>
</section>

<style>
	.section {
		max-width: 1152px;
		margin: 0 auto;
		padding: 96px 24px;
	}
	.section-title {
		max-width: 16ch;
		font-family: var(--font-display);
		font-size: 40px;
		font-weight: 800;
		letter-spacing: -0.02em;
		color: var(--paper);
		margin: 0;
	}
	.grid {
		margin-top: 56px;
		display: grid;
		gap: 32px;
	}
	:global(.chunk) {
		border-top: 1px solid var(--line);
		padding-top: 32px;
		color: rgb(244 244 248 / 0.7);
	}
	.numerals {
		margin-top: 24px;
		display: flex;
		align-items: flex-end;
		gap: 12px;
	}
	.numeral {
		font-family: var(--font-mono);
		font-size: 60px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: 1;
		color: var(--paper);
	}
	.numeral.mint {
		color: var(--mint);
	}
	.numeral-label {
		padding-bottom: 4px;
		font-family: var(--font-mono);
		font-size: 14px;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: rgb(244 244 248 / 0.5);
	}
	.chunk-title {
		margin: 24px 0 0;
		font-family: var(--font-display);
		font-size: 24px;
		font-weight: 700;
		color: var(--paper);
	}
	.chunk-body {
		margin: 12px 0 0;
		max-width: 58ch;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.7);
	}
	.stack {
		display: flex;
		flex-direction: column;
		gap: 32px;
	}
	@media (min-width: 768px) {
		.section-title {
			font-size: 48px;
		}
		.numeral {
			font-size: 72px;
		}
	}
	@media (min-width: 1024px) {
		.grid {
			grid-template-columns: repeat(5, 1fr);
		}
		:global(.chunk.wide) {
			grid-column: span 3;
		}
		.stack {
			grid-column: span 2;
		}
	}
</style>
