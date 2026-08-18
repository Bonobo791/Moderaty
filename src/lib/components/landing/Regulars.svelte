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

	type Rogue = {
		name: string;
		quote: string;
		body: string;
		verdict: string;
		verdictClass: string;
		footnote?: string;
		offset?: boolean;
		rotateClass: string;
	};

	const ROGUES: Rogue[] = [
		{
			name: 'The Ackchyually Guy',
			quote: '"Ackchyually, your point at 4:12 is wrong…"',
			body: 'Four hundred words correcting your thumbnail. Technically polite. Spiritually exhausting.',
			verdict: 'HELD FOR REVIEW',
			verdictClass: 'v-amber',
			footnote: "He's not hateful, he's just like that. You decide.",
			rotateClass: 'rot-neg-1'
		},
		{
			name: 'The Edge Lord',
			quote: '"It\'s just dark humor bro. Cope."',
			body: 'Slurs in a trench coat made of irony. Peaked in 2016. Never evolved.',
			verdict: 'BANNED',
			verdictClass: 'v-ban',
			footnote: 'Go touch grass.',
			offset: true,
			rotateClass: 'rot-1'
		},
		{
			name: 'The Crypto Bot',
			quote: '"I made $8,412 in 3 days thanks to..."',
			body: "No you didn't, Chad.",
			verdict: 'DELETED ON SIGHT',
			verdictClass: 'v-ban',
			rotateClass: 'rot-neg-2'
		},
		{
			name: 'The Brigadier',
			quote: '"Coming from the drama video. L + ratio +"',
			body: 'Arrives four minutes after the video drops. Three hundred friends behind him.',
			verdict: 'HELD UNTIL THE MOB GETS BORED',
			verdictClass: 'v-amber',
			offset: true,
			rotateClass: 'rot-1'
		}
	];
</script>

<section id="regulars" class="section">
	<Reveal>
		<h2 class="section-title">Meet the regulars.</h2>
		<p class="section-sub">Every comment section has them. Yours just stops hosting them.</p>
	</Reveal>

	<div class="collage">
		{#each ROGUES as r, i}
			<Reveal
				class="rogue-slot {i % 2 === 0 ? 'slot-left' : 'slot-right'} {r.offset ? 'slot-offset' : ''}"
				delay={i * 0.06}
			>
				<article class="rogue-card {r.rotateClass}">
					<span class="stamp rogue-stamp {r.verdictClass}">{r.verdict}</span>
					<h3 class="rogue-name">{r.name}</h3>
					<p class="rogue-quote">{r.quote}</p>
					<p class="rogue-body">{r.body}</p>
					{#if r.footnote}
						<p class="rogue-footnote">{r.footnote}</p>
					{/if}
				</article>
			</Reveal>
		{/each}
	</div>

	<Reveal delay={0.1}>
		<p class="closing">
			Different comments, different consequences. That's the point: hold the annoying, delete the
			spam, ban the hateful, and never ask you to read any of it first.
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
		max-width: 16ch;
		font-family: var(--font-display);
		font-size: 40px;
		font-weight: 800;
		letter-spacing: -0.02em;
		color: var(--paper);
		margin: 0;
	}
	.section-sub {
		margin: 16px 0 0;
		max-width: 52ch;
		font-size: 18px;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.7);
	}
	.collage {
		margin-top: 56px;
		display: grid;
		gap: 24px;
	}
	.rogue-card {
		position: relative;
		height: 100%;
		border-radius: var(--radius);
		border: 1px solid var(--line);
		background: var(--surface);
		padding: 24px;
	}
	.rogue-stamp {
		position: absolute;
		top: -12px;
		right: 16px;
		transform: rotate(-8deg);
	}
	.v-ban {
		color: var(--ban);
		border-color: var(--ban);
	}
	.v-amber {
		color: var(--amber);
		border-color: var(--amber);
	}
	.rogue-name {
		padding-right: 96px;
		font-family: var(--font-display);
		font-size: 20px;
		font-weight: 700;
		color: var(--paper);
		margin: 0;
	}
	.rogue-quote {
		margin: 16px 0 0;
		border-radius: 6px;
		border: 1px solid var(--line);
		background: var(--ink);
		padding: 10px 12px;
		font-family: var(--font-mono);
		font-size: 13px;
		line-height: 1.5;
		color: rgb(244 244 248 / 0.75);
	}
	.rogue-body {
		margin: 16px 0 0;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.7);
	}
	.rogue-footnote {
		margin: 12px 0 0;
		font-family: var(--font-mono);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: rgb(244 244 248 / 0.45);
	}
	.closing {
		margin: 64px 0 0;
		max-width: 56ch;
		font-size: 18px;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.75);
	}
	@media (min-width: 768px) {
		.section-title {
			font-size: 48px;
		}
		.collage {
			grid-template-columns: 1fr 1fr;
		}
	}
	@media (min-width: 1024px) {
		.collage {
			grid-template-columns: repeat(12, 1fr);
		}
		:global(.rogue-slot) {
			grid-column: span 5 / span 5;
		}
		:global(.rogue-slot.slot-left) {
			grid-column-start: 1;
		}
		:global(.rogue-slot.slot-right) {
			grid-column-start: 8;
		}
		:global(.rogue-slot.slot-offset) {
			margin-top: 64px;
		}
		.rot-neg-1 { --rogue-rot: -1.5deg; }
		.rot-1 { --rogue-rot: 1deg; }
		.rot-neg-2 { --rogue-rot: -2deg; }
	}
</style>
