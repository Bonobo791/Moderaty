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
	import { LOGIN_URL } from '$lib/landing/links';
</script>

<section class="final-cta">
	<div class="inner">
		<Reveal>
			<h2 class="title">Never read another <span class="marker">hate comment.</span></h2>
		</Reveal>
		<Reveal delay={0.08}>
			<a href={LOGIN_URL} class="btn-press cta">Connect YouTube channel</a>
			<p class="microcopy">Google asks for standard YouTube access, used only on your comments. Free and open source (PolyForm Shield).</p>
		</Reveal>
	</div>
</section>

<style>
	.final-cta {
		border-top: 1px solid var(--line);
	}
	.inner {
		max-width: 1152px;
		margin: 0 auto;
		padding: 128px 24px;
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
	}
	.title {
		max-width: 16ch;
		text-wrap: balance;
		font-family: var(--font-display);
		font-size: 48px;
		font-weight: 800;
		line-height: 1.02;
		letter-spacing: -0.02em;
		color: var(--paper);
		margin: 0;
	}
	.cta {
		margin-top: 40px;
		display: inline-block;
		border-radius: 999px;
		background: var(--ban);
		color: var(--ink);
		font-size: 18px;
		font-weight: 600;
		padding: 16px 32px;
		text-decoration: none;
	}
	.microcopy {
		margin: 24px 0 0;
		font-family: var(--font-mono);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: rgb(244 244 248 / 0.45);
	}
	@media (min-width: 768px) {
		.title {
			font-size: 60px;
		}
	}
</style>
