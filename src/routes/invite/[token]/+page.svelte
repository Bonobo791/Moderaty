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
	import { enhance } from '$app/forms';

	let { data } = $props();
</script>

<svelte:head>
	<title>Moderaty — Team invite</title>
</svelte:head>

<h1>Team invite</h1>

{#if data.invite.expired || data.invite.accepted}
	<p class="error-box" role="alert">This invite link is no longer valid — ask for a new one.</p>
{:else if !data.signedIn}
	<div class="card">
		<p>
			You've been invited to join <strong>{data.invite.orgName}</strong> as
			<span class="badge neutral">{data.invite.role}</span>. Sign in with Google, then reopen this link to
			join.
		</p>
		<a class="btn" href="/login">Sign in with Google</a>
	</div>
{:else}
	<div class="card">
		<p>
			You've been invited to join <strong>{data.invite.orgName}</strong> as
			<span class="badge neutral">{data.invite.role}</span>.
		</p>
		<form method="POST" use:enhance>
			<button class="btn" type="submit">Join {data.invite.orgName}</button>
		</form>
	</div>
{/if}
