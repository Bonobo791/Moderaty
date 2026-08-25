<!-- Moderaty — YouTube Comment Auto-Moderation Tool -->

<script lang="ts">
	import { building } from '$app/environment';
	import { page } from '$app/state';
	import type { Locale } from '$lib/i18n/locale';
	import { t } from '$lib/i18n/messages';

	let { locale }: { locale: Locale } = $props();
	// Include the query string on real SSR too — gating on `browser` dropped
	// ?state= from the /consent round-trip for no-JS submissions (codex). Only
	// PRERENDERED pages must skip it: url.search is inaccessible while
	// prerendering, and those pages are query-agnostic anyway. The hash is
	// deliberately excluded: fragments never reach the server.
	const returnTo = $derived(`${page.url.pathname}${building ? '' : page.url.search}`);
</script>

<form class="language-switcher" method="POST" action="/api/locale">
	<label for="locale-select">{t(locale, 'languageLabel')}</label>
	<select id="locale-select" name="locale" value={locale}>
		<option value="en">{t(locale, 'english')}</option>
		<option value="pt-BR">{t(locale, 'portuguese')}</option>
	</select>
	<input type="hidden" name="returnTo" value={returnTo} />
	<button class="btn secondary small" type="submit">{t(locale, 'apply')}</button>
</form>

<style>
	.language-switcher {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
		padding: 10px 24px;
		border-bottom: 1px solid var(--line);
		font-size: 12px;
		color: var(--ink-2);
	}
	.language-switcher select {
		max-width: 180px;
	}
	@media (max-width: 520px) {
		.language-switcher {
			justify-content: center;
			padding-inline: 16px;
		}
	}
</style>
