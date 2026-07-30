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

	let { data } = $props();

	function badgeClass(action: string): string {
		if (action === 'approve' || action === 'approved') return 'badge ok';
		if (action === 'queue' || action === 'pending') return 'badge';
		if (['rejected', 'deleted', 'reject', 'delete', 'ban', 'dry-run'].includes(action))
			return 'badge danger';
		return 'badge neutral';
	}
</script>

<svelte:head>
	<title>Moderaty — Audit log</title>
</svelte:head>

<h1>Audit log — {data.ch?.title}</h1>
<p class="page-sub">Every moderation action, automatic or manual, newest first.</p>

{#if data.entries.length === 0}
	<EmptyState
		title="No activity yet"
		hint="Every moderation action — automatic or manual — is recorded here."
	/>
{:else}
	<div class="card">
		<table>
			<caption class="muted" style="text-align:left; padding-bottom:8px">Latest moderation actions</caption>
			<thead>
				<tr><th>Time</th><th>Action</th><th>Comment</th><th>Reason</th><th>Actor</th></tr>
			</thead>
			<tbody>
				{#each data.entries as e}
					<tr>
						<td class="muted">{e.createdAt}</td>
						<td><span class={badgeClass(e.action)}>{e.action}</span></td>
						<td class="muted">{e.commentId}</td>
						<td>{e.reason}</td>
						<td class="muted">{e.actor}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
