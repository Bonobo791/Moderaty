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

<!-- Ticker: integer counter that tweens to its target over `duration`
     (350ms default, cubic-out matching --ease-out) via rAF. Under
     prefers-reduced-motion the final value renders instantly. SSR renders
     the target directly. -->

<script lang="ts">
	let { value, duration = 350 }: { value: number; duration?: number } = $props();

	let shown = $state(Math.round(value));

	$effect(() => {
		const target = Math.round(value);
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (reduced || duration <= 0 || shown === target) {
			shown = target;
			return;
		}
		const from = shown;
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

<span class="mono">{shown}</span>
