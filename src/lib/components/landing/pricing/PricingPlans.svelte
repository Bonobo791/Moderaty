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

<!-- Both plans in detail: longer tick lists plus the "best for" lines. -->

<script lang="ts">
	import Reveal from '../Reveal.svelte';
	import PlanSelfHosted from '../PlanSelfHosted.svelte';
	import PlanHosted from '../PlanHosted.svelte';
</script>

<section class="section">
	<Reveal>
		<h2 class="section-title">Two ways to never read it.</h2>
	</Reveal>
	<div class="plans">
		<Reveal>
			<PlanSelfHosted detailed />
		</Reveal>
		<Reveal delay={0.08}>
			<PlanHosted detailed />
		</Reveal>
	</div>
</section>

<style>
	.section {
		max-width: 1152px;
		margin: 0 auto;
		padding: 64px 24px;
	}
	.section-title {
		max-width: 20ch;
		font-family: var(--font-display);
		font-size: 40px;
		font-weight: 800;
		letter-spacing: -0.02em;
		color: var(--paper);
		margin: 0;
	}
	.plans {
		margin-top: 56px;
		display: grid;
		align-items: stretch;
		gap: 24px;
	}
	@media (min-width: 768px) {
		.section-title {
			font-size: 48px;
		}
	}
	@media (min-width: 1024px) {
		.plans {
			grid-template-columns: 1fr 1fr;
		}
	}
</style>
