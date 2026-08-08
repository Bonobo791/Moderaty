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
	import EmptyState from '$lib/EmptyState.svelte';
	import { autoRefresh } from '$lib/auto-refresh.svelte';

	let { data, form } = $props();

	// Counts change with every cron run; revalidate like the queue and log pages.
	autoRefresh();

	function count(channelId: string, status: string): number {
		const row = data.stats.find((s: any) => s.channelId === channelId && s.status === status);
		return row ? row.n : 0;
	}

	function bans(channelId: string): number {
		return data.bans.find((b: any) => b.channelId === channelId)?.n ?? 0;
	}
</script>

<svelte:head>
	<title>Moderaty — Dashboard</title>
</svelte:head>

{#if data.maintenance}
	<!-- The layout's overlay only triggers on LAYOUT data; when the layout was
	healthy but a dashboard query failed mid-load, the page must render its own
	state instead of an empty shell with destructive controls (I12). -->
	<div class="error-box" role="alert">
		<strong>Maintenance</strong> — Moderaty is temporarily unable to reach its database.
		Nothing on this page will work right now; try again in a minute.
	</div>
{:else}
<h1>Channels</h1>
<p class="page-sub">Connect a channel and track its moderation activity.</p>

<p class="muted" style="font-size:0.9em">
	We've clarified what we retain after account deletion — see the <a href="/privacy">Privacy Policy</a>.
</p>

{#each data.chs as ch}
	{@const pending = count(ch.id, 'pending')}
	{@const banned = bans(ch.id)}
	<div class="card">
		<h2 style="margin-top:0"><a href="/channels/{ch.id}">{ch.title}</a></h2>
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
		<p class="edge-lords">{banned} Edge Lord{banned === 1 ? '' : 's'} Banned</p>
		<a class="btn secondary small" href="/channels/{ch.id}">Overview</a>
		<a class="btn secondary small" href="/channels/{ch.id}/rules">Rules</a>
		<a class="btn secondary small" href="/channels/{ch.id}/queue">Review queue</a>
		<a class="btn secondary small" href="/channels/{ch.id}/log">Audit log</a>
	</div>
{:else}
	<EmptyState
		title="No channels connected"
		hint="Connect your YouTube channels to start moderating comments automatically."
	/>
{/each}

<a class="btn" href="/api/auth/google">Connect YouTube channel</a>

<div class="card danger-zone">
	<h2>Delete account</h2>
	<p class="muted">
		Deleting your account is immediate and permanent. It signs you out everywhere, asks Google to
		revoke Moderaty's access to your YouTube channels (if a revocation fails, you can remove access
		anytime in your
		<a href="https://security.google.com/settings/security/permissions" target="_blank" rel="noreferrer">Google security settings</a>), and erases your channels, rules, and moderation
		records right away — there is no restore window. Only your consent-acceptance records
		(including your e-mail) are retained, as Brazilian law requires: blocked from any other use,
		access-restricted, for up to 10 years.
	</p>
	{#if form?.error}
		<p class="error-box" role="alert">{form.error}</p>
	{/if}
	<form method="POST" action="?/deleteAccount" use:enhance>
		<label class="confirm-delete" for="confirm-delete">
			<input id="confirm-delete" type="checkbox" name="confirm" />
			I understand and want to delete my Moderaty account
		</label>
		<button class="btn danger" type="submit">Delete my account</button>
	</form>
</div>
{/if}

<style>
	.confirm-delete {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		font-size: 0.9rem;
		margin: 12px 0;
	}
	.confirm-delete input {
		margin-top: 3px;
		flex-shrink: 0;
	}
	.edge-lords {
		margin: 10px 0 0;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--danger);
	}
</style>
