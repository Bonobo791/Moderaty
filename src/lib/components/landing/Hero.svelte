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
	import BonkQueue from './BonkQueue.svelte';
	import { LOGIN_URL } from '$lib/landing/links';
</script>

<section id="top" class="hero">
	<div class="hero-grid">
		<div class="hero-copy">
			<Reveal amount={0.1}>
				<p class="eyebrow"><span class="eyebrow-mark">{'//'}</span> Comment protection for YouTube creators</p>
			</Reveal>
			<Reveal amount={0.1} delay={0.08}>
				<h1>Never read another <span class="marker">hate comment.</span></h1>
			</Reveal>
			<Reveal amount={0.1} delay={0.16}>
				<p class="sub">
					Moderaty reads every comment so you don't have to. Your norms, enforced while you sleep.
					Trolls get the hammer.
				</p>
			</Reveal>
			<Reveal amount={0.1} delay={0.24}>
				<div class="cta-row">
					<a href={LOGIN_URL} class="btn-press cta-primary">Connect YouTube channel</a>
					<a href="#regulars" class="btn-press cta-ghost">See who gets bonked</a>
				</div>
			</Reveal>
		</div>
		<Reveal class="hero-queue" amount={0.1} delay={0.2}>
			<BonkQueue />
		</Reveal>
	</div>
</section>

<style>
	.hero {
		display: flex;
		align-items: center;
		min-height: 100dvh;
		padding-top: 80px;
	}
	.hero-grid {
		max-width: 1152px;
		width: 100%;
		min-width: 0;
		margin: 0 auto;
		padding: 64px 24px;
		display: grid;
		align-items: center;
		gap: 48px;
	}
	.hero-copy {
		min-width: 0;
	}
	.eyebrow {
		font-family: var(--font-mono);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.22em;
		color: rgb(244 244 248 / 0.55);
		margin: 0;
	}
	.eyebrow-mark {
		color: var(--ban);
	}
	h1 {
		margin: 20px 0 0;
		max-width: 14ch;
		text-wrap: balance;
		font-family: var(--font-display);
		font-size: 48px;
		font-weight: 800;
		line-height: 1.02;
		letter-spacing: -0.02em;
		color: var(--paper);
	}
	.sub {
		margin: 24px 0 0;
		max-width: 52ch;
		font-size: 18px;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.7);
	}
	.cta-row {
		margin-top: 32px;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 16px;
	}
	.cta-primary {
		border-radius: 999px;
		background: var(--ban);
		color: var(--ink);
		font-size: 16px;
		font-weight: 600;
		padding: 14px 28px;
		text-decoration: none;
	}
	.cta-ghost {
		border-radius: 999px;
		border: 1px solid var(--line);
		color: var(--paper);
		font-size: 16px;
		font-weight: 500;
		padding: 14px 28px;
		text-decoration: none;
		transition: border-color 200ms ease;
	}
	.cta-ghost:hover {
		border-color: rgb(244 244 248 / 0.4);
	}
	:global(.hero-queue) {
		min-width: 0;
	}
	@media (min-width: 768px) {
		h1 {
			font-size: 60px;
		}
	}
	@media (min-width: 1024px) {
		.hero-grid {
			grid-template-columns: 1.15fr 1fr;
		}
	}
</style>
