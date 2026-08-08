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

<!-- Account settings (redesign spec §7 Step 5.1/5.2): identity headline, the
	 Connection ledger, and the DANGER ZONE with the delete-account flow moved
	 off the dashboard. The delete button runs three states — disabled until
	 the acknowledgement is checked, outlined once checked, armed solid red
	 after the first click; unchecking disarms. Only the final click submits. -->

<script lang="ts">
	import { enhance } from '$app/forms';
	import SharpCheckbox from '$lib/SharpCheckbox.svelte';
	import type { ActionData, PageData } from './$types';

	let {
		data,
		form,
		// Test-only seeds for the client-only button states (SSR pins render
		// each state directly, like SensitivitySwitch's level prop).
		initialConfirmed = false,
		initialArmed = false
	}: {
		data: PageData;
		form: ActionData;
		initialConfirmed?: boolean;
		initialArmed?: boolean;
	} = $props();

	let confirmed = $state(initialConfirmed);
	let armed = $state(initialArmed);

	const roleLabel = $derived(
		data.orgRole ? data.orgRole[0].toUpperCase() + data.orgRole.slice(1) : 'Member'
	);

	// Unchecking the acknowledgement disarms the button — the armed state can
	// never survive the condition that enabled it.
	$effect(() => {
		if (!confirmed) armed = false;
	});

	function onDeleteClick(event: MouseEvent) {
		// First click arms instead of submitting; the second click falls through
		// and submits the form to the deleteAccount action.
		if (!armed) {
			event.preventDefault();
			armed = true;
		}
	}
</script>

<svelte:head>
	<title>Moderaty — Account settings</title>
</svelte:head>

{#if data.maintenance}
	<!-- The layout's overlay only triggers on LAYOUT data; a mid-load outage
		here renders the page's own state instead of an empty shell with a
		destructive delete control (I12). -->
	<div class="error-box" role="alert">
		<strong>Maintenance</strong> — Moderaty is temporarily unable to reach its database.
		Nothing on this page will work right now; try again in a minute.
	</div>
{:else if data.user}
<!-- The load guarantees a non-null user outside maintenance (the guard's
	data.user half is for the type system, same as the app layout). -->
<section class="account-head" aria-labelledby="account-label">
	<span class="caps-label" id="account-label">Account settings</span>
	<h1>{data.user.displayName}</h1>
	<p class="mono signed-in">Signed in with Google</p>
</section>

<section class="connection" aria-labelledby="connection-label">
	<div class="connection-head">
		<h2 class="caps-label" id="connection-label">Connection</h2>
		<form method="POST" action="/logout">
			<button class="link-u signout" type="submit">Sign out</button>
		</form>
	</div>
	<dl class="connection-rows">
		<div class="connection-row">
			<dt>Account</dt>
			<dd>{data.user.email}</dd>
		</div>
		<div class="connection-row">
			<dt>Sign-in</dt>
			<dd>Google</dd>
		</div>
		<div class="connection-row">
			<dt>Role</dt>
			<dd>{roleLabel}</dd>
		</div>
		<div class="connection-row">
			<dt>Access</dt>
			<dd>
				{data.channelCount} YouTube channel{data.channelCount === 1 ? '' : 's'} connected
			</dd>
		</div>
	</dl>
</section>

<div class="danger-zone">
	<span class="caps-label danger-label">Danger zone</span>
	<h2>Delete account</h2>
	<p class="muted legal">
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
		<SharpCheckbox
			bind:checked={confirmed}
			name="confirm"
			label="I understand and want to delete my Moderaty account"
		/>
		<button
			class="delete-btn"
			class:outlined={confirmed && !armed}
			class:armed
			type="submit"
			disabled={!confirmed}
			onclick={onDeleteClick}
		>
			{armed ? 'Click again to confirm. No restore window.' : 'Delete my account'}
		</button>
	</form>
</div>
{/if}

<style>
	/* ── identity header ────────────────────────────────────── */
	.account-head {
		margin-bottom: 48px;
	}
	.account-head h1 {
		font-size: 44px;
		font-weight: 600;
		line-height: 1.05;
		margin: 14px 0 10px;
	}
	.signed-in {
		margin: 0;
		font-size: 12px;
		color: var(--text-3);
	}

	/* ── connection ledger (spec §7 Step 5.1): definition rows,
	   caps label column 140–220px, --line hairlines ────────── */
	.connection {
		margin-bottom: 56px;
	}
	.connection-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 16px;
		margin-bottom: 16px;
	}
	.connection-head h2 {
		margin: 0;
	}
	.signout {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 14px;
		cursor: pointer;
	}
	.connection-rows {
		margin: 0;
	}
	.connection-row {
		display: flex;
		gap: 24px;
		padding: 14px 0;
		border-bottom: 1px solid var(--line);
	}
	.connection-row:first-child {
		border-top: 1px solid var(--line);
	}
	.connection-row dt {
		flex: 0 0 180px;
		font-size: 11px;
		font-weight: 500;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-3);
	}
	.connection-row dd {
		margin: 0;
		color: var(--text);
	}

	/* ── danger zone (spec §7 Step 5.2) ─────────────────────── */
	.danger-zone {
		border: 1px solid rgba(255, 49, 49, 0.35);
		padding: 28px 32px;
	}
	.danger-label {
		color: var(--accent);
	}
	.danger-zone h2 {
		margin: 14px 0 12px;
		font-size: 22px;
		font-weight: 600;
	}
	.legal {
		font-size: 0.9em;
		line-height: 1.6;
		max-width: 640px;
	}

	/* delete button, three states (spec §7 Step 5.2):
	   unchecked → disabled, --line border, --text-3 text;
	   checked → --accent border + text, faint accent hover;
	   armed → solid --accent, black text. */
	.delete-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 48px;
		padding: 0 28px;
		margin-top: 20px;
		font-size: 13px;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		background: transparent;
		border: 1px solid var(--line);
		color: var(--text-3);
		cursor: not-allowed;
		transition:
			color 150ms var(--ease-out),
			border-color 150ms var(--ease-out),
			background 150ms var(--ease-out);
	}
	.delete-btn.outlined {
		border-color: var(--accent);
		color: var(--accent);
		cursor: pointer;
	}
	.delete-btn.outlined:hover {
		background: rgba(255, 49, 49, 0.08);
	}
	.delete-btn.armed {
		background: var(--accent);
		border-color: var(--accent);
		color: #000;
		cursor: pointer;
	}
	.delete-btn:focus-visible {
		outline: 1px solid var(--accent);
		outline-offset: 2px;
	}

	@media (prefers-reduced-motion: reduce) {
		.delete-btn {
			transition: none;
		}
	}
</style>
