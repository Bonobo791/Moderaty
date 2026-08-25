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

Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md
-->

<script lang="ts">
	import { segmentConsentText } from '$lib/consentText';
	import { t } from '$lib/i18n/messages';

	let { data, form } = $props();
	// The sentence arrives as data.consentText = CONSENT_CHECKBOX_TEXT — the
	// same constant the consent log stores as "the exact text shown". Splitting
	// preserves every character, so the visible sentence cannot drift from the
	// logged one; the document links sit between the corresponding segments.
	const segments = $derived(segmentConsentText(data.consentText));
</script>

<svelte:head>
	<title>Moderaty — {t(data.locale, 'finishAccount')}</title>
</svelte:head>

<main class="consent-main">
	<div class="card consent-card">
		{#if data.kind === 'new'}
			<h1>{t(data.locale, 'almostThere')}{data.displayName ? `, ${data.displayName}` : ''}</h1>
			<p class="muted">{t(data.locale, 'finishAccountPrompt')}</p>
		{:else}
			<h1>{t(data.locale, 'updatedTerms')}</h1>
			<p class="muted">{t(data.locale, 'legalChanged')}</p>
		{/if}

		{#if form?.error}
			<p class="error-box" role="alert">{form.error}</p>
		{/if}

		<form method="POST">
			<label class="check">
				<input type="checkbox" name="consent" />
				<span>{#each segments as segment}{#if segment.href}<a href={segment.href} target="_blank" rel="noopener">{segment.text}</a>{:else}{segment.text}{/if}{/each}</span>
			</label>
			<label class="check">
				<input type="checkbox" name="marketing" />
				<span>{t(data.locale, 'marketingText')}</span>
			</label>
			<button class="btn" type="submit">{data.kind === 'new' ? t(data.locale, 'createAccount') : t(data.locale, 'acceptContinue')}</button>
		</form>
		<p class="refund-note">{data.refundText}</p>
		<p class="privacy-note">{data.privacyText}</p>
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
	.refund-note {
		margin: 20px 0 0;
		font-size: 12px;
		line-height: 1.6;
		color: var(--ink-2);
	}
	.privacy-note {
		margin: 10px 0 0;
		font-size: 12px;
		line-height: 1.6;
		color: var(--ink-2);
	}
</style>
