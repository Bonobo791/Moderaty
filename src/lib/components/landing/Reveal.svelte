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
