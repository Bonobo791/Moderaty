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
	import type { Snippet } from 'svelte';
</script>

{#snippet terminal(label: string, lines: Snippet)}
	<div class="brackets terminal">
		<div class="brackets-inner">
			<div class="terminal-head">
				<span class="terminal-label">{label}</span>
			</div>
			<div class="terminal-body">
				{@render lines()}
			</div>
		</div>
	</div>
{/snippet}

<section id="how-it-works" class="section">
	<Reveal>
		<h2 class="section-title">Three things happen to every comment. None of them involve you.</h2>
	</Reveal>

	<div class="steps">
		<Reveal class="step">
			<div class="step-text">
				<h3 class="step-title">Your rules fire first.</h3>
				<p class="step-body">
					Write your norms in plain English: keywords, patterns, people. Every new comment meets
					your rules before anything else touches it, and a rule hit acts immediately: hold it,
					reject it, delete it, or ban the author. Your regexes are validated for safety before
					they ever compile, so a pattern can never be turned against the app itself.
				</p>
			</div>
			{@render terminal('rules.txt', rules)}
		</Reveal>

		<Reveal class="step">
			<div class="step-text">
				<h3 class="step-title">The AI scores what your rules miss.</h3>
				<p class="step-body">
					Everything your rules don't catch is scored by OpenAI's moderation model across 13
					toxicity categories. The highest score decides. If the AI can't score a comment, it
					lands in your queue: never auto-approved, never auto-rejected.
				</p>
			</div>
			{@render terminal('score ladder', ladder)}
		</Reveal>

		<Reveal class="step">
			<div class="step-text">
				<h3 class="step-title">Doubt is always yours to decide.</h3>
				<p class="step-body">
					Borderline comments wait in your review queue: one click to approve, reject, delete, or
					ban. Every action is written to the audit log before it happens on YouTube, so nothing
					disappears without a trace and a crash mid-run never repeats an action. Dry-run mode
					classifies everything and changes nothing until you trust it.
				</p>
			</div>
			{@render terminal('audit.log', audit)}
		</Reveal>
	</div>
</section>

{#snippet rules()}
	<div><span class="t-dim">KEYWORD</span> <span class="t-lit">"crypto giveaway"</span> <span class="t-arrow">→</span> <span class="t-ban">DELETE</span></div>
	<div><span class="t-dim">REGEX</span> <span class="t-lit">^https?://</span> <span class="t-arrow">→</span> <span class="t-amber">HOLD FOR REVIEW</span></div>
	<div><span class="t-dim">USER</span> <span class="t-lit">UC…</span> <span class="t-arrow">→</span> <span class="t-ban">REJECT + BAN AUTHOR</span></div>
	<div class="t-note">examples. your rules are yours.</div>
{/snippet}

{#snippet ladder()}
	<div><span class="t-lit">≥ 0.95</span> <span class="t-arrow">→</span> <span class="t-ban">AUTHOR BANNED AUTOMATICALLY</span></div>
	<div><span class="t-lit">0.76 – 0.94</span> <span class="t-arrow">→</span> <span class="t-ban">REJECTED AUTOMATICALLY</span></div>
	<div><span class="t-lit">0.51 – 0.75</span> <span class="t-arrow">→</span> <span class="t-amber">HELD FOR YOUR REVIEW</span></div>
	<div><span class="t-lit">≤ 0.50</span> <span class="t-arrow">→</span> <span class="t-mint">APPROVED</span></div>
{/snippet}

{#snippet audit()}
	<div><span class="t-dim">03:12:04</span> <span class="t-ban">BANNED</span> <span class="t-mid">@xX_grassfree_Xx</span> <span class="t-arrow">score 0.97</span></div>
	<div><span class="t-dim">03:12:31</span> <span class="t-ban">DELETED</span> <span class="t-mid">@CryptoKingdom42</span> <span class="t-arrow">rule: keyword</span></div>
	<div><span class="t-dim">03:14:02</span> <span class="t-amber">HELD</span> <span class="t-mid">@UmAckchyually</span> <span class="t-arrow">score 0.68, queued</span></div>
	<div><span class="t-dim">03:14:55</span> <span class="t-mint">APPROVED</span> <span class="t-mid">@bia_souza</span> <span class="t-arrow">score 0.02</span></div>
	<div class="t-note">logged before it happens. reversible, always.</div>
{/snippet}

<style>
	.section {
		max-width: 1152px;
		margin: 0 auto;
		padding: 96px 24px;
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
	.steps {
		margin-top: 64px;
		display: flex;
		flex-direction: column;
		gap: 64px;
	}
	:global(.step) {
		display: grid;
		align-items: center;
		gap: 32px;
	}
	.step-title {
		font-family: var(--font-display);
		font-size: 24px;
		font-weight: 700;
		color: var(--paper);
		margin: 0;
	}
	.step-body {
		margin: 12px 0 0;
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
	.t-arrow { color: rgb(244 244 248 / 0.4); }
	.t-ban { color: var(--ban); font-weight: 600; }
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
		:global(.step) {
			grid-template-columns: 1fr 1fr;
			gap: 64px;
		}
	}
</style>
