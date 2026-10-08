<!--
	The feedback digest: opt-in per channel, groups the comments worth
	hearing into recurring themes (questions, criticism, corrections,
	requests) instead of leaving them in the pile. Read-only insight —
	never replies, never posts, never touches moderation; abusive wording
	stays concealed. Cadence is weekly, every 100 comments, or manual, and
	a history scan covers up to 24 months of backlog. Sits between
	HowItWorks and Numbers: the second product pillar, after the
	mechanics and before the emotional stakes.
-->

<script lang="ts">
	import Reveal from './Reveal.svelte';
</script>

<section id="digest" class="section">
	<div class="digest-grid">
		<Reveal class="digest-text">
			<h2 class="section-title">The good ones get a digest.</h2>
			<p class="body">
				Not every comment is hate; some are the reason you make videos. Switch on the feedback
				digest and Moderaty groups scanned top-level comments into recurring questions,
				substantive criticism, corrections, requests. A theme earns a row only when enough
				comments raise it; one-offs are counted, never listed.
			</p>
			<p class="body">
				Read-only, always. The digest never replies, never posts, and never touches a comment's
				moderation. Abusive wording stays concealed inside it: reveal an original for the visit
				you're on and it is hidden again next time. Run it weekly, every 100 new comments, or
				only when you ask, and scan back up to 24 months to hear what the pile was hiding.
			</p>
		</Reveal>
		<Reveal delay={0.1}>
			<div class="brackets terminal">
				<div class="brackets-inner">
					<div class="terminal-head">
						<span class="terminal-label">digest.txt</span>
					</div>
					<div class="terminal-body">
						<div><span class="t-mint">QUESTION</span> <span class="t-lit">"where do you film the market scenes?"</span> <span class="t-dim">×14</span></div>
						<div><span class="t-amber">CRITICISM</span> <span class="t-lit">"the audio dips under the intro music"</span> <span class="t-dim">×9</span></div>
						<div><span class="t-mid">CORRECTION</span> <span class="t-lit">"the ferry opened in 2019, not 2016"</span> <span class="t-dim">×6</span></div>
						<div><span class="t-mid">REQUEST</span> <span class="t-lit">"a part 2 on the night route"</span> <span class="t-dim">×5</span></div>
						<div class="t-note">31 one-offs counted, not listed. read-only. concealed.</div>
					</div>
				</div>
			</div>
		</Reveal>
	</div>
</section>

<style>
	.section {
		max-width: 1152px;
		margin: 0 auto;
		padding: 96px 24px;
	}
	.digest-grid {
		display: grid;
		align-items: center;
		gap: 32px;
	}
	.section-title {
		max-width: 18ch;
		font-family: var(--font-display);
		font-size: 40px;
		font-weight: 800;
		letter-spacing: -0.02em;
		color: var(--paper);
		margin: 0;
	}
	.body {
		margin: 24px 0 0;
		max-width: 58ch;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.7);
	}
	.terminal {
		border-radius: var(--radius);
		border: 1px solid var(--line);
		background: var(--surface);
	}
	.terminal-head {
		border-bottom: 1px solid var(--line);
		padding: 10px 16px;
	}
	.terminal-label {
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: rgb(244 244 248 / 0.45);
	}
	.terminal-body {
		padding: 16px;
		font-family: var(--font-mono);
		font-size: 13px;
		line-height: 2;
		overflow-x: auto;
	}
	.t-dim { color: rgb(244 244 248 / 0.45); }
	.t-lit { color: rgb(244 244 248 / 0.85); }
	.t-mid { color: rgb(244 244 248 / 0.7); }
	.t-amber { color: var(--amber); font-weight: 600; }
	.t-mint { color: var(--mint); font-weight: 600; }
	.t-note {
		margin-top: 12px;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: rgb(244 244 248 / 0.35);
	}
	@media (min-width: 768px) {
		.section-title {
			font-size: 48px;
		}
	}
	@media (min-width: 1024px) {
		.digest-grid {
			grid-template-columns: 1fr 1fr;
			gap: 64px;
		}
	}
</style>
