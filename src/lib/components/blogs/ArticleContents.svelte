<script lang="ts">
	let { headings }: { headings: readonly { id: string; title: string }[] } = $props();
	let activeId = $state('');
	let mobileDisclosure: HTMLDetailsElement | undefined = $state();

	$effect(() => {
		const targets = headings.map(({ id }) => ({ id, element: document.getElementById(id) }));
		let frame = 0;
		const update = () => {
			frame = 0;
			activeId = targets.findLast(({ element }) => element && element.getBoundingClientRect().top <= 112)?.id ?? '';
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(update);
		};
		update();
		window.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule);
		window.addEventListener('hashchange', schedule);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener('scroll', schedule);
			window.removeEventListener('resize', schedule);
			window.removeEventListener('hashchange', schedule);
		};
	});
</script>

{#snippet contents()}
	<ol class="contents-list">
		{#each headings as heading (heading.id)}
			<li>
				<a
					href="#{heading.id}"
					aria-current={activeId === heading.id ? 'location' : undefined}
					onclick={() => { if (mobileDisclosure) mobileDisclosure.open = false; }}
				>{heading.title}</a>
			</li>
		{/each}
	</ol>
{/snippet}

{#if headings.length > 0}
	<aside class="contents-rail">
		<nav class="desktop-contents" aria-label="On this page">
			<p class="contents-label">On this page</p>
			{@render contents()}
		</nav>
	</aside>
	<details class="mobile-contents" bind:this={mobileDisclosure}>
		<summary>On this page <span class="chevron" aria-hidden="true"></span></summary>
		<nav aria-label="On this page">
			{@render contents()}
		</nav>
	</details>
{/if}

<style>
	.contents-rail { display: none; }
	.contents-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.contents-list a {
		display: flex;
		align-items: center;
		min-height: 44px;
		padding: 10px 16px;
		border-left: 2px solid transparent;
		color: var(--text-2);
		font-size: 14px;
		line-height: 1.5;
		text-decoration: none;
	}
	.contents-list a:hover {
		color: var(--paper);
		background: var(--surface);
	}
	.contents-list a[aria-current='location'] {
		border-left-color: var(--ban);
		color: var(--paper);
		background: var(--surface);
	}
	.contents-list a:focus-visible,
	summary:focus-visible {
		outline: 2px solid var(--paper);
		outline-offset: -2px;
	}
	.mobile-contents {
		margin: 0 0 32px;
		border: 1px solid var(--line-strong);
		background: var(--surface);
	}
	summary,
	.contents-label {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		min-height: 48px;
		padding: 12px 16px;
		cursor: pointer;
		list-style: none;
	}
	summary::-webkit-details-marker { display: none; }
	.chevron {
		width: 8px;
		height: 8px;
		border-right: 1px solid currentColor;
		border-bottom: 1px solid currentColor;
		transform: rotate(45deg);
	}
	details[open] .chevron { transform: rotate(225deg); }
	.mobile-contents nav {
		padding: 4px 0;
		border-top: 1px solid var(--line-strong);
	}
	@media (min-width: 1440px) {
		.mobile-contents { display: none; }
		.contents-rail {
			display: block;
			position: absolute;
			top: 0;
			bottom: 0;
			right: calc(100% + 32px);
			width: 240px;
		}
		.desktop-contents {
			position: sticky;
			top: 96px;
			max-height: calc(100dvh - 128px);
			overflow-y: auto;
			overscroll-behavior: contain;
		}
		.contents-label {
			margin: 0 0 16px;
			color: var(--text-2);
		}
		.contents-list { border-left: 1px solid var(--line-strong); }
		.contents-list a { margin-left: -1px; }
	}
</style>
