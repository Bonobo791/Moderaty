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
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import EmptyState from '$lib/EmptyState.svelte';

	let { data, form } = $props();

	const isOwner = $derived(data.user?.orgRole === 'owner');
	const hasAutoTopup = $derived(data.autoTopup?.enabled ?? false);
	const autoTopupState = $derived(data.autoTopup?.state ?? 'idle');
	// Svelte 5 runes: a reassigned $state variable must be declared with `let`.
	let pending = $state(false);
	let checkoutAttempts = $state<Record<string, string>>({});

	onMount(() => {
		const keys = ['hosted', 'lifetime', ...data.bundles.map((bundle: { id: string }) => bundle.id)];
		checkoutAttempts = Object.fromEntries(keys.map((key) => [key, crypto.randomUUID()]));
	});

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

{#if data.maintenance}
	<!-- The layout overlay only triggers on LAYOUT data; when the layout was
		healthy but the usage queries failed mid-load, the page renders its own
		state instead of a misleading all-zero shell (I12, codex 6145). -->
	<div class="error-box" role="alert">
		<strong>Maintenance</strong> — Moderaty is temporarily unable to reach its database.
		Nothing on this page will work right now; try again in a minute.
	</div>
{:else}
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

{#if data.metered && data.summary && data.summary.remaining <= 0}
	<p class="error-box" role="alert">
		You are out of credits. AI scoring is paused on your channels (your rules and protected
		handles still run); it resumes automatically as soon as credits arrive.
	</p>
{/if}

{#if isOwner && (data.plans.hosted || data.plans.lifetime)}
	<div class="card">
		<h2 style="margin-top:0">Plans</h2>
		<p class="muted">Current plan: <strong>{data.billing?.plan ?? 'free'}</strong>{#if data.billing?.periodEnd} · period ends {new Date(data.billing.periodEnd).toLocaleDateString()}{/if}</p>
		<div class="plan-actions">
			{#if data.plans.hosted}
				<form method="POST" action="?/buyPlan" use:enhance={submitting}>
					<input type="hidden" name="plan" value="hosted" />
					<input type="hidden" name="attempt_id" value={checkoutAttempts.hosted ?? ''} />
					<button class="btn secondary" type="submit" disabled={pending}>Start hosted · $5/month</button>
				</form>
				<p class="muted">100 included comments per billing period. Unused comments do not roll over; prepaid credits cover overage.</p>
			{/if}
			{#if data.plans.lifetime}
				<form method="POST" action="?/buyPlan" use:enhance={submitting}>
					<input type="hidden" name="plan" value="lifetime" />
					<input type="hidden" name="attempt_id" value={checkoutAttempts.lifetime ?? ''} />
					<button class="btn secondary" type="submit" disabled={pending}>Buy lifetime · $49</button>
				</form>
				<p class="muted">Unlimited comments while the lifetime plan is available. Limited to 1,000 purchasers.</p>
			{/if}
		</div>
	</div>
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
						<input type="hidden" name="attempt_id" value={checkoutAttempts[bundle.id] ?? ''} />
						<button class="btn primary" type="submit" disabled={pending}>Buy {bundle.label}</button>
					</form>
				{/each}
			</div>
			<p class="muted">Each comment your channel processes with AI scoring on a live run consumes one
				credit — rule matches and protected handles are never charged. Payment is processed by
				Stripe; your card is saved so auto top-up can work if you enable it.</p>
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
{/if}

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
	.plan-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
	}
	.plan-actions form {
		flex: 0 0 auto;
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
