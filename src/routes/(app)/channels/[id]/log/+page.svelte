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
	import { autoRefresh } from '$lib/auto-refresh.svelte';
	import { relativeTime } from '$lib/relative-time';

	let { data, form } = $props();

	autoRefresh();

	function badgeClass(action: string): string {
		if (action === 'approve' || action === 'approved' || action === 'restore') return 'badge ok';
		if (action === 'queue' || action === 'pending') return 'badge attention';
		if (action === 'dry-run') return 'badge neutral';
		if (['rejected', 'deleted', 'reject', 'delete', 'ban'].includes(action))
			return 'badge danger';
		return 'badge neutral';
	}
</script>

<svelte:head>
	<title>Moderaty — Audit log</title>
</svelte:head>

<h1>Audit log — {data.ch?.title}</h1>
<p class="page-sub">
	Every moderation action, automatic or manual, newest first. Held and rejected comments can be
	restored here; deletions and author bans are permanent.
</p>

{#if form?.error}
	<p class="error-box" role="alert">{form.error}</p>
{/if}
{#if form?.success}
	<p class="flash" role="status">{form.success}</p>
{/if}

{#if data.entries.length === 0}
	<EmptyState
		title="No activity yet"
		hint="Every moderation action — automatic or manual — is recorded here."
	/>
{:else}
	<div class="card">
		<table class="stack-table">
			<thead>
				<tr><th>Time</th><th>Action</th><th>Comment</th><th>Reason</th><th>Actor</th><th>Undo</th></tr>
			</thead>
			<tbody>
				{#each data.entries as e}
					<tr>
						<td class="muted" data-label="Time" title={e.createdAt}>{relativeTime(e.createdAt)}</td>
						<td data-label="Action"><span class={badgeClass(e.action)}>{e.action}</span></td>
						<td class="muted" data-label="Comment">{e.commentId}</td>
						<td data-label="Reason">{e.reason}</td>
						<td class="muted" data-label="Actor">{e.actor}</td>
						<td data-label="Undo">
							{#if e.undoable === 'full'}
								<form method="POST" action="?/undo">
									<input type="hidden" name="commentId" value={e.commentId} />
									<button class="btn secondary small" type="submit" aria-label="Undo {e.action} on comment {e.commentId}">Undo</button>
								</form>
							{:else if e.undoable === 'comment-only'}
								<form method="POST" action="?/undo" title="Restores the comment — the author ban cannot be lifted via the YouTube API">
									<input type="hidden" name="commentId" value={e.commentId} />
									<button class="btn secondary small" type="submit" aria-label="Restore comment {e.commentId} (author ban stays)">Undo comment</button>
								</form>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
