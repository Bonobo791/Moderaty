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
