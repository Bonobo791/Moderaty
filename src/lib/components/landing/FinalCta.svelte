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
			<p class="microcopy">Google asks for comment access only. Free and open source (AGPL).</p>
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
