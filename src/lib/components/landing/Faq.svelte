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
	import Icon from './Icon.svelte';

	const FAQS: { q: string; a: string }[] = [
		{
			q: 'What is Moderaty?',
			a: "Moderaty is comment protection for YouTube creators. It reads every new comment on your channel, enforces your rules instantly, scores the rest with AI across 13 toxicity categories, and holds anything borderline for your one-click review. It's free and open source under AGPL."
		},
		{
			q: 'Will Moderaty ban my real fans?',
			a: "Not by default. Only comments scoring 0.95 or higher on the AI's toxicity scale trigger an automatic ban. Anything uncertain waits in your review queue for a one-click decision, and every action is logged and reversible."
		},
		{
			q: "What happens when the AI isn't sure about a comment?",
			a: 'It goes to your queue. If the AI can\'t score a comment at all, the comment is held for you, never auto-approved and never auto-rejected.'
		},
		{
			q: 'Does Moderaty reply to comments or post anything?',
			a: 'No. Moderaty is protection-only. It holds, hides, deletes, and bans. It never writes replies, never posts under your name, and never does growth automation.'
		},
		{
			q: 'What YouTube account access does Moderaty need?',
			a: 'Google OAuth permission to read and moderate comments on your channel. Nothing else. The code is open source under AGPL, so you can verify exactly what it does with that access.'
		},
		{
			q: 'Is Moderaty really free?',
			a: 'Yes. Moderaty is free and open source under the AGPL license. Connect your channel and your next 100 comments are protected in about two minutes of setup.'
		},
		{
			q: 'How is Moderaty different from CommentShark or YouTube Studio?',
			a: 'YouTube Studio flags comments but leaves you to read and act on them. CommentShark automates engagement, including AI replies. Moderaty does one job: enforce your norms so you never have to read the hate.'
		},
		{
			q: 'Can I test Moderaty without changing anything on my channel?',
			a: 'Yes. Dry-run mode classifies everything and changes nothing. The audit trail shows exactly what would have happened, comment by comment.'
		}
	];
</script>

<section id="faq" class="section">
	<Reveal>
		<h2 class="section-title">Asked, answered.</h2>
	</Reveal>
	<Reveal delay={0.05}>
		<div class="faq-list">
			{#each FAQS as f}
				<details class="faq-item">
					<summary class="faq-q">
						<span class="faq-q-text">{f.q}</span>
						<span class="faq-plus"><Icon name="plus" size={18} /></span>
					</summary>
					<p class="faq-a">{f.a}</p>
				</details>
			{/each}
		</div>
	</Reveal>
</section>

<style>
	.section {
		max-width: 768px;
		margin: 0 auto;
		padding: 96px 24px;
	}
	.section-title {
		font-family: var(--font-display);
		font-size: 40px;
		font-weight: 800;
		letter-spacing: -0.02em;
		color: var(--paper);
		margin: 0;
	}
	.faq-list {
		margin-top: 48px;
		border-top: 1px solid var(--line);
		border-bottom: 1px solid var(--line);
	}
	.faq-item {
		padding: 20px 0;
	}
	.faq-item + .faq-item {
		border-top: 1px solid var(--line);
	}
	.faq-q {
		display: flex;
		cursor: pointer;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		text-align: left;
	}
	.faq-q-text {
		font-size: 18px;
		font-weight: 600;
		color: var(--paper);
	}
	.faq-plus {
		flex-shrink: 0;
		display: inline-flex;
		color: rgb(244 244 248 / 0.5);
	}
	.faq-a {
		margin: 12px 0 0;
		max-width: 62ch;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.7);
	}
	@media (min-width: 768px) {
		.section-title {
			font-size: 48px;
		}
	}
</style>
