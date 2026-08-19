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
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';

	let { children, data } = $props();

	// Active nav underline (redesign Commit 5): the link matching the current
	// pathname gets the 2px --accent underline + aria-current="page".
	const path = $derived(page.url.pathname);

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
	<a href="/dashboard" class:active={path === '/dashboard'} aria-current={path === '/dashboard' ? 'page' : undefined}>Dashboard</a>
	<a
		href="/usage"
		class:active={path === '/usage' || path.startsWith('/usage/')}
		aria-current={path === '/usage' || path.startsWith('/usage/') ? 'page' : undefined}
	>Usage</a>
	<a href="/org" class:active={path === '/org'} aria-current={path === '/org' ? 'page' : undefined}>Team</a>
	<a href="/help" class:active={path === '/help'} aria-current={path === '/help' ? 'page' : undefined}>Help</a>
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
			<a
				class="account-link"
				href="/account"
				class:active={path === '/account'}
				aria-current={path === '/account' ? 'page' : undefined}>{data.user.displayName}</a
			>
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
	<!-- Route transition (redesign spec §Phase 6): every pathname change
		remounts main with a 200ms fade/rise; reduced-motion kills it in
		app.css. -->
	{#key path}
		<main class="app-main route-enter">{@render children()}</main>
	{/key}
{/if}

<style>
	.app-nav a {
		border-bottom: 2px solid transparent;
		padding-bottom: 2px;
		transition:
			color 150ms var(--ease-out),
			border-color 150ms var(--ease-out);
	}
	.app-nav a.active {
		color: var(--paper);
		border-bottom-color: var(--accent);
	}
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
	.route-enter {
		animation: route-in 200ms var(--ease-out);
	}
	@media (prefers-reduced-motion: reduce) {
		.route-enter {
			animation: none;
		}
	}
	@keyframes route-in {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
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
