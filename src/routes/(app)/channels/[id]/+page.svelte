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
	import { autoRefresh } from '$lib/auto-refresh.svelte';

	let { data, form } = $props();

	// Counts change with every cron run; revalidate like the queue and log pages.
	autoRefresh();

	const ch = $derived(data.ch);
	const level = $derived(ch.toneLevel ?? 1);

	// True while the dry-run preview is in flight; the button is disabled
	// while it runs (the action's lease claim also 409s a server-side race).
	let dryRunPending = $state(false);
</script>

<svelte:head>
	<title>Moderaty — {ch.title}</title>
</svelte:head>

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
<form class="protections" method="POST" action="?/setProtections" use:enhance>
	<input type="hidden" name="channelId" value={ch.id} />
	<span class="sensitivity-title">Strict protection</span>
	<label class="protection-toggle" for="protect-lgbtqia-{ch.id}">
		<input
			id="protect-lgbtqia-{ch.id}"
			type="checkbox"
			name="protectLgbtqia"
			checked={ch.protectLgbtqia === 1}
			onchange={(event) => event.currentTarget.form?.requestSubmit()}
		/>
		Harassment targeting LGBTQIA+ people
	</label>
	<label class="protection-toggle" for="protect-women-{ch.id}">
		<input
			id="protect-women-{ch.id}"
			type="checkbox"
			name="protectWomen"
			checked={ch.protectWomen === 1}
			onchange={(event) => event.currentTarget.form?.requestSubmit()}
		/>
		Harassment targeting women
	</label>
	<p class="muted" style="margin:6px 0 0">
		Heightened AI scrutiny for these comments, at any sensitivity level.
	</p>
</form>
{#if form?.scope === 'protections' && form?.error}
	<p class="error-box" role="alert">{form.error}</p>
{/if}
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
{#if form?.scope === 'history'}
	{#if form?.error}
		<p class="error-box" role="alert">{form.error}</p>
	{:else if form?.ok}
		<p class="muted" role="status">
			History scan started — cron is working back {form.months === 1 ? '1 month' : `${form.months} months`}. New comments keep flowing into the review queue as it drains.
		</p>
	{/if}
{/if}
{#if ch.scanning}
	<p class="muted" role="status">
		History scan in progress — cron is working through the backlog and new comments flow into the review queue as it drains. This runs in the background: refreshing or leaving this page won't stop it.
	</p>
{/if}
<form
	method="POST"
	action="?/dryRun"
	class="history-form"
	use:enhance={() => {
		dryRunPending = true;
		return async ({ update }) => {
			await update();
			dryRunPending = false;
		};
	}}
>
	<input type="hidden" name="channelId" value={ch.id} />
	<label for="dryrun-months-{ch.id}">Dry run</label>
	<select id="dryrun-months-{ch.id}" name="months" aria-label="How far back the dry run covers on {ch.title}">
		<option value="1">last month</option>
		<option value="3" selected>last 3 months</option>
		<option value="6">last 6 months</option>
		<option value="12">last 12 months</option>
		<option value="24">last 24 months</option>
		<option value="all">all time</option>
	</select>
	<button
		class="btn secondary small"
		type="submit"
		disabled={dryRunPending}
		aria-label="Run a dry-run preview on {ch.title}"
	>
		{dryRunPending ? 'Running dry run…' : 'Dry run'}
	</button>
</form>
{#if form?.scope === 'dryRun'}
	{#if form?.error}
		<p class="error-box" role="alert">{form.error}</p>
	{:else if form?.skipped}
		<p class="muted" role="status">Dry run preview: nothing new to preview right now.</p>
	{:else if form?.ok}
		<p class="muted" role="status">
			Dry run preview ({form.months === 'all' ? 'all time' : form.months === 1 ? 'last month' : `last ${form.months} months`}): {form.fetched} comment{form.fetched === 1 ? '' : 's'} scanned —
			{form.acted} would be acted on, {form.queued} would go to the review queue.
			{#if form.partial}Partial — the 20 s preview limit was hit; see the audit log for what completed. {/if}
			<a href="/channels/{ch.id}/log">See the audit log</a>.
		</p>
	{/if}
{/if}
{#if data.orgRole === 'owner' || data.orgRole === 'admin'}
	<details class="channel-disconnect">
		<summary>Danger zone — disconnect channel</summary>
		<p class="muted">
			Disconnecting asks Google to revoke Moderaty's access to {ch.title} and immediately
			erases the channel with all its rules, comments, and moderation history — there is no
			restore. You can reconnect the channel afterwards, which starts it fresh.
		</p>
		{#if form?.scope === 'disconnect' && form?.error}
			<p class="error-box" role="alert">{form.error}</p>
		{/if}
		<form method="POST" action="?/disconnectChannel" use:enhance>
			<input type="hidden" name="channelId" value={ch.id} />
			<label class="confirm-delete" for="confirm-disconnect-{ch.id}">
				<input id="confirm-disconnect-{ch.id}" type="checkbox" name="confirm" />
				I understand — disconnect {ch.title} and erase its data
			</label>
			<button class="btn danger small" type="submit">Disconnect channel {ch.title}</button>
		</form>
	</details>
{/if}

<style>
	.history-form {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
		margin-top: 10px;
	}
	.channel-disconnect {
		margin-top: 14px;
		padding-top: 10px;
		border-top: 1px dashed var(--danger);
	}
	.channel-disconnect summary {
		cursor: pointer;
		font-size: 0.9rem;
		font-weight: 600;
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
	.sensitivity {
		margin: 10px 0 14px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg);
	}
	.protections {
		margin: 10px 0 14px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg);
	}
	.protection-toggle {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		font-size: 0.9rem;
		margin: 8px 0;
	}
	.protection-toggle input {
		margin-top: 3px;
		flex-shrink: 0;
		accent-color: var(--brand);
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
