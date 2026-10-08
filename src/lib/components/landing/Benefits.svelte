<script lang="ts">
	import Reveal from './Reveal.svelte';
	import Icon from './Icon.svelte';
</script>

<section class="section">
	<Reveal>
		<h2 class="section-title">What you get back</h2>
	</Reveal>
	<div class="grid">
		<Reveal class="chunk wide" delay={0.05}>
			<Icon name="sun-horizon" size={28} />
			<div class="numerals">
				<span class="numeral">47</span>
				<span class="numeral-label">example comments</span>
				<span class="numeral mint">6</span>
				<span class="numeral-label">queued for review</span>
			</div>
			<h3 class="chunk-title">Your mornings.</h3>
			<p class="chunk-body">
				An illustrative batch: 47 top-level comments, 6 queued for review. Your rules and AI
				scoring handle decisions where they can; uncertain results still need you. Check the
				queue and channel status to see what needs attention.
			</p>
		</Reveal>
		<div class="stack">
			<Reveal class="chunk" delay={0.1}>
				<Icon name="users-three" size={28} />
				<h3 class="chunk-title">Your rules as your channel grows.</h3>
				<p class="chunk-body">
					Moderaty applies your rules to scanned top-level comments in background batches.
					Larger backlogs take additional checks. Paused channels and failed checks need attention.
				</p>
			</Reveal>
			<Reveal class="chunk" delay={0.15}>
				<Icon name="handshake" size={28} />
				<h3 class="chunk-title">Decisions you can check.</h3>
				<p class="chunk-body">
					Use the audit log to see recorded decisions and completed actions. A queued decision
					can still need review, and a comment may remain public until its hold is confirmed.
				</p>
			</Reveal>
		</div>
	</div>
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
	.grid {
		margin-top: 56px;
		display: grid;
		gap: 32px;
	}
	:global(.chunk) {
		border-top: 1px solid var(--line);
		padding-top: 32px;
		color: rgb(244 244 248 / 0.7);
	}
	.numerals {
		margin-top: 24px;
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 12px;
	}
	.numeral {
		font-family: var(--font-mono);
		font-size: 60px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: 1;
		color: var(--paper);
	}
	.numeral.mint {
		color: var(--mint);
	}
	.numeral-label {
		padding-bottom: 4px;
		font-family: var(--font-mono);
		font-size: 14px;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: rgb(244 244 248 / 0.5);
	}
	.chunk-title {
		margin: 24px 0 0;
		font-family: var(--font-display);
		font-size: 24px;
		font-weight: 700;
		color: var(--paper);
	}
	.chunk-body {
		margin: 12px 0 0;
		max-width: 58ch;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.7);
	}
	.stack {
		display: flex;
		flex-direction: column;
		gap: 32px;
	}
	@media (min-width: 768px) {
		.section-title {
			font-size: 48px;
		}
		.numeral {
			font-size: 72px;
		}
	}
	@media (min-width: 1024px) {
		.grid {
			grid-template-columns: repeat(5, 1fr);
		}
		:global(.chunk.wide) {
			grid-column: span 3;
		}
		.stack {
			grid-column: span 2;
		}
	}
</style>
