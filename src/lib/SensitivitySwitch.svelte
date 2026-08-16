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

<!-- SensitivitySwitch: the two-stop moderation-sensitivity control
	 (redesign spec §7/Step 3.2). Two meme endpoints, a 4px track with end
	 notches, and a 40px knob that snaps to CHILL (1) or STRICT (2). Changes
	 persist through the same ?/setToneLevel action the old range slider
	 used: an 800ms debounce (restarted on every re-flip, so a rapid
	 double-flip fires exactly one request with the final value) submits the
	 hidden form programmatically; `Applied` shows for 1.6s then fades over
	 150ms; a failed action reverts the knob silently (spec §6.5). -->

<script lang="ts">
	import { enhance } from '$app/forms';

	let {
		channelId,
		channelTitle,
		level
	}: {
		channelId: string;
		channelTitle: string;
		level: number;
	} = $props();

	const MODES = {
		1: {
			stop: 'CHILL',
			name: 'CHILL PEPE',
			description: 'Only clear hate speech and spam get bounced. Snark survives.'
		},
		2: {
			stop: 'STRICT',
			name: 'EDGE LORD + ACKCHYUALLY...',
			description: 'Hateful comments and demeaning, condescending, or sarcastic tone are moderated.'
		}
	} as const;

	// Displayed selection; 0/100 is the spec's slider value space.
	let selected = $state<1 | 2>(level === 2 ? 2 : 1);
	const v = $derived(selected === 2 ? 100 : 0);
	const mode = $derived(MODES[selected]);
	// Keeps the knob inside the track at both stops (spec Step 3.2).
	const knobLeft = $derived(v === 0 ? 'calc(0% + 20px)' : 'calc(100% - 20px)');

	// True while a change is debouncing or its submit is in flight — the
	// server value must not snap the knob back until the persist settles.
	let dirty = $state(false);
	let appliedNow = $state(false);
	let appliedFading = $state(false);
	let dragging = $state(false);
	let formEl: HTMLFormElement | undefined = $state();
	let trackEl: HTMLElement | undefined = $state();
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let appliedTimer: ReturnType<typeof setTimeout> | undefined;
	let appliedFadeTimer: ReturnType<typeof setTimeout> | undefined;

	// Server state wins while nothing awaits persistence (autoRefresh
	// revalidates the load every 15s; another surface may change the level).
	$effect(() => {
		if (!dirty) selected = level === 2 ? 2 : 1;
	});
	$effect(() => () => clearTimeout(debounceTimer));
	$effect(() => () => {
		clearTimeout(appliedTimer);
		clearTimeout(appliedFadeTimer);
	});

	function choose(next: 1 | 2) {
		if (next === selected) return;
		selected = next;
		dirty = true;
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => formEl?.requestSubmit(), 800);
	}

	function showApplied() {
		clearTimeout(appliedTimer);
		clearTimeout(appliedFadeTimer);
		appliedNow = true;
		appliedFading = false;
		appliedTimer = setTimeout(() => {
			appliedFading = true;
			appliedFadeTimer = setTimeout(() => {
				appliedNow = false;
				appliedFading = false;
			}, 150);
		}, 1600);
	}

	// use:enhance callback: on success show `Applied`; on failure revert the
	// knob silently (spec §6.5) — the revalidated load restores the last
	// persisted level, and setting `selected` now skips the wait.
	function handlePersist(result: { type: string }) {
		dirty = false;
		if (result.type === 'success') {
			showApplied();
		} else if (result.type === 'failure' || result.type === 'error') {
			selected = level === 2 ? 2 : 1;
		}
	}

	function onTrackClick(event: MouseEvent) {
		if (dragging || !trackEl) return;
		const rect = trackEl.getBoundingClientRect();
		choose(event.clientX - rect.left < rect.width / 2 ? 1 : 2);
	}

	function onTrackKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'End') {
			event.preventDefault();
			choose(2);
		} else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown' || event.key === 'Home') {
			event.preventDefault();
			choose(1);
		}
	}

	// Pointer drag on the knob: snaps to the nearer stop; the accent halo
	// shows only while dragging (spec §7 — the sole allowed shadow).
	function onKnobPointerdown(event: PointerEvent) {
		event.preventDefault();
		dragging = true;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}
	function onKnobPointermove(event: PointerEvent) {
		if (!dragging || !trackEl) return;
		const rect = trackEl.getBoundingClientRect();
		choose(event.clientX - rect.left < rect.width / 2 ? 1 : 2);
	}
	function onKnobPointerup() {
		dragging = false;
	}
</script>

<section class="sensitivity-switch" aria-labelledby="sensitivity-label-{channelId}">
	<div class="switch-head">
		<span class="caps-label" id="sensitivity-label-{channelId}">Moderation sensitivity</span>
		{#if appliedNow}
			<span class="applied" class:fading={appliedFading} role="status">Applied</span>
		{/if}
	</div>

	<div class="switch-row">
		<button
			type="button"
			class="endpoint chill"
			class:inactive={selected !== 1}
			aria-label="Set sensitivity to Chill Pepe"
			onclick={() => choose(1)}
		>
			<img src="/edge-lord.jpg" alt="" width="44" height="44" />
			EDGE LORD
		</button>

		<div
			bind:this={trackEl}
			class="track"
			role="slider"
			tabindex="0"
			aria-label="Moderation sensitivity for {channelTitle}"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={v}
			aria-valuetext={mode.name}
			onclick={onTrackClick}
			onkeydown={onTrackKeydown}
		>
			<span class="notch left"></span>
			<span class="notch right"></span>
			<span class="fill" style:width="{v}%"></span>
			<span
				class="knob"
				class:dragging
				style:left={knobLeft}
				onpointerdown={onKnobPointerdown}
				onpointermove={onKnobPointermove}
				onpointerup={onKnobPointerup}
				onpointercancel={onKnobPointerup}
			>
				<span class="index-line"></span>
			</span>
		</div>

		<button
			type="button"
			class="endpoint strict"
			class:inactive={selected !== 2}
			aria-label="Set sensitivity to Edge Lord plus Ackchyually"
			onclick={() => choose(2)}
		>
			<img src="/ackchyually.gif" alt="" width="44" height="44" />
			EDGE LORD + ACKCHYUALLY&hellip;
		</button>
	</div>

	{#key selected}
		<div class="readout">
			<span class="mode-stop mono" class:strict={selected === 2}>{mode.stop}</span>
			<div class="mode-copy">
				<span class="caps-label mode-name">{mode.name}</span>
				<p class="mode-desc">{mode.description}</p>
			</div>
		</div>
	{/key}

	<form
		bind:this={formEl}
		method="POST"
		action="?/setToneLevel"
		use:enhance={() => {
			return async ({ result, update }) => {
				handlePersist(result);
				await update();
			};
		}}
		hidden
	>
		<input type="hidden" name="channelId" value={channelId} />
		<input type="hidden" name="toneLevel" value={selected} />
	</form>
</section>

<style>
	.sensitivity-switch {
		margin: 10px 0 14px;
	}
	.switch-head {
		display: flex;
		align-items: baseline;
		gap: 14px;
		margin-bottom: 18px;
	}
	.applied {
		font-size: 12px;
		color: var(--ok);
		transition: opacity 150ms var(--ease-out);
	}
	.applied.fading {
		opacity: 0;
	}

	.switch-row {
		display: flex;
		align-items: center;
		gap: 20px;
	}
	.endpoint {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 10px;
		border: none;
		background: none;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.08em;
		color: var(--text);
		cursor: pointer;
		transition: opacity 150ms var(--ease-out);
	}
	.endpoint.inactive {
		opacity: 0.4;
	}
	.endpoint.inactive:hover {
		opacity: 0.7;
	}
	.endpoint.strict {
		background: #2b0d13;
		color: var(--accent);
	}
	@media (max-width: 639px) {
		.endpoint.strict {
			display: none;
		}
	}

	.track {
		position: relative;
		flex: 1;
		height: 40px;
		cursor: pointer;
	}
	.track:focus-visible {
		outline: 1px solid var(--accent);
		outline-offset: 2px;
	}
	/* the 4px rail (knob-height container centers it) */
	.track::before {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		top: 50%;
		height: 4px;
		transform: translateY(-50%);
		background: var(--line);
	}
	.fill {
		position: absolute;
		left: 0;
		top: 50%;
		height: 4px;
		transform: translateY(-50%);
		background: var(--accent);
		transition: width 150ms var(--ease-out);
	}
	.notch {
		position: absolute;
		top: 50%;
		width: 2px;
		height: 12px;
		transform: translateY(-50%);
		background: var(--text-3);
	}
	.notch.left {
		left: 0;
	}
	.notch.right {
		right: 0;
	}
	.knob {
		position: absolute;
		top: 50%;
		width: 40px;
		height: 40px;
		transform: translate(-50%, -50%);
		background: var(--text);
		cursor: grab;
		touch-action: none;
		transition: left 150ms var(--ease-out);
	}
	.knob.dragging {
		cursor: grabbing;
		box-shadow: 0 0 0 4px rgba(255, 49, 49, 0.25);
		transition: none;
	}
	.index-line {
		position: absolute;
		left: 50%;
		top: 6px;
		bottom: 6px;
		width: 2px;
		transform: translateX(-50%);
		background: var(--accent);
	}

	.readout {
		display: flex;
		align-items: center;
		gap: 24px;
		margin-top: 20px;
		animation: readout-in 150ms var(--ease-out);
	}
	@keyframes readout-in {
		from {
			opacity: 0;
		}
	}
	.mode-stop {
		font-size: 48px;
		line-height: 1;
		color: var(--text);
	}
	.mode-stop.strict {
		color: var(--accent);
	}
	.mode-copy {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.mode-name {
		color: var(--accent);
	}
	.mode-desc {
		margin: 0;
		font-size: 14px;
		color: var(--text-2);
	}

	@media (prefers-reduced-motion: reduce) {
		.readout {
			animation: none;
		}
		.knob,
		.fill,
		.endpoint,
		.applied {
			transition: none;
		}
	}
</style>
