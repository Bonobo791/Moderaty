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

<!-- Accessible heading only: the shared channel header (h1) and the active
	 tab already identify this section visually. -->
<h2 class="sr-only">Audit log</h2>
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
				<tr><th>Time</th><th>Action</th><th>Comment</th><th>Handle</th><th>Reason</th><th>Actor</th><th>Undo</th></tr>
			</thead>
			<tbody>
				{#each data.entries as e}
					<tr>
						<td class="muted" data-label="Time" title={e.createdAt}>{relativeTime(e.createdAt)}</td>
						<td data-label="Action"><span class={badgeClass(e.action)}>{e.action}</span></td>
						<td class="muted" data-label="Comment">
							{#if e.text}
								{e.text}
								<br /><small>{e.commentId}</small>
							{:else}
								{e.commentId}
							{/if}
						</td>
						<td class="muted" data-label="Handle">{e.authorHandle ?? '—'}</td>
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
	{#if data.hasPrev || data.nextCursor}
		<nav class="pager" aria-label="Audit log pages">
			{#if data.hasPrev}
				<a class="btn secondary small" href="/channels/{data.ch.id}/log">← Newest</a>
			{/if}
			{#if data.nextCursor}
				<a class="btn secondary small" href="/channels/{data.ch.id}/log?before={encodeURIComponent(data.nextCursor)}">Older →</a>
			{/if}
		</nav>
	{/if}
{/if}

<div class="card danger-zone">
	<h2>Erase stored commenter handles</h2>
	<p class="muted">
		Commenter handles in this log are kept for 30 days, then erased automatically. Erase them all now.
	</p>
	<form method="POST" action="?/eraseHandles">
		<button
			class="btn danger small"
			type="submit"
			aria-label="Erase all stored commenter handles for this channel now">Erase handles now</button>
	</form>
</div>
