<script lang="ts">
	import { onMount } from 'svelte';
	import { ANALYTICS_OPT_OUT_KEY, ANALYTICS_PREFERENCE_EVENT, getAnalyticsOptOut, setAnalyticsOptOut } from '$lib/analytics-preference';
	import { isAnalyticsPage } from '$lib/analytics-policy';

	let disabled = $state(false);
	let ready = $state(false);
	let unavailable = $state(false);
	function readPreference() {
		try { disabled = getAnalyticsOptOut(); ready = true; }
		catch { disabled = true; unavailable = true; console.error('analytics preference failed'); }
	}
	onMount(() => {
		readPreference();
		const storage = (event: StorageEvent) => { if (event.key === ANALYTICS_OPT_OUT_KEY || event.key === null) readPreference(); };
		window.addEventListener('storage', storage);
		window.addEventListener(ANALYTICS_PREFERENCE_EVENT, readPreference);
		return () => { window.removeEventListener('storage', storage); window.removeEventListener(ANALYTICS_PREFERENCE_EVENT, readPreference); };
	});
	function toggle() {
		const next = !disabled;
		try {
			setAnalyticsOptOut(next); disabled = next;
			// A stopped document restarts only by a fresh eligible public load.
			if (!next && isAnalyticsPage(new URL(window.location.href))) window.location.reload();
		} catch { disabled = true; unavailable = true; console.error('analytics preference failed'); }
	}
</script>

<div class="measurement-preference">
	<p>Audience measurement</p>
	<button type="button" aria-pressed={disabled} disabled={!ready || unavailable} onclick={toggle}>
		{disabled ? 'Allow audience measurement' : 'Disable audience measurement'}
	</button>
	<p class="explanation">Optional public-page statistics. Browser privacy settings are always respected. <a href="/privacy#s12">Privacy and your choices</a>.</p>
	{#if unavailable}<p role="status">Audience measurement preference is unavailable. Measurement is disabled.</p>{/if}
</div>

<style>
	.measurement-preference { margin-top: 24px; color: rgb(244 244 248 / 0.7); font-size: 12px; }
	.measurement-preference p { margin: 8px 0; }
	button { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 8px 12px; background: transparent; color: inherit; cursor: pointer; }
	button:focus-visible { outline: 2px solid var(--paper); outline-offset: 3px; }
	button:disabled { cursor: default; opacity: 0.6; }
	.explanation { max-width: 52ch; line-height: 1.6; }
	a { color: inherit; }
</style>
