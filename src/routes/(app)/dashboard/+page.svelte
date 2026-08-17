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

<!-- Dashboard: aggregate door-status header + channel ledger (redesign
	 spec §7 Phase 2). All counters are computed client-side from the
	 existing load payload (data.stats / data.bans — spec §6.3, no backend
	 change). The per-channel controls live on the channel detail page;
	 ledger rows navigate there. -->

<script lang="ts">
	import { goto } from '$app/navigation';
	import EmptyState from '$lib/EmptyState.svelte';
	import Ticker from '$lib/Ticker.svelte';
	import { autoRefresh } from '$lib/auto-refresh.svelte';
	import { relativeTime } from '$lib/relative-time';

	let { data } = $props();

	// Counts change with every cron run; revalidate like the queue and log pages.
	autoRefresh();

	function count(channelId: string, status: string): number {
		const row = data.stats.find((s: any) => s.channelId === channelId && s.status === status);
		return row ? row.n : 0;
	}

	// Aggregate door-status counters: plain sums across every channel (§6.3).
	function sum(status: string): number {
		return data.stats.reduce(
			(total: number, s: any) => total + (s.status === status ? s.n : 0),
			0
		);
	}
	const pendingSum = $derived(sum('pending'));
	const rejectedSum = $derived(sum('rejected'));
	const approvedSum = $derived(sum('approved'));
	const bannedSum = $derived(
		data.bans.reduce((total: number, b: any) => total + b.n, 0)
	);

	function openChannel(channelId: string) {
		goto(`/channels/${channelId}`);
	}

	function onRowKeydown(event: KeyboardEvent, channelId: string) {
		if (event.key === 'Enter') openChannel(channelId);
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
<section class="door-status" aria-labelledby="door-status-label">
	<span class="caps-label" id="door-status-label">Door status</span>
	{#if pendingSum > 0}
		<h1 class="door-headline">{pendingSum} caught lacking at the door.</h1>
		<p class="door-subline">
			{pendingSum} comments are waiting for a decision. The rope isn't going to check itself.
		</p>
	{:else}
		<h1 class="door-headline">The door is quiet. Too quiet.</h1>
		<p class="door-subline">
			{data.chs.length} channels protected. Queue's clear. Not a single main character slipped past.
		</p>
	{/if}
	<div class="door-stats">
		<div class="stat">
			<span class="stat-value" class:accent={pendingSum > 0}><Ticker value={pendingSum} /></span>
			<span class="caps-label">Pending</span>
		</div>
		<div class="stat">
			<span class="stat-value"><Ticker value={rejectedSum} /></span>
			<span class="caps-label">Rejected</span>
		</div>
		<div class="stat">
			<span class="stat-value ok"><Ticker value={approvedSum} /></span>
			<span class="caps-label">Approved</span>
		</div>
		<div class="stat">
			<span class="stat-value accent"><Ticker value={bannedSum} /></span>
			<span class="caps-label">Edge lords banned</span>
		</div>
	</div>
</section>

<section class="ledger" aria-labelledby="ledger-label">
	<div class="ledger-head">
		<h2 id="ledger-label">Channels</h2>
		<span class="caps-label">{data.chs.length} connected</span>
	</div>
	{#if data.chs.length === 0}
		<EmptyState
			title="No channels connected"
			hint="Connect your YouTube channels and start yeeting edge lords."
		/>
	{:else}
		<table class="ledger-table">
			<thead>
				<tr>
					<th>Channel</th>
					<th>Status</th>
					<th class="num">Pending</th>
					<th class="num col-rejected">Rejected</th>
					<th class="num col-approved">Approved</th>
					<th class="col-sensitivity">Sensitivity</th>
					<th class="col-last">Last checked</th>
				</tr>
			</thead>
			<tbody>
				{#each data.chs as ch (ch.id)}
					{@const pending = count(ch.id, 'pending')}
					{@const strict = ch.toneLevel === 2}
					<!-- The row itself is a keyboard-focusable link (Enter navigates);
						the name cell keeps a real anchor for href semantics. -->
					<tr
						class="ledger-row"
						role="link"
						tabindex="0"
						aria-label="Open {ch.title}"
						onclick={() => openChannel(ch.id)}
						onkeydown={(event) => onRowKeydown(event, ch.id)}
					>
						<td>
							<a class="channel-name" href="/channels/{ch.id}">{ch.title}</a>
							<span class="mono channel-id col-id">ID: {ch.id}</span>
						</td>
						<td>
							<span class="caps-label protected-label">Protected</span>
							{#if pending > 0}
								<a class="status-sub pending-link" href="/channels/{ch.id}/queue">
									{pending} comment{pending === 1 ? '' : 's'} waiting for review
								</a>
							{:else}
								<span class="status-sub">queue is clear</span>
							{/if}
						</td>
						<td class="mono num">{pending}</td>
						<td class="mono num col-rejected">{count(ch.id, 'rejected')}</td>
						<td class="mono num col-approved">{count(ch.id, 'approved')}</td>
						<td class="col-sensitivity">
							<div class="mini-track">
								<span class="mini-rail"></span>
								<span class="mini-fill" class:strict></span>
								<span class="mini-tick" class:strict></span>
							</div>
							<span class="caps-label mini-label">{strict ? 'Ackchyually' : 'Edge Lord'}</span>
						</td>
						<td class="mono col-last">
							{ch.lastRunAt ? relativeTime(ch.lastRunAt) : 'never'}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<div class="connect-block">
	<a class="btn" href="/api/auth/google">Connect YouTube channel</a>
	<p class="connect-helper">Google sign-in required. Access is revocable anytime.</p>
</div>

<p class="muted privacy-note">
	We've clarified what we retain after account deletion — see the <a href="/privacy">Privacy Policy</a>.
</p>
{/if}

<style>
	/* ── door status (spec §7 Step 2.1) ─────────────────────── */
	.door-status {
		margin-bottom: 48px;
	}
	.door-headline {
		font-size: 44px;
		font-weight: 600;
		line-height: 1.05;
		margin: 14px 0 10px;
	}
	.door-subline {
		margin: 0 0 32px;
		font-size: 14px;
		color: var(--text-2);
	}
	.door-stats {
		display: flex;
		gap: 48px;
		flex-wrap: wrap;
	}
	.stat {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.stat-value {
		font-size: 32px;
		line-height: 1;
	}
	.stat-value.accent {
		color: var(--accent);
	}
	.stat-value.ok {
		color: var(--ok);
	}

	/* ── ledger (spec §7 Step 2.2) ──────────────────────────── */
	.ledger {
		margin-bottom: 40px;
	}
	.ledger-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 16px;
		margin-bottom: 16px;
	}
	.ledger-head h2 {
		margin: 0;
		font-size: 22px;
		font-weight: 600;
	}
	.ledger-table {
		width: 100%;
		border-collapse: collapse;
	}
	.ledger-table th {
		text-align: left;
		font-size: 11px;
		font-weight: 500;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-3);
		padding: 0 20px 12px 0;
		border-bottom: 1px solid var(--line);
	}
	.ledger-table td {
		padding: 16px 20px 16px 0;
		border-bottom: 1px solid var(--line);
		vertical-align: middle;
	}
	.ledger-row {
		cursor: pointer;
		transition: background 150ms var(--ease-out);
	}
	.ledger-row:hover {
		background: var(--surface);
	}
	.ledger-row:focus-visible {
		outline: 1px solid var(--accent);
		outline-offset: -1px;
	}
	.channel-name {
		display: block;
		font-weight: 600;
		color: var(--text);
		text-decoration: none;
	}
	.channel-name:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.channel-id {
		display: block;
		margin-top: 4px;
		font-size: 12px;
		color: var(--text-3);
	}
	.protected-label {
		color: var(--ok);
	}
	.status-sub {
		display: block;
		margin-top: 4px;
		font-size: 13px;
		color: var(--text-2);
	}
	.pending-link {
		color: var(--accent);
	}
	.num {
		text-align: left;
	}

	/* sensitivity mini-track: 64px, 3px rail, accent fill at the
	   Strict stop, 2px white tick at the active end (spec §7) */
	.mini-track {
		position: relative;
		width: 64px;
		height: 12px;
		margin-bottom: 6px;
	}
	.mini-rail {
		position: absolute;
		left: 0;
		right: 0;
		top: 50%;
		height: 3px;
		transform: translateY(-50%);
		background: var(--line);
	}
	.mini-fill {
		position: absolute;
		left: 0;
		top: 50%;
		width: 0;
		height: 3px;
		transform: translateY(-50%);
		background: var(--accent);
	}
	.mini-fill.strict {
		width: 100%;
	}
	.mini-tick {
		position: absolute;
		left: 0;
		top: 50%;
		width: 2px;
		height: 12px;
		transform: translateY(-50%);
		background: var(--text);
	}
	.mini-tick.strict {
		left: auto;
		right: 0;
	}

	/* responsive column collapse (spec §7): display:none, no width tricks */
	@media (max-width: 767px) {
		.col-id,
		.col-rejected,
		.col-sensitivity,
		.col-last {
			display: none;
		}
	}
	@media (max-width: 639px) {
		.col-approved {
			display: none;
		}
	}

	/* ── connect + privacy note ─────────────────────────────── */
	.connect-block {
		margin-bottom: 12px;
	}
	.connect-helper {
		margin: 10px 0 0;
		font-size: 13px;
		color: var(--text-2);
	}
	.privacy-note {
		font-size: 0.9em;
	}

	@media (prefers-reduced-motion: reduce) {
		.ledger-row {
			transition: none;
		}
	}
</style>
