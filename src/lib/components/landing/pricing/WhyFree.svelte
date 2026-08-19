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

<!--
	The anti-profit manifesto band: why the free tier is the full product.
	Same band treatment as the homepage manifesto (hairline borders, dim
	surface), closing on the uninstall line.
-->

<script lang="ts">
	import Reveal from '../Reveal.svelte';
</script>

<section class="band">
	<div class="band-grid">
		<Reveal>
			<h2 class="band-title">Why is the free tier the <span class="marker">full product?</span></h2>
		</Reveal>
		<Reveal delay={0.08}>
			<div class="band-body">
				<p>
					Because the usual incentive rots products. Most moderation tools paywall safety and
					monetize anxiety: the worse your comment section gets, the more you need the expensive
					plan.
				</p>
				<p>
					We sell moderated comments the way a utility sells water, metered and boring. The free
					tier is the whole product because protection is the product. The hosted tiers exist for
					people who would rather not run a server, not for people who ran out of safety.
				</p>
				<p>The day Moderaty profits from your anxiety, you should uninstall it.</p>
			</div>
		</Reveal>
	</div>
</section>

<style>
	.band {
		border-top: 1px solid var(--line);
		border-bottom: 1px solid var(--line);
		background: rgb(18 18 30 / 0.4);
	}
	.band-grid {
		max-width: 1152px;
		margin: 0 auto;
		padding: 96px 24px;
		display: grid;
		gap: 48px;
	}
	.band-title {
		max-width: 18ch;
		font-family: var(--font-display);
		font-size: 40px;
		font-weight: 800;
		line-height: 1.05;
		letter-spacing: -0.02em;
		color: var(--paper);
		margin: 0;
	}
	.band-body {
		display: flex;
		height: 100%;
		flex-direction: column;
		justify-content: center;
		gap: 24px;
		font-size: 18px;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.75);
	}
	.band-body p {
		margin: 0;
	}
	@media (min-width: 768px) {
		.band-title {
			font-size: 48px;
		}
	}
	@media (min-width: 1024px) {
		.band-grid {
			grid-template-columns: 1fr 1fr;
			gap: 64px;
		}
	}
</style>
