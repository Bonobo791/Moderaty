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
	The math.txt terminal: turns YouTube Studio's comment count into a
	budget. Same bracketed-terminal idiom as HowItWorks.
-->

<script lang="ts">
	import Reveal from '../Reveal.svelte';
</script>

<section class="section">
	<Reveal class="math-grid">
		<div>
			<h2 class="section-title">What would your month cost?</h2>
			<p class="section-body">
				Open YouTube Studio and check last month's comment count. The first 100 are the $5
				subscription. Everything past that is a nickel a comment, topped up manually or
				automatically — your call. If last month rounds to zero, the free tier is waving at you.
			</p>
		</div>
		<div class="brackets terminal">
			<div class="brackets-inner">
				<div class="terminal-head">
					<span class="terminal-label">math.txt</span>
				</div>
				<div class="terminal-body">
					<div><span class="t-dim">comments last month</span> <span class="t-lit">see YouTube Studio</span></div>
					<div><span class="t-dim">covered by the plan</span> <span class="t-lit">first 100 ($5/mo)</span></div>
					<div><span class="t-dim">top-up beyond that</span> <span class="t-lit">(comments − 100) × $0.05</span></div>
					<div><span class="t-dim">nights reading hate</span> <span class="t-mint">0</span></div>
					<div class="t-note">$5/mo renews. automatic top-up is opt-in.</div>
				</div>
			</div>
		</div>
	</Reveal>
</section>

<style>
	.section {
		max-width: 1152px;
		margin: 0 auto;
		padding: 64px 24px;
	}
	.section-title {
		font-family: var(--font-display);
		font-size: 40px;
		font-weight: 800;
		letter-spacing: -0.02em;
		color: var(--paper);
		margin: 0;
	}
	.section-body {
		margin: 16px 0 0;
		max-width: 58ch;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.7);
	}
	:global(.math-grid) {
		display: grid;
		align-items: center;
		gap: 32px;
	}
	.terminal {
		border-radius: var(--radius);
		border: 1px solid var(--line);
		background: var(--surface);
	}
	.terminal-head {
		border-bottom: 1px solid var(--line);
		padding: 10px 16px;
	}
	.terminal-label {
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: rgb(244 244 248 / 0.45);
	}
	.terminal-body {
		padding: 16px;
		font-family: var(--font-mono);
		font-size: 13px;
		line-height: 2;
		overflow-x: auto;
	}
	.t-dim { color: rgb(244 244 248 / 0.45); }
	.t-lit { color: rgb(244 244 248 / 0.85); }
	.t-mint { color: var(--mint); font-weight: 600; }
	.t-note {
		margin-top: 12px;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: rgb(244 244 248 / 0.35);
	}
	@media (min-width: 768px) {
		.section-title {
			font-size: 48px;
		}
	}
	@media (min-width: 1024px) {
		:global(.math-grid) {
			grid-template-columns: 1fr 1fr;
			gap: 64px;
		}
	}
</style>
