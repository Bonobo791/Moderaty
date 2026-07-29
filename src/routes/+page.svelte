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
	let { data } = $props();
	function count(channelId: string, status: string): number {
		const row = data.stats.find((s: any) => s.channelId === channelId && s.status === status);
		return row ? row.n : 0;
	}
</script>

<h1>Channels</h1>
<a class="btn" href="/api/auth/google">Connect YouTube channel</a>

{#each data.chs as ch}
	<div class="card">
		<h2 style="margin-top:0">{ch.title}</h2>
		<p class="muted">ID: {ch.id} · last polled up to: {ch.cursor ?? 'never'}</p>
		<p>
			<span class="badge">pending: {count(ch.id, 'pending')}</span>
			<span class="badge">rejected: {count(ch.id, 'rejected')}</span>
			<span class="badge">deleted: {count(ch.id, 'deleted')}</span>
			<span class="badge">approved: {count(ch.id, 'approved')}</span>
		</p>
		<a class="btn secondary small" href="/channels/{ch.id}/rules">Rules</a>
		<a class="btn secondary small" href="/channels/{ch.id}/queue">Review queue</a>
		<a class="btn secondary small" href="/channels/{ch.id}/log">Audit log</a>
	</div>
{:else}
	<p class="muted" style="margin-top:16px">No channels connected yet.</p>
{/each}
