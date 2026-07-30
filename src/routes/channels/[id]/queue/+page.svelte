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
</script>

<h1>Review queue — {data.ch?.title}</h1>
<p class="muted">Borderline comments (AI score 0.35–0.85). Nothing here is public-facing yet only if previously held; rejected/approved comments already have their final state. Your action is final.</p>

{#each data.pending as c}
	<div class="card">
		<p style="margin-top:0"><strong>{c.authorName}</strong> <span class="muted">{c.publishedAt}</span></p>
		<p>{c.text}</p>
		<form class="inline" method="POST" action="?/approve">
			<input type="hidden" name="commentId" value={c.id} />
			<button class="btn secondary small">Approve</button>
		</form>
		<form class="inline" method="POST" action="?/reject">
			<input type="hidden" name="commentId" value={c.id} />
			<button class="btn small">Reject</button>
		</form>
		<form class="inline" method="POST" action="?/del">
			<input type="hidden" name="commentId" value={c.id} />
			<button class="btn danger small">Delete</button>
		</form>
		<form class="inline" method="POST" action="?/ban">
			<input type="hidden" name="commentId" value={c.id} />
			<button class="btn danger small">Ban author</button>
		</form>
	</div>
{:else}
	<p class="muted">Queue is empty.</p>
{/each}
