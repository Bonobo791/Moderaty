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

<script lang="ts">
	import Reveal from './Reveal.svelte';
	import type { Snippet } from 'svelte';
</script>

{#snippet stat(figure: string, body: Snippet, wide = false, delay = 0)}
	<Reveal class="stat {wide ? 'stat-wide' : ''}" {delay}>
		<div class="brackets stat-box">
			<div class="brackets-inner stat-inner">
				<div class="stat-figure">{figure}</div>
				<p class="stat-body">{@render body()}</p>
			</div>
		</div>
	</Reveal>
{/snippet}

<section id="numbers" class="section">
	<Reveal>
		<blockquote class="quote-line">
			"You're surrounded by comments, but no one actually sees <em>you</em>."
		</blockquote>
		<p class="quote-attr">A creator in the Creators 4 Mental Health study</p>
	</Reveal>

	<Reveal delay={0.05}>
		<h2 class="section-title">This was never a "thick skin" problem.</h2>
	</Reveal>

	<div class="stats-grid">
		{#snippet s1()}
			creators <a class="stat-link" href="https://hsph.harvard.edu/news/content-creators-are-struggling-with-mental-health-study-finds/" target="_blank" rel="noreferrer">report suicidal thoughts tied to their work</a>,
			nearly double the US adult rate. "Constant toxicity" is one of the named pressures.
			Creators 4 Mental Health / Lupiani Insights, 542 creators, 2025.
		{/snippet}
		{@render stat('1 in 10', s1)}

		{#snippet s2()}
			of creators <a class="stat-link" href="https://www.tubefilter.com/2025/11/12/creators-4-mental-health-burnout-study-results/" target="_blank" rel="noreferrer">experience burnout</a>,
			and it gets worse the longer they do the job. The same study, 2025.
		{/snippet}
		{@render stat('62%', s2, false, 0.05)}

		{#snippet s3()}
			comments on young creators' videos <a class="stat-link" href="https://foster.uw.edu/news/the-weight-of-hate/" target="_blank" rel="noreferrer">is insulting, obscene, threatening, or hateful</a>,
			and the first hateful comment makes the next ones more likely. 110M comments analyzed,
			UW Foster / MIT Sloan, 2022.
		{/snippet}
		{@render stat('1 in 20', s3, false, 0.1)}

		{#snippet s4()}
			of toxic comments <a class="stat-link" href="https://www.diva-portal.org/smash/get/diva2:1784332/FULLTEXT01.pdf" target="_blank" rel="noreferrer">target a person, most often the creator</a>.
			It isn't abstract discourse. It's aimed at you. Stockholm University, 2022.
		{/snippet}
		{@render stat('86.8%', s4, false, 0.15)}

		{#snippet s5()}
			less toxicity in what people write themselves when toxic comments are hidden.
			<a class="stat-link" href="https://tacklinghate.org/blogs/research-shows-why-platforms-struggle-to-curb-online-toxicity/" target="_blank" rel="noreferrer">Toxicity is contagious; so is removing it</a>.
			Moderation doesn't just protect you. It keeps your regulars civil. Beknazar-Yuzbashev et
			al., 2025.
		{/snippet}
		{@render stat('25 – 30%', s5, true, 0.2)}
	</div>

	<Reveal delay={0.1}>
		<p class="closing">Reading the comments is the job nobody hired you for. Hand it off.</p>
	</Reveal>
</section>

<style>
	.section {
		max-width: 1152px;
		margin: 0 auto;
		padding: 96px 24px;
	}
	.quote-line {
		max-width: 26ch;
		font-family: var(--font-display);
		font-size: 30px;
		font-weight: 700;
		line-height: 1.2;
		letter-spacing: -0.01em;
		color: rgb(244 244 248 / 0.85);
		margin: 0;
	}
	.quote-line em {
		font-style: italic;
		color: var(--paper);
	}
	.quote-attr {
		margin: 16px 0 0;
		font-family: var(--font-mono);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		color: rgb(244 244 248 / 0.45);
	}
	.section-title {
		margin: 64px 0 0;
		max-width: 20ch;
		font-family: var(--font-display);
		font-size: 40px;
		font-weight: 800;
		letter-spacing: -0.02em;
		color: var(--paper);
	}
	.stats-grid {
		margin-top: 48px;
		display: grid;
		gap: 24px;
	}
	:global(.stat) {
		height: 100%;
	}
	.stat-box {
		height: 100%;
		border: 1px solid var(--line);
		background: rgb(18 18 30 / 0.4);
	}
	.stat-inner {
		height: 100%;
		padding: 32px;
	}
	.stat-figure {
		font-family: var(--font-display);
		font-stretch: 125%;
		font-size: 48px;
		font-weight: 800;
		letter-spacing: -0.02em;
		color: var(--paper);
	}
	.stat-body {
		margin: 16px 0 0;
		max-width: 60ch;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.7);
	}
	.stat-link {
		color: inherit;
		text-decoration: underline;
		text-decoration-color: rgb(244 244 248 / 0.4);
		text-underline-offset: 4px;
		transition:
			color 200ms ease,
			text-decoration-color 200ms ease;
	}
	.stat-link:hover {
		color: var(--ban);
		text-decoration-color: var(--ban);
	}
	.closing {
		margin: 56px 0 0;
		max-width: 46ch;
		font-size: 20px;
		font-weight: 500;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.85);
	}
	@media (min-width: 768px) {
		.quote-line {
			font-size: 36px;
		}
		.section-title {
			font-size: 48px;
		}
		.stats-grid {
			grid-template-columns: 1fr 1fr;
		}
		:global(.stat.stat-wide) {
			grid-column: span 2;
		}
		.stat-figure {
			font-size: 60px;
		}
	}
</style>
