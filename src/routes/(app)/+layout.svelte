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
	import { invalidateAll } from '$app/navigation';

	let { children, data } = $props();

	// While the database is unreachable the layout load returns
	// { maintenance: true, orgs: [] } and possibly a null user. Poll gently so
	// the page recovers on its own once the outage clears; the cleanup runs
	// when maintenance flips back to false.
	$effect(() => {
		if (!data.maintenance) return;
		const poll = setInterval(() => invalidateAll(), 30_000);
		return () => clearInterval(poll);
	});
</script>

<nav class="app-nav" aria-label="App">
	<a class="brand" href="/dashboard">Moderaty</a>
	<a href="/dashboard">Dashboard</a>
	<a href="/org">Team</a>
	<a href="/help">Help</a>
	{#if !data.maintenance && data.user}
		<!-- Identity UI is hidden during an outage: the session lookup failed,
			so identity is unknown, and sign-out's write cannot succeed anyway.
			Outside maintenance the load guarantees a non-null user (it redirects
			otherwise); the data.user half of this guard is for the type system. -->
		{#if data.orgs.length > 1}
			<form method="POST" action="/org/switch" class="team-switch">
				<label for="team-select">Team</label>
				<select id="team-select" name="orgId">
					{#each data.orgs as org (org.orgId)}
						<option value={org.orgId} selected={org.orgId === data.user.orgId}>{org.name}</option>
					{/each}
				</select>
				<button class="btn secondary small" type="submit">Switch team</button>
			</form>
		{/if}
		<span class="account">
			<span class="muted">{data.user.displayName}</span>
			<form method="POST" action="/logout">
				<button class="btn secondary small" type="submit">Sign out</button>
			</form>
		</span>
	{/if}
</nav>
{#if data.maintenance}
	<!-- Fifth page state (I12): the outage overlay replaces page content
		entirely. It also covers subpage loads that throw mid-outage — those
		render as children here and are uniformly replaced. -->
	<main class="app-main maintenance" role="alert">
		<div class="maintenance-panel">
			<p class="maintenance-kicker">Maintenance</p>
			<h1>Moderation is paused.</h1>
			<p class="maintenance-desc">
				Moderaty is temporarily unable to reach its database — moderation is paused and
				your settings are safe. The page will work again automatically; nothing is
				required of you.
			</p>
		</div>
	</main>
{:else}
	<main class="app-main">{@render children()}</main>
{/if}

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
	.maintenance {
		display: grid;
		place-items: center;
		min-height: 60vh;
	}
	.maintenance-panel {
		max-width: 520px;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 40px 36px;
		text-align: center;
	}
	.maintenance-kicker {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--brand);
		margin: 0 0 10px;
	}
	.maintenance-panel h1 {
		font-size: 24px;
		margin: 0 0 12px;
	}
	.maintenance-desc {
		color: var(--ink-2);
		font-size: 14px;
		line-height: 1.6;
		margin: 0;
	}
</style>
