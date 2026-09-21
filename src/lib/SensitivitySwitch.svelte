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

<!-- SensitivitySwitch: the two-stop moderation-sensitivity control
	 (redesign spec §7/Step 3.2). Two meme endpoints, a 4px track with end
	 notches, and a 40px knob that snaps to EDGE LORD (1) or STRICT (2). Changes
	 persist through the same ?/setToneLevel action the old range slider
	 used: an 800ms debounce (restarted on every re-flip, so a rapid
	 double-flip fires exactly one request with the final value) submits the
	 hidden form programmatically; `Applied` shows for 1.6s then fades over
	 150ms. A failed persist is LOUD (MOD-10): the knob reverts to the
	 persisted server level and an inline alert says the save did not happen —
	 flipping a stop retries without a refresh. -->

<script lang="ts">
	import { enhance } from '$app/forms';
	import { persistOutcome } from '$lib/sensitivityPersist';
	import {
		TONE_LEVEL_OMNI_ONLY,
		TONE_LEVEL_OMNI_AND_TONE,
		type ToneLevel
	} from '$lib/toneLevels';

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
		[TONE_LEVEL_OMNI_ONLY]: {
			stop: 'EDGE LORD',
			name: 'EDGE LORD',
			description: 'Only clear hate speech and spam get yeeted. Snark survives.'
		},
		[TONE_LEVEL_OMNI_AND_TONE]: {
			stop: 'STRICT',
			name: 'EDGE LORD + ACKCHYUALLY...',
			description:
				'Demeaning, condescending, or sarcastic tone gets hidden — never deleted. The edge lord has entered the chat.'
		}
	} as const;

	// Displayed selection; 0/100 is the spec's slider value space.
	let selected = $state<ToneLevel>();
	const selectedValue = $derived(
		selected ?? (level === TONE_LEVEL_OMNI_AND_TONE ? TONE_LEVEL_OMNI_AND_TONE : TONE_LEVEL_OMNI_ONLY)
	);
	const v = $derived(selectedValue === TONE_LEVEL_OMNI_AND_TONE ? 100 : 0);
	const mode = $derived(MODES[selectedValue]);
	// Keeps the knob inside the track at both stops (spec Step 3.2).
	const knobLeft = $derived(v === 0 ? 'calc(0% + 20px)' : 'calc(100% - 20px)');

	// True while a change is debouncing or its submit is in flight — the
	// server value must not snap the knob back until the persist settles.
	let dirty = $state(false);
	// Visible only after a failed persist — a save that did not happen can
	// never look like a save that did (MOD-10).
	let saveError = $state<string | null>(null);
	// One submit at a time: a flip during an in-flight save re-arms the
	// debounce instead of racing a second request (MOD-10).
	let submitting = $state(false);
	// A debounced submit is still waiting to fire — while set, `dirty` must
	// survive the current persist settling, or the server value would snap
	// the knob back mid-queue.
	let queuedSubmit = $state(false);
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
		if (!dirty) selected = level === TONE_LEVEL_OMNI_AND_TONE ? TONE_LEVEL_OMNI_AND_TONE : TONE_LEVEL_OMNI_ONLY;
	});
	$effect(() => () => clearTimeout(debounceTimer));
	$effect(() => () => {
		clearTimeout(appliedTimer);
		clearTimeout(appliedFadeTimer);
	});

	function choose(next: ToneLevel) {
		if (next === selectedValue) return;
		selected = next;
		dirty = true;
		saveError = null;
		queuedSubmit = true;
		scheduleSubmit();
	}

	function scheduleSubmit() {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			if (submitting) {
				// The in-flight save settles first; the latest knob value goes
				// out right after instead of racing a concurrent request.
				scheduleSubmit();
				return;
			}
			queuedSubmit = false;
			formEl?.requestSubmit();
		}, 800);
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

	// use:enhance callback: success shows `Applied`; any failure reverts the
	// knob to the persisted level AND surfaces the message — a save that did
	// not happen can never look like one that did (MOD-10).
	function handlePersist(result: { type: string; data?: { error?: unknown } }) {
		// A re-flip queued behind this submit keeps the knob dirty — the
		// server value must not snap back before that submit goes out.
		dirty = queuedSubmit;
		const outcome = persistOutcome(result, level);
		if (outcome.kind === 'applied') {
			// Symmetric to the failure guard: a stale success must not label the
			// displayed (not-yet-submitted) choice "Applied" — the queued
			// submit's own outcome reports the state (codex, PR #142).
			if (!queuedSubmit) {
				saveError = null;
				showApplied();
			}
		} else if (!queuedSubmit) {
			// Only revert/report when nothing newer is queued — a re-flip
			// already owns the knob, and the stale failure's message would
			// flash over the pending choice (coderabbit+cubic, PR #142).
			selected = outcome.selected;
			saveError = outcome.message;
		}
	}

	function onTrackClick(event: MouseEvent) {
		if (dragging || !trackEl) return;
		const rect = trackEl.getBoundingClientRect();
		choose(event.clientX - rect.left < rect.width / 2 ? TONE_LEVEL_OMNI_ONLY : TONE_LEVEL_OMNI_AND_TONE);
	}

	function onTrackKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'End') {
			event.preventDefault();
			choose(TONE_LEVEL_OMNI_AND_TONE);
		} else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown' || event.key === 'Home') {
			event.preventDefault();
			choose(TONE_LEVEL_OMNI_ONLY);
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
		choose(event.clientX - rect.left < rect.width / 2 ? TONE_LEVEL_OMNI_ONLY : TONE_LEVEL_OMNI_AND_TONE);
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
			class:inactive={selectedValue !== TONE_LEVEL_OMNI_ONLY}
			aria-label="Set sensitivity to Edge Lord"
			onclick={() => choose(TONE_LEVEL_OMNI_ONLY)}
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
				role="presentation"
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
			class:inactive={selectedValue !== TONE_LEVEL_OMNI_AND_TONE}
			aria-label="Set sensitivity to Edge Lord plus Ackchyually"
			onclick={() => choose(TONE_LEVEL_OMNI_AND_TONE)}
		>
			<img src="/ackchyually.gif" alt="" width="44" height="44" />
			EDGE LORD + ACKCHYUALLY&hellip;
		</button>
	</div>

	{#key selectedValue}
		<div class="readout">
			<span class="mode-stop mono" class:strict={selectedValue === TONE_LEVEL_OMNI_AND_TONE}>{mode.stop}</span>
			<div class="mode-copy">
				{#if mode.name !== mode.stop}
					<span class="caps-label mode-name">{mode.name}</span>
				{/if}
				<p class="mode-desc">{mode.description}</p>
			</div>
		</div>
	{/key}

	{#if saveError}
		<p class="save-error" role="alert">{saveError} Flip a stop to retry.</p>
	{/if}

	<form
		bind:this={formEl}
		method="POST"
		action="?/setToneLevel"
		use:enhance={() => {
			submitting = true;
			return async ({ result, update }) => {
				// The fresh server level must land BEFORE dirty clears: the settle
				// effect re-syncs `selected` to `level` the moment dirty drops, so
				// clearing it first snaps the knob back to the pre-save stop and it
				// re-flies when the invalidation lands (the left-then-right flicker).
				// reset:false keeps the hidden inputs' serialized values live —
				// reset restores defaultValue, and Svelte only rewrites the property
				// when selectedValue changes, leaving a stale toneLevel behind.
				await update({ reset: false });
				handlePersist(result);
				submitting = false;
			};
		}}
		hidden
	>
		<input type="hidden" name="channelId" value={channelId} />
		<input type="hidden" name="toneLevel" value={selectedValue} />
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
	.save-error {
		margin: 14px 0 0;
		font-size: 13px;
		color: var(--accent);
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
		flex-wrap: wrap;
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
