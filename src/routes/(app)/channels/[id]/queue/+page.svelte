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

<!-- Review queue (redesign spec Phase 4): Approve/Reject are underlined
	 .row-action text actions with an optimistic use:enhance flow — 200ms
	 decision flash → the EXISTING form action fires (server untouched) →
	 the row collapses over 220ms → the row drops out of the single
	 queue-list state every visible pending count derives from. Failure
	 restores the row loudly. Delete/Ban keep the plain inline-confirm flow. -->

<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import Skeleton from '$lib/Skeleton.svelte';
	import { autoRefresh } from '$lib/auto-refresh.svelte';
	import { relativeTime } from '$lib/relative-time';

	let { data, form } = $props();
	let confirming = $state<{ id: string; kind: 'delete' | 'ban' } | null>(null);

	// Author identifiers are never stored from fetched comments, so buttons
	// name their target with a short text preview instead of the (unknown)
	// author name (I13).
	const preview = (text: string) => (text.length > 40 ? `${text.slice(0, 40)}…` : text);

	autoRefresh();

	// Auto-refresh can drop a comment from the queue while its confirmation
	// dialog is open; close the dialog rather than act on a stale target.
	$effect(() => {
		if (confirming && !data.pending?.some((c) => c.id === confirming?.id)) confirming = null;
	});

	// Optimistic decision state, keyed by comment id: the rendered list is
	// the server list viewed through these flags, so a mid-flight
	// invalidateAll (autoRefresh ticks every 15s) re-renders the same keyed
	// rows — never duplicates — and on failure the flags are cleared so the
	// server row reappears (server state wins).
	const FLASH_MS = 200;
	const EXIT_MS = 220;
	let flash = $state<Record<string, 'approve' | 'reject'>>({});
	let exiting = $state<Record<string, true>>({});
	let gone = $state<Record<string, true>>({});
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	// Single source of truth for the visible queue: the server list minus
	// settled removals. The layout tab-label count follows via revalidation.
	const visible = $derived((data.pending ?? []).filter((c) => !gone[c.id]));

	function clearDecision(id: string) {
		clearTimeout(timers.get(id));
		timers.delete(id);
		delete flash[id];
		delete exiting[id];
		delete gone[id];
	}

	function decide(id: string, kind: 'approve' | 'reject'): SubmitFunction {
		return () => {
			clearDecision(id);
			flash[id] = kind;
			const startedAt = Date.now();
			timers.set(
				id,
				setTimeout(() => {
					exiting[id] = true;
				}, FLASH_MS)
			);
			return async ({ result, update }) => {
				if (result.type === 'success') {
					// Let the full flash → collapse sequence play before the row
					// drops out of the list (fast local actions answer mid-flash).
					exiting[id] = true;
					const remaining = Math.max(0, FLASH_MS + EXIT_MS - (Date.now() - startedAt));
					timers.set(
						id,
						setTimeout(() => {
							gone[id] = true;
						}, remaining)
					);
				} else {
					// Loud restore: clear the optimistic flags so the row returns,
					// then update() surfaces the action's failure in the error-box.
					clearDecision(id);
				}
				await update();
			};
		};
	}
</script>

<svelte:head>
	<title>Moderaty — Review queue</title>
</svelte:head>

<!-- Accessible heading only: the shared channel header (h1) and the active
	 tab already identify this section visually. -->
<h2 class="sr-only">Review queue</h2>
<p class="page-sub">Borderline comments (AI score 0.51–0.75, or AI unavailable) waiting for your decision.</p>

{#if data.pending === undefined}
	<Skeleton rows={3} />
{:else}
	{#if form?.error}<div class="error-box" role="alert">{form.error}</div>{/if}
	{#if form?.success}<div class="flash" role="status">{form.success}</div>{/if}

	<p class="muted">These comments are held for review and are not public yet. Rejected or approved comments already have a final state. Your action is final.</p>

	{#each visible as c (c.id)}
		<div class="row-wrap" class:exiting={exiting[c.id]}>
			<div class="row-inner">
				<div
					class="queue-row"
					class:flash-approve={flash[c.id] === 'approve'}
					class:flash-reject={flash[c.id] === 'reject'}
				>
					<p class="row-time muted" title={c.publishedAt}>{relativeTime(c.publishedAt)}</p>
					<blockquote class="quote">{c.text}</blockquote>
					{#if confirming?.id === c.id}
						<p style="margin:0 0 8px">
							{#if confirming.kind === 'delete'}
								Delete this comment? This can't be undone.
							{:else}
								Ban this comment's author? Their comments will be rejected and they'll be blocked.
							{/if}
						</p>
						<div style="display:flex; gap:8px">
							<form class="inline" method="POST" action={confirming.kind === 'delete' ? '?/del' : '?/ban'}>
								<input type="hidden" name="commentId" value={c.id} />
								<button class="btn danger small">
									Yes, {confirming.kind === 'delete' ? 'delete it' : 'ban them'}
								</button>
							</form>
							<button class="btn secondary small" type="button" onclick={() => (confirming = null)}>Cancel</button>
						</div>
					{:else}
						<div class="row-actions">
							<form class="inline" method="POST" action="?/approve" use:enhance={decide(c.id, 'approve')}>
								<input type="hidden" name="commentId" value={c.id} />
								<button
									class="row-action approve"
									disabled={!!flash[c.id] || !!exiting[c.id]}
									aria-label="Approve comment: {preview(c.text)}">Approve</button
								>
							</form>
							<form class="inline" method="POST" action="?/reject" use:enhance={decide(c.id, 'reject')}>
								<input type="hidden" name="commentId" value={c.id} />
								<button
									class="row-action reject"
									disabled={!!flash[c.id] || !!exiting[c.id]}
									aria-label="Reject comment: {preview(c.text)}">Reject</button
								>
							</form>
							<button
								class="btn danger small"
								type="button"
								aria-label="Delete comment: {preview(c.text)}"
								onclick={() => (confirming = { id: c.id, kind: 'delete' })}
							>Delete</button>
							<button
								class="btn danger small"
								type="button"
								aria-label="Ban author of comment: {preview(c.text)}"
								onclick={() => (confirming = { id: c.id, kind: 'ban' })}
							>Ban author</button>
						</div>
					{/if}
				</div>
			</div>
		</div>
	{:else}
		<p class="queue-empty">Queue is clear. The rope holds.</p>
	{/each}
{/if}

<style>
	/* Row exit: grid-rows 1fr → 0fr animates height without measuring;
	   opacity rides along (220ms --ease-out, spec §7). */
	.row-wrap {
		display: grid;
		grid-template-rows: 1fr;
		transition:
			grid-template-rows 220ms var(--ease-out),
			opacity 220ms var(--ease-out);
	}
	.row-wrap.exiting {
		grid-template-rows: 0fr;
		opacity: 0;
	}
	.row-inner {
		overflow: hidden;
		min-height: 0;
	}
	.queue-row {
		padding: 20px 4px;
		border-bottom: 1px solid var(--line);
		transition: background-color 200ms var(--ease-out);
	}
	.queue-row.flash-approve {
		background-color: rgba(61, 220, 132, 0.12);
	}
	.queue-row.flash-reject {
		background-color: rgba(255, 49, 49, 0.12);
	}
	.row-time {
		margin: 0 0 8px;
	}
	.row-actions {
		display: flex;
		gap: 20px;
		align-items: center;
	}
	/* .row-action (app.css) owns the underlined-caps look; the button reset
	   and the decision colors are queue-local. */
	button.row-action {
		background: none;
		border: 0;
		padding: 0;
		font-family: inherit;
		color: var(--text);
	}
	button.row-action.approve {
		color: var(--ok);
	}
	button.row-action.reject {
		color: var(--accent);
	}
	button.row-action:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.queue-empty {
		margin: 0;
		padding: 48px 0;
		font-size: 14px;
		color: var(--text-2);
	}

	@media (prefers-reduced-motion: reduce) {
		.row-wrap,
		.queue-row {
			transition: none;
		}
	}
</style>
