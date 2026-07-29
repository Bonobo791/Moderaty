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
	let { data, form } = $props();
</script>

<h1>Rules — {data.ch?.title}</h1>

<div class="card">
	<form method="POST" action="?/add" style="display:flex; gap:8px; flex-wrap:wrap">
		<select name="type">
			<option value="keyword">keyword</option>
			<option value="regex">regex</option>
			<option value="user">blocked user (channel ID)</option>
		</select>
		<input name="pattern" placeholder="pattern" style="flex:1; min-width:220px" required />
		<select name="action">
			<option value="hold">hold for review</option>
			<option value="reject">reject (hide)</option>
			<option value="delete">delete permanently</option>
			<option value="ban">reject + ban author</option>
		</select>
		<button class="btn" type="submit">Add rule</button>
	</form>
	{#if form?.error}<p style="color:#b3261e">{form.error}</p>{/if}
</div>

{#each data.rs as r}
	<div class="card" style="display:flex; justify-content:space-between; align-items:center">
		<div>
			<span class="badge">{r.type}</span> <code>{r.pattern}</code> → <strong>{r.action}</strong>
		</div>
		<form class="inline" method="POST" action="?/remove">
			<input type="hidden" name="ruleId" value={r.id} />
			<button class="btn danger small" type="submit">Delete</button>
		</form>
	</div>
{:else}
	<p class="muted">No rules yet. AI moderation still applies to all comments.</p>
{/each}
