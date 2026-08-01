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
				Open YouTube Studio and check last month's comment count. Divide by 500. That is your
				entire moderation budget. If the answer rounds to zero, the free tier is waving at you.
			</p>
		</div>
		<div class="brackets terminal">
			<div class="brackets-inner">
				<div class="terminal-head">
					<span class="terminal-label">math.txt</span>
				</div>
				<div class="terminal-body">
					<div><span class="t-dim">comments last month</span> <span class="t-lit">see YouTube Studio</span></div>
					<div><span class="t-dim">packs you need</span> <span class="t-lit">comments / 500</span></div>
					<div><span class="t-dim">nights reading hate</span> <span class="t-mint">0</span></div>
					<div class="t-note">one pack = $5. no subscription. nothing renews.</div>
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
