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

<!-- Ticker: integer counter that tweens to its target over `duration`
     (350ms default, cubic-out matching --ease-out) via rAF. Under
     prefers-reduced-motion the final value renders instantly. SSR renders
     the target directly. -->

<script lang="ts">
	let { value, duration = 350 }: { value: number; duration?: number } = $props();

	let shown = $state<number>();
	const displayed = $derived(shown ?? Math.round(value));

	$effect(() => {
		const target = Math.round(value);
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const current = shown ?? target;
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
