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

	let { data, form } = $props();
</script>

<svelte:head>
	<title>Moderaty — Rules</title>
</svelte:head>

<h1>Rules — {data.ch?.title}</h1>
<p class="page-sub">Keyword, regex, and blocked-user rules that act before AI scoring.</p>

{#if form?.error}<div class="error-box" role="alert">{form.error}</div>{/if}

<div class="card">
	<form method="POST" action="?/add" style="display:flex; gap:8px; flex-wrap:wrap">
		<select name="type" aria-label="Rule type">
			<option value="keyword">keyword</option>
			<option value="regex">regex</option>
			<option value="user">blocked user (channel ID)</option>
		</select>
		<input name="pattern" placeholder="pattern" aria-label="Rule pattern" style="flex:1; min-width:220px" required />
		<select name="action" aria-label="Rule action">
			<option value="hold">hold for review</option>
			<option value="reject">reject (hide)</option>
			<option value="delete">delete permanently</option>
			<option value="ban">reject + ban author</option>
		</select>
		<button class="btn" type="submit">Add rule</button>
	</form>
</div>

{#each data.rs as r}
	<div class="card" style="display:flex; justify-content:space-between; align-items:center">
		<div>
			<span class="badge neutral">{r.type}</span> <code>{r.pattern}</code> → <strong>{r.action}</strong>
		</div>
		<form class="inline" method="POST" action="?/remove">
			<input type="hidden" name="ruleId" value={r.id} />
			<button class="btn danger small" type="submit" aria-label="Delete rule {r.id}">Delete</button>
		</form>
	</div>
{:else}
	<EmptyState
		title="No rules yet"
		hint="AI moderation still applies to every comment — rules add your own keywords, patterns, and blocked users."
	/>
{/each}

<h2>Protected handles</h2>
<p class="page-sub">Comments from these handles are always approved — they skip rules and AI scanning.</p>
<p class="page-sub">{data.handles.length}/100 protected handles</p>

<div class="card">
	<form method="POST" action="?/addHandle" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
		<label for="new-handle">Handle</label>
		<input
			id="new-handle"
			name="handle"
			placeholder="@handle"
			aria-label="Protected handle"
			style="flex:1; min-width:220px"
			required
		/>
		<button class="btn" type="submit">Add handle</button>
	</form>
</div>

{#each data.handles as h}
	<div class="card" style="display:flex; justify-content:space-between; align-items:center">
		<div><code>@{h.handle}</code></div>
		<form class="inline" method="POST" action="?/removeHandle">
			<input type="hidden" name="handleId" value={h.id} />
			<button class="btn danger small" type="submit" aria-label="Remove protected handle {h.handle}">Remove</button>
		</form>
	</div>
{:else}
	<EmptyState
		title="No protected handles"
		hint="Add a handle whose comments should always be approved, skipping rules and AI scanning."
	/>
{/each}
