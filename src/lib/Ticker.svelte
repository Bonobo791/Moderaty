<!-- Ticker: integer counter that tweens to its target over `duration`
     (350ms default, cubic-out matching --ease-out) via rAF. Under
     prefers-reduced-motion the final value renders instantly. SSR renders
     the target directly. -->

<script lang="ts">
	import { untrack } from 'svelte';

	let { value, duration = 350 }: { value: number; duration?: number } = $props();

	let shown = $state<number>();
	const displayed = $derived(shown ?? Math.round(value));

	$effect(() => {
		const target = Math.round(value);
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		// `shown` is written by tick() below — reading it bare would make this
		// effect depend on its own output and re-trigger on every frame (codex).
		const current = untrack(() => shown ?? target);
		if (reduced || duration <= 0 || current === target) {
			shown = target;
			return;
		}
		const from = current;
		const start = performance.now();
		let raf = 0;
		const tick = (now: number) => {
			const t = Math.min(1, (now - start) / duration);
			// cubic-out — the same feel as --ease-out
			const eased = 1 - Math.pow(1 - t, 3);
			shown = Math.round(from + (target - from) * eased);
			if (t < 1) raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	});
</script>

<span class="mono">{displayed}</span>
