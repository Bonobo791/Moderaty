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

<!-- This page is English-only: the consent sentence, refund/privacy
	notices, and server validation copy are English constants (MOD-11 —
	no selector until the legal copy itself is translated, PR #142 review). -->
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
