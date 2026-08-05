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
	let { children, data } = $props();
</script>

<nav class="app-nav" aria-label="App">
	<a class="brand" href="/dashboard">Moderaty</a>
	<a href="/dashboard">Dashboard</a>
	<a href="/org">Team</a>
	<a href="/help">Help</a>
	{#if data.orgs.length > 1}
		<form method="POST" action="/org/switch" class="team-switch">
			<label for="team-select">Team</label>
			<select id="team-select" name="orgId">
				{#each data.orgs as org (org.orgId)}
					<option value={org.orgId} selected={org.orgId === data.user?.orgId}>{org.name}</option>
				{/each}
			</select>
			<button class="btn secondary small" type="submit">Switch team</button>
		</form>
	{/if}
	<span class="account">
		<span class="muted">{data.user?.displayName ?? 'Account'}</span>
		<form method="POST" action="/logout">
			<button class="btn secondary small" type="submit">Sign out</button>
		</form>
	</span>
</nav>
<main class="app-main">{@render children()}</main>

<style>
	.team-switch {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.account {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 10px;
	}
</style>
