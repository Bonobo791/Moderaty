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

	let { data, form } = $props();

	const isOwner = $derived(data.user?.orgRole === 'owner');
	const hasAutoTopup = $derived(data.autoTopup?.enabled ?? false);
	const autoTopupState = $derived(data.autoTopup?.state ?? 'idle');
	// Svelte 5 runes: a reassigned $state variable must be declared with `let`.
	let pending = $state(false);

	// Mirrors the page's async form submission so buy/enable buttons disable
	// while the request is in flight (I12 loading affordance).
	function submitting() {
		pending = true;
		return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: true });
			pending = false;
		};
	}
</script>

<svelte:head>
	<title>Moderaty — Usage</title>
</svelte:head>

<h1>Usage</h1>
<p class="page-sub">
	{data.user?.orgName} — comment credits
</p>

{#if form?.error}
	<p class="error-box" role="alert">{form.error}</p>
{/if}
{#if form?.ok}
	<p class="ok-box" role="status">Saved.</p>
{/if}

<div class="stats-row">
	<div class="stat-card">
		<span class="stat-kicker">Credits left</span>
		<span class="stat-value">{data.summary?.remaining ?? 0}</span>
	</div>
	<div class="stat-card">
		<span class="stat-kicker">Used this month</span>
		<span class="stat-value">{data.summary?.usedThisMonth ?? 0}</span>
	</div>
	<div class="stat-card">
		<span class="stat-kicker">Used total</span>
		<span class="stat-value">{data.summary?.usedLifetime ?? 0}</span>
	</div>
</div>

{#if data.summary && data.summary.remaining <= 0}
	<p class="error-box" role="alert">
		You are out of credits. AI scoring is paused on your channels (your rules and protected
		handles still run); it resumes automatically as soon as credits arrive.
	</p>
{/if}

{#if isOwner}
	<div class="card">
		<h2 style="margin-top:0">Buy credits</h2>
		{#if data.bundles.length === 0}
			<p class="muted">No bundles are configured yet — the owner needs to set the
				STRIPE_PRICE_CREDITS_* environment variables.</p>
		{:else}
			<div class="bundle-grid">
				{#each data.bundles as bundle (bundle.id)}
					<form method="POST" action="?/buy" use:enhance={submitting}>
						<input type="hidden" name="bundle" value={bundle.id} />
						<button class="btn primary" type="submit" disabled={pending}>Buy {bundle.label}</button>
					</form>
				{/each}
			</div>
			<p class="muted">Each comment your channel processes consumes one credit. Payment is
				processed by Stripe; your card is saved so auto top-up can work if you enable it.</p>
		{/if}
	</div>

	<div class="card">
		<h2 style="margin-top:0">Automatic top-up</h2>
		<p class="muted">
			When your balance drops below the threshold, we charge your saved card for the
			smallest configured bundle and the credits land on your balance automatically.
		</p>
		{#if hasAutoTopup && autoTopupState === 'disabled'}
			<p class="error-box" role="alert">
				Auto top-up is paused: the last attempt failed ({data.autoTopup?.failures ?? 0}{' '}
				consecutive failures). Your card issuer may have declined the charge or required
				re-authentication. Buy a bundle manually, then re-enable auto top-up below.
			</p>
		{/if}
		{#if hasAutoTopup && !data.autoTopup?.hasCard}
			<p class="error-box" role="alert">
				Auto top-up is enabled but no card is saved yet — buy any bundle once and your
				payment method is stored for future top-ups.
			</p>
		{/if}
		<form method="POST" action="?/setAutoTopup" use:enhance={submitting}>
			<label for="auto-topup-enabled">
				<input id="auto-topup-enabled" type="checkbox" name="enabled" checked={hasAutoTopup} />
				Enable automatic top-up
			</label>
			<div class="field-row">
				<label for="auto-topup-threshold">Top up when my balance drops below</label>
				<input
					id="auto-topup-threshold"
					type="number"
					name="threshold"
					min="0"
					max="1000000"
					step="1"
					value={data.autoTopup?.threshold ?? 100}
					required
				/>
				<span>credits</span>
			</div>
			{#if !hasAutoTopup}
				<label for="auto-topup-consent" class="consent-label">
					<input id="auto-topup-consent" type="checkbox" name="consent" />
					{data.autoTopupConsentText}
				</label>
			{/if}
			<button class="btn secondary small" type="submit" disabled={pending}>
				{hasAutoTopup ? 'Update auto top-up' : 'Enable auto top-up'}
			</button>
		</form>
	</div>
{/if}

<div class="card">
	<h2 style="margin-top:0">Purchase history</h2>
	{#if data.history.length === 0}
		<EmptyState title="No activity yet" hint="Purchases and consumption will show up here." />
	{:else}
		<table class="stack-table">
			<thead>
				<tr><th>When</th><th>Change</th><th>What</th></tr>
			</thead>
			<tbody>
				{#each data.history as row (row.id)}
					<tr>
						<td data-label="When">{new Date(row.createdAt).toLocaleString()}</td>
						<td data-label="Change">
							<span class:badge={true} class:ok={row.delta > 0} class:neutral={row.delta < 0}>
								{row.delta > 0 ? `+${row.delta}` : row.delta}
							</span>
						</td>
						<td data-label="What">
							{row.reason}
							<span class="muted"> — {row.refType} {row.refId.slice(0, 24)}</span>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<style>
	.stats-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
		gap: 12px;
		margin-bottom: 20px;
	}
	.stat-card {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 18px 16px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.stat-kicker {
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-2);
	}
	.stat-value {
		font-size: 28px;
		font-weight: 600;
	}
	.bundle-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}
	.field-row {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 10px 0;
	}
	.field-row input {
		width: 110px;
	}
	.consent-label {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		max-width: 640px;
		margin: 10px 0;
		line-height: 1.5;
	}
	.muted {
		color: var(--ink-2);
		font-size: 13px;
	}
</style>
