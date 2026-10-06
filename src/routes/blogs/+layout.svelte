<script lang="ts">
	import Nav from '$lib/components/landing/Nav.svelte';
	import Footer from '$lib/components/landing/Footer.svelte';
	let { children } = $props();
</script>

<a href="#blog-content" class="skip-link">Skip to content</a>
<Nav />
<main id="blog-content" class="blog-content" tabindex="-1">
	{@render children()}
</main>
<Footer />

<style>
	.skip-link {
		position: fixed;
		top: 8px;
		left: 16px;
		z-index: 100;
		padding: 12px 16px;
		background: var(--paper);
		color: var(--ink);
		transform: translateY(-160%);
	}
	.skip-link:focus { transform: translateY(0); }
	.blog-content {
		max-width: 832px;
		margin: 0 auto;
		padding: 112px 24px 80px;
		font-size: 18px;
		line-height: 1.75;
		overflow-wrap: break-word;
	}
	.blog-content :global(h1) {
		font-size: clamp(32px, 6vw, 52px);
		line-height: 1.15;
		letter-spacing: -0.025em;
		margin: 24px 0 32px;
	}
	.blog-content :global(h2) {
		font-size: clamp(24px, 4vw, 30px);
		line-height: 1.3;
		margin: 48px 0 20px;
		scroll-margin-top: 96px;
	}
	.blog-content :global(p) { margin: 0 0 24px; }
	.blog-content :global(a) {
		color: var(--paper);
		text-decoration: underline;
		text-underline-offset: 4px;
	}
	.blog-content :global(a:hover) { text-decoration-thickness: 2px; }
	.blog-content :global(a:focus-visible),
	.blog-content :global(.table-scroll:focus-visible) {
		outline: 2px solid var(--paper);
		outline-offset: 4px;
	}
	.blog-content :global(.breadcrumbs) {
		font-size: 14px;
		color: var(--text-2);
	}
	.blog-content :global(.breadcrumbs ol) {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 16px;
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.blog-content :global(.breadcrumbs li + li::before) {
		content: '/';
		margin-right: 16px;
	}
	.blog-content :global(.table-scroll) {
		overflow-x: auto;
		margin-bottom: 24px;
		border: 1px solid var(--line-strong);
	}
	.blog-content :global(table) {
		width: 100%;
		min-width: 600px;
		border-collapse: collapse;
		font-size: 16px;
		line-height: 1.6;
	}
	.blog-content :global(caption) {
		padding: 16px;
		text-align: left;
		font-weight: 600;
		background: var(--surface);
	}
	.blog-content :global(th),
	.blog-content :global(td) {
		padding: 16px;
		text-align: left;
		vertical-align: top;
		border-top: 1px solid var(--line-strong);
	}
	.blog-content :global(th) {
		background: var(--surface);
		color: var(--paper);
		font-family: inherit;
		font-size: inherit;
		font-weight: 600;
		letter-spacing: normal;
		text-transform: none;
	}
	.blog-content :global(blockquote) {
		margin: 24px 0;
		padding: 16px 24px;
		border-left: 3px solid var(--text-2);
		background: var(--surface);
	}
	.blog-content :global(blockquote p) { margin: 0; }
	@media (max-width: 480px) {
		.blog-content { padding: 96px 16px 64px; }
	}
</style>
