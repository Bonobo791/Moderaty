<!--
	Scroll reveal: fade + translateY(24px) once when the element enters the
	viewport, optional stagger via `delay`. The hidden state is only applied
	from JS ("armed"), so no-JS and reduced-motion users always see content.
-->

<script lang="ts">
	import { onMount } from 'svelte';
	import type { Snippet } from 'svelte';

	let {
		children,
		delay = 0,
		amount = 0.3,
		class: className = ''
	}: {
		children: Snippet;
		delay?: number;
		amount?: number;
		class?: string;
	} = $props();

	let el: HTMLDivElement | undefined = $state();
	let armed = $state(false);
	let visible = $state(false);

	onMount(() => {
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		armed = true;
		const io = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) {
					visible = true;
					io.disconnect();
				}
			},
			{ threshold: amount }
		);
		if (el) io.observe(el);
		return () => io.disconnect();
	});
</script>

<div
	bind:this={el}
	class="reveal {className}"
	class:armed
	class:visible
	style:transition-delay="{delay}s"
>
	{@render children()}
</div>

<style>
	.reveal.armed {
		opacity: 0;
		transform: translateY(24px);
		transition:
			opacity 600ms cubic-bezier(0.16, 1, 0.3, 1),
			transform 600ms cubic-bezier(0.16, 1, 0.3, 1);
	}
	.reveal.armed.visible {
		opacity: 1;
		transform: none;
	}
</style>
