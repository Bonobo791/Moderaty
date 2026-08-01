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
	let { data, form } = $props();
</script>

<svelte:head>
	<title>Moderaty — Finish creating your account</title>
</svelte:head>

<main class="consent-main">
	<div class="card consent-card">
		{#if data.kind === 'new'}
			<h1>Almost there{data.displayName ? `, ${data.displayName}` : ''}</h1>
			<p class="muted">To finish creating your account:</p>
		{:else}
			<h1>Updated terms</h1>
			<p class="muted">Our legal documents have changed — please review and accept the current version to continue.</p>
		{/if}

		{#if form?.error}
			<p class="error-box" role="alert">{form.error}</p>
		{/if}

		<form method="POST">
			<!-- The visible sentence must stay byte-identical to CONSENT_CHECKBOX_TEXT
			     in src/lib/server/legal.ts — that constant is what the consent log
			     stores as "the exact text shown". Links don't alter the wording. -->
			<label class="check">
				<input type="checkbox" name="consent" />
				<span>
					I am at least 18 years old and agree to the
					<a href="/terms" target="_blank" rel="noopener">Terms of Service</a>,
					<a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>, and
					<a href="/dpa" target="_blank" rel="noopener">Data Processing Agreement</a>
				</span>
			</label>
			<label class="check">
				<input type="checkbox" name="marketing" />
				<span>{data.marketingText}</span>
			</label>
			<button class="btn" type="submit">{data.kind === 'new' ? 'Create account' : 'Accept and continue'}</button>
		</form>
	</div>
</main>

<style>
	.consent-main {
		display: grid;
		place-items: center;
		min-height: 100vh;
		padding: 24px;
	}
	.consent-card {
		max-width: 460px;
	}
	.consent-card form {
		display: grid;
		gap: 14px;
		margin-top: 16px;
	}
	.check {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		font-size: 14px;
		line-height: 1.5;
	}
	.check input {
		margin-top: 3px;
		flex-shrink: 0;
	}
	.consent-card .btn {
		justify-self: start;
		margin-top: 4px;
	}
</style>
