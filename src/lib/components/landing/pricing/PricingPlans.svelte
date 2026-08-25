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
	All three plans in detail: longer tick lists plus the "best for" lines.
	The lifetime deal carries the `lifetime` anchor for the homepage scarcity
	link; the custom-pricing strip closes the grid for volume buyers.
-->

<script lang="ts">
	import Reveal from '../Reveal.svelte';
	import PlanSelfHosted from '../PlanSelfHosted.svelte';
	import PlanHosted from '../PlanHosted.svelte';
	import PlanLifetime from '../PlanLifetime.svelte';
	import { CONTACT_URL } from '$lib/landing/links';
</script>

<section class="section">
	<Reveal>
		<h2 class="section-title">Three ways to never read it.</h2>
	</Reveal>
	<div class="plans">
		<Reveal>
			<PlanSelfHosted detailed />
		</Reveal>
		<Reveal delay={0.08}>
			<div id="lifetime" class="anchor">
				<PlanLifetime detailed />
			</div>
		</Reveal>
		<Reveal delay={0.16}>
			<PlanHosted detailed />
		</Reveal>
	</div>
	<Reveal delay={0.2}>
		<p class="custom">
			Bigger than that? Custom amounts — <a href={CONTACT_URL} class="custom-link">contact us for pricing</a>.
		</p>
	</Reveal>
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
	.anchor {
		height: 100%;
		scroll-margin-top: 96px;
	}
	.custom {
		margin: 40px 0 0;
		font-family: var(--font-mono);
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		color: rgb(244 244 248 / 0.7);
	}
	.custom-link {
		color: var(--mint);
		text-decoration: underline;
		text-decoration-color: rgb(244 244 248 / 0.4);
		text-underline-offset: 2px;
		transition: color 200ms ease;
	}
	.custom-link:hover {
		color: var(--paper);
	}
	@media (min-width: 768px) {
		.section-title {
			font-size: 48px;
		}
	}
	@media (min-width: 1024px) {
		.plans {
			grid-template-columns: 1fr 1fr 1fr;
		}
	}
</style>
