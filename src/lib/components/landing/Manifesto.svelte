<script lang="ts">
	import Reveal from './Reveal.svelte';
</script>

<section class="manifesto">
	<div class="manifesto-grid">
		<Reveal>
			<h2 class="manifesto-title">
				Every other comment tool wants to grow your channel. Moderaty wants to
				<span class="marker">protect you.</span>
			</h2>
		</Reveal>
		<Reveal delay={0.08}>
			<div class="manifesto-body">
				<p>
					No auto-replies. No engagement automation. No AI chatting up your audience under your
					name. Nothing touches your community except to protect it, because the moment a tool's
					business is doing more in your comments, your safety becomes its side quest.
				</p>
				<p>
					If you want AI to reply to your fans, use CommentShark. It's good at that. If you want
					to never read the hate, use us.
				</p>
			</div>
		</Reveal>
	</div>
</section>

<style>
	.manifesto {
		border-top: 1px solid var(--line);
		border-bottom: 1px solid var(--line);
		background: rgb(18 18 30 / 0.4);
	}
	.manifesto-grid {
		max-width: 1152px;
		margin: 0 auto;
		padding: 96px 24px;
		display: grid;
		gap: 48px;
	}
	.manifesto-title {
		max-width: 18ch;
		font-family: var(--font-display);
		font-size: 40px;
		font-weight: 800;
		line-height: 1.05;
		letter-spacing: -0.02em;
		color: var(--paper);
		margin: 0;
	}
	.manifesto-body {
		display: flex;
		height: 100%;
		flex-direction: column;
		justify-content: center;
		gap: 24px;
		font-size: 18px;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.75);
	}
	.manifesto-body p {
		margin: 0;
	}
	@media (min-width: 768px) {
		.manifesto-title {
			font-size: 48px;
		}
	}
	@media (min-width: 1024px) {
		.manifesto-grid {
			grid-template-columns: 1fr 1fr;
			gap: 64px;
		}
	}
</style>
