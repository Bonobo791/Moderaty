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

<script lang="ts">
	import EmptyState from '$lib/EmptyState.svelte';
	import Skeleton from '$lib/Skeleton.svelte';
	import { autoRefresh } from '$lib/auto-refresh.svelte';
	import { relativeTime } from '$lib/relative-time';

	let { data, form } = $props();
	let confirming = $state<{ id: string; author: string; kind: 'delete' | 'ban' } | null>(null);

	autoRefresh();
</script>

<svelte:head>
	<title>Moderaty — Review queue</title>
</svelte:head>

<h1>Review queue — {data.ch?.title}</h1>
<p class="page-sub">Borderline comments (AI score 0.35–0.85) waiting for your decision.</p>

{#if data.pending === undefined}
	<Skeleton rows={3} />
{:else}
	{#if form?.error}<div class="error-box" role="alert">{form.error}</div>{/if}
	{#if form?.success}<div class="flash" role="status">{form.success}</div>{/if}

	<p class="muted">These comments are held for review and are not public yet. Rejected or approved comments already have a final state. Your action is final.</p>

	{#each data.pending as c}
		<div class="card">
			<p style="margin-top:0"><span style="font-weight:600">{c.authorName}</span> <span class="muted" title={c.publishedAt}>{relativeTime(c.publishedAt)}</span></p>
			<blockquote class="quote">{c.text}</blockquote>
			{#if confirming?.id === c.id}
				<p style="margin:0 0 8px">
					{#if confirming.kind === 'delete'}
						Delete this comment by {confirming.author}? This can't be undone.
					{:else}
						Ban {confirming.author}? Their comments will be rejected and they'll be blocked.
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
				<div style="display:flex; gap:8px">
					<form class="inline" method="POST" action="?/approve">
						<input type="hidden" name="commentId" value={c.id} />
						<button class="btn secondary small" aria-label="Approve comment by {c.authorName}">Approve</button>
					</form>
					<form class="inline" method="POST" action="?/reject">
						<input type="hidden" name="commentId" value={c.id} />
						<button class="btn secondary small" aria-label="Reject comment by {c.authorName}">Reject</button>
					</form>
					<button
						class="btn danger small"
						type="button"
						aria-label="Delete comment by {c.authorName}"
						onclick={() => (confirming = { id: c.id, author: c.authorName, kind: 'delete' })}
					>Delete</button>
					<button
						class="btn danger small"
						type="button"
						aria-label="Ban author {c.authorName}"
						onclick={() => (confirming = { id: c.id, author: c.authorName, kind: 'ban' })}
					>Ban author</button>
				</div>
			{/if}
		</div>
	{:else}
		<EmptyState title="Queue is clear" hint="Borderline comments will appear here for your review." />
	{/each}
{/if}
