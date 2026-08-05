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
	Pricing hero: a bracketed quick-answer block (written for AI engines and
	skimmers) above the H1. The BYOK story is simple: free software, your own
	OpenAI key for the AI scoring.
-->

<script lang="ts">
	import Reveal from '../Reveal.svelte';
</script>

<section class="hero">
	<Reveal>
		<div class="brackets quick-answer">
			<div class="brackets-inner">
				<div class="qa-head">
					<span class="qa-label">Quick answer</span>
				</div>
				<p class="qa-body">
					Moderaty is free and open source when self-hosted: AGPL-3.0, bring your own OpenAI key
					for the AI scoring.
					Hosted costs $5 a month for 100 moderated comments, auto-renewed, with 5¢ top-ups when
					you run out. The first 1,000 users can instead pay $49 once for lifetime hosted BYOK.
				</p>
			</div>
		</div>
	</Reveal>
	<Reveal delay={0.08}>
		<h1 class="hero-title">Protection, priced like a <span class="marker">utility.</span></h1>
		<p class="hero-sub">
			The software is free. The AI might as well be. What you can buy is not having to run it.
		</p>
	</Reveal>
</section>

<style>
	.hero {
		max-width: 1152px;
		margin: 0 auto;
		padding: 128px 24px 64px;
	}
	.quick-answer {
		max-width: 768px;
		border-radius: var(--radius);
		border: 1px solid var(--line);
		background: var(--surface);
	}
	.qa-head {
		border-bottom: 1px solid var(--line);
		padding: 10px 16px;
	}
	.qa-label {
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: rgb(244 244 248 / 0.45);
	}
	.qa-body {
		margin: 0;
		padding: 16px;
		font-family: var(--font-mono);
		font-size: 13px;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.75);
	}
	.hero-title {
		margin: 48px 0 0;
		max-width: 16ch;
		font-family: var(--font-display);
		font-size: 48px;
		font-weight: 800;
		line-height: 1.02;
		letter-spacing: -0.02em;
		text-wrap: balance;
		color: var(--paper);
	}
	.hero-sub {
		margin: 24px 0 0;
		max-width: 52ch;
		font-size: 18px;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.7);
	}
	@media (min-width: 768px) {
		.hero {
			padding-top: 160px;
		}
		.hero-title {
			font-size: 60px;
		}
	}
</style>
