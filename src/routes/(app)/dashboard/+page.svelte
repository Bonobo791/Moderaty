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
	import { relativeTime } from '$lib/relative-time';

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

<h1>Channels</h1>
<p class="page-sub">Connect a channel and track its moderation activity.</p>

<p class="muted" style="font-size:0.9em">
	We've clarified what we retain after account deletion — see the <a href="/privacy">Privacy Policy</a>.
</p>

{#each data.chs as ch}
	{@const pending = count(ch.id, 'pending')}
	{@const level = ch.toneLevel ?? 1}
	{@const banned = bans(ch.id)}
	<div class="card">
		<h2 style="margin-top:0">{ch.title}</h2>
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
		<form class="sensitivity" method="POST" action="?/setToneLevel" use:enhance>
			<input type="hidden" name="channelId" value={ch.id} />
			<label class="sensitivity-title" for="tone-{ch.id}">Moderation sensitivity</label>
			<input
				id="tone-{ch.id}"
				type="range"
				name="toneLevel"
				min="1"
				max="2"
				step="1"
				value={level}
				aria-label="Moderation sensitivity for {ch.title}"
				onchange={(event) => event.currentTarget.form?.requestSubmit()}
			/>
			<div class="sensitivity-options">
				<span class="banner" class:chosen={level === 1}>
					<img src="/edge-lord.jpg" alt="Smug Pepe, the Edge Lord" width="44" height="44" />
					EDGE LORD
				</span>
				<span class="banner" class:chosen={level === 2}>
					<img src="/ackchyually.gif" alt="The Ackchyually meme guy" width="44" height="44" />
					EDGE LORD + ACKCHYUALLY&hellip;
				</span>
			</div>
			<p class="muted" style="margin:6px 0 0">
				{level === 2
					? 'Hateful comments and demeaning, condescending, or sarcastic tone are moderated.'
					: 'Only hateful and abusive comments are moderated.'}
			</p>
		</form>
		<a class="btn secondary small" href="/channels/{ch.id}/rules">Rules</a>
		<a class="btn secondary small" href="/channels/{ch.id}/queue">Review queue</a>
		<a class="btn secondary small" href="/channels/{ch.id}/log">Audit log</a>
		<form method="POST" action="?/analyzeHistory" class="history-form">
			<input type="hidden" name="channelId" value={ch.id} />
			<label for="history-months-{ch.id}">Analyze history</label>
			<select id="history-months-{ch.id}" name="months" aria-label="How far back to analyze comments on {ch.title}">
				<option value="1">last month</option>
				<option value="3" selected>last 3 months</option>
				<option value="6">last 6 months</option>
				<option value="12">last 12 months</option>
				<option value="24">last 24 months</option>
			</select>
			<button class="btn secondary small" type="submit">Analyze history on {ch.title}</button>
		</form>
		{#if form?.scope === 'history' && form?.channelId === ch.id}
			{#if form?.error}
				<p class="error-box" role="alert">{form.error}</p>
			{:else if form?.ok}
				<p class="muted" role="status">
					History scan started — cron is working back {form.months === 1 ? '1 month' : `${form.months} months`}. New comments keep flowing into the review queue as it drains.
				</p>
			{/if}
		{/if}
		<p class="muted" style="margin:12px 0 0">
			last checked {ch.lastRunAt ? relativeTime(ch.lastRunAt) : 'never'} · ID: {ch.id}
		</p>
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
	{#if form?.error && form?.scope !== 'history'}
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

<style>
	.history-form {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
		margin-top: 10px;
	}
	.danger-zone {
		margin-top: 24px;
		border-color: var(--danger);
	}
	.danger-zone h2 {
		color: var(--danger);
	}
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
	.sensitivity {
		margin: 10px 0 14px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg);
	}
	.sensitivity-title {
		display: block;
		font-size: 0.85rem;
		font-weight: 600;
		margin-bottom: 6px;
	}
	.sensitivity input[type='range'] {
		width: 100%;
		accent-color: var(--brand);
	}
	.sensitivity-options {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		margin-top: 4px;
	}
	.banner {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 8px;
		border-radius: 6px;
		font-size: 0.78rem;
		font-weight: 700;
		letter-spacing: 0.03em;
		color: var(--ink);
		opacity: 0.45;
	}
	.banner img {
		border-radius: 6px;
		filter: grayscale(1);
	}
	.banner.chosen {
		opacity: 1;
		background: var(--danger-soft);
		color: var(--danger);
	}
	.banner.chosen img {
		filter: none;
	}
</style>
