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
	Homepage pricing section, between the manifesto and the FAQ. The free
	self-hosted tier takes the bigger panel (7:5) because that is the story:
	protection is the product, hosting is the convenience. Details live on
	/pricing behind the "Full pricing breakdown" link.
-->

<script lang="ts">
	import Reveal from './Reveal.svelte';
	import PlanSelfHosted from './PlanSelfHosted.svelte';
	import PlanHosted from './PlanHosted.svelte';
</script>

<section id="pricing" class="section">
	<Reveal>
		<h2 class="section-title">Free if you self-host. Five a month if you don't.</h2>
	</Reveal>

	<div class="split">
		<Reveal class="plan-slot-a">
			<PlanSelfHosted />
		</Reveal>
		<Reveal class="plan-slot-b" delay={0.08}>
			<PlanHosted />
		</Reveal>
	</div>

	<Reveal delay={0.1}>
		<p class="more">
			<span class="scarcity">First 1,000 users: $49 once for lifetime hosting.</span>
			<a href="/pricing" class="more-link">Full pricing breakdown <span class="arrow" aria-hidden="true">→</span></a>
		</p>
	</Reveal>
</section>

<style>
	.section {
		max-width: 1152px;
		margin: 0 auto;
		padding: 96px 24px;
	}
	.section-title {
		max-width: 22ch;
		font-family: var(--font-display);
		font-size: 40px;
		font-weight: 800;
		letter-spacing: -0.02em;
		color: var(--paper);
		margin: 0;
	}
	.split {
		margin-top: 56px;
		display: grid;
		gap: 24px;
	}
	.more {
		margin: 40px 0 0;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 12px 24px;
	}
	.scarcity {
		font-family: var(--font-mono);
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		color: var(--mint);
	}
	.more-link {
		font-family: var(--font-mono);
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		color: rgb(244 244 248 / 0.7);
		text-decoration: none;
		transition: color 200ms ease;
	}
	.more-link:hover {
		color: var(--paper);
	}
	.arrow {
		color: var(--ban);
	}
	@media (min-width: 768px) {
		.section-title {
			font-size: 48px;
		}
	}
	@media (min-width: 1024px) {
		.split {
			grid-template-columns: repeat(12, 1fr);
		}
		:global(.plan-slot-a) {
			grid-column: span 7 / span 7;
		}
		:global(.plan-slot-b) {
			grid-column: span 5 / span 5;
		}
	}
</style>
