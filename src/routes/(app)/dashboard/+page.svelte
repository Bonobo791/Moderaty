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
	import { relativeTime } from '$lib/relative-time';

	let { data } = $props();
	function count(channelId: string, status: string): number {
		const row = data.stats.find((s: any) => s.channelId === channelId && s.status === status);
		return row ? row.n : 0;
	}
</script>

<svelte:head>
	<title>Moderaty — Dashboard</title>
</svelte:head>

<h1>Channels</h1>
<p class="page-sub">Connect a channel and track its moderation activity.</p>

{#each data.chs as ch}
	{@const pending = count(ch.id, 'pending')}
	<div class="card">
		<h2 style="margin-top:0">{ch.title}</h2>
		<p style="margin-top:0">
			protected —
			{#if pending > 0}
				<a style="color: var(--danger); font-weight: 600" href="/channels/{ch.id}/queue">{pending} comment{pending === 1 ? '' : 's'} waiting for review</a>
			{:else}
				queue is clear
			{/if}
		</p>
		<ul class="stats">
			<li><span class="badge attention">pending: {pending}</span></li>
			<li><span class="badge neutral">rejected: {count(ch.id, 'rejected')}</span></li>
			<li><span class="badge neutral">deleted: {count(ch.id, 'deleted')}</span></li>
			<li><span class="badge ok">approved: {count(ch.id, 'approved')}</span></li>
		</ul>
		<a class="btn secondary small" href="/channels/{ch.id}/rules">Rules</a>
		<a class="btn secondary small" href="/channels/{ch.id}/queue">Review queue</a>
		<a class="btn secondary small" href="/channels/{ch.id}/log">Audit log</a>
		<p class="muted" style="margin:12px 0 0">
			last checked {ch.cursor ? relativeTime(ch.cursor) : 'never'} · ID: {ch.id}
		</p>
	</div>
{:else}
	<EmptyState
		title="No channels connected"
		hint="Connect your YouTube channel to start moderating comments automatically."
	/>
{/each}

<a class="btn" href="/api/auth/google">Connect YouTube channel</a>
