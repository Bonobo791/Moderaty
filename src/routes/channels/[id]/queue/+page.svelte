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

	let { data } = $props();
</script>

<svelte:head>
	<title>Moderaty — Review queue</title>
</svelte:head>

<h1>Review queue — {data.ch?.title}</h1>
<p class="page-sub">Borderline comments (AI score 0.35–0.85) waiting for your decision.</p>

{#if data.pending === undefined}
	<Skeleton rows={3} />
{:else}
	<p class="muted">Nothing here is public-facing yet only if previously held; rejected/approved comments already have their final state. Your action is final.</p>

	{#each data.pending as c}
		<div class="card">
			<p style="margin-top:0"><span style="font-weight:600">{c.authorName}</span> <span class="muted">{c.publishedAt}</span></p>
			<blockquote style="margin:8px 0; padding:8px 12px; border-left:3px solid var(--border); color: var(--ink-2)">{c.text}</blockquote>
			<div style="display:flex; gap:8px">
				<form class="inline" method="POST" action="?/approve">
					<input type="hidden" name="commentId" value={c.id} />
					<button class="btn secondary small" aria-label="Approve comment by {c.authorName}">Approve</button>
				</form>
				<form class="inline" method="POST" action="?/reject">
					<input type="hidden" name="commentId" value={c.id} />
					<button class="btn small" aria-label="Reject comment by {c.authorName}">Reject</button>
				</form>
				<form class="inline" method="POST" action="?/del">
					<input type="hidden" name="commentId" value={c.id} />
					<button class="btn danger small" aria-label="Delete comment by {c.authorName}">Delete</button>
				</form>
				<form class="inline" method="POST" action="?/ban">
					<input type="hidden" name="commentId" value={c.id} />
					<button class="btn danger small" aria-label="Ban author {c.authorName}">Ban author</button>
				</form>
			</div>
		</div>
	{:else}
		<EmptyState title="Queue is clear" hint="Borderline comments will appear here for your review." />
	{/each}
{/if}
