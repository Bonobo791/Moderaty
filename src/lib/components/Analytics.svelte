<script lang="ts">
	import { browser } from '$app/environment';
	import { beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, onMount } from 'svelte';
	import { createAnalyticsClient, readMarketingClick } from '$lib/analytics';
	import { ANALYTICS_OPT_OUT_KEY, ANALYTICS_PREFERENCE_EVENT } from '$lib/analytics-preference';
	import { analyticsPageUrl, isAnalyticsPage } from '$lib/analytics-policy';

	let unavailable = $state(false);
	let failureGeneration = 0;
	let pending: AbortController | undefined;
	const publicUrl = $derived(browser ? analyticsPageUrl(page.url) : null);
	const eligible = $derived(publicUrl !== null);
	let safeDocument = $state(browser && isAnalyticsPage(page.url));
	const client = browser ? createAnalyticsClient({ onFailure: () => { failureGeneration++; unavailable = true; } }) : undefined;

	beforeNavigate((navigation) => {
		if (!navigation.to || isAnalyticsPage(navigation.to.url)) return;
		safeDocument = false;
		pending?.abort();
		client?.stop();
	});
	onDestroy(() => { pending?.abort(); client?.stop(); });
	onMount(() => {
		const click = (event: MouseEvent) => {
			if (!eligible || !safeDocument || !client) return;
			const pair = readMarketingClick(event);
			if (pair) void client.click(pair.name, pair.placement).catch(() => { unavailable = true; });
		};
		const preference = () => client?.preferenceChanged();
		const storage = (event: StorageEvent) => {
			if (event.key === ANALYTICS_OPT_OUT_KEY || event.key === null) preference();
		};
		document.addEventListener('click', click, { passive: true });
		document.addEventListener('auxclick', click, { passive: true });
		window.addEventListener('storage', storage);
		window.addEventListener(ANALYTICS_PREFERENCE_EVENT, preference);
		return () => {
			document.removeEventListener('click', click); document.removeEventListener('auxclick', click);
			window.removeEventListener('storage', storage); window.removeEventListener(ANALYTICS_PREFERENCE_EVENT, preference);
		};
	});
	$effect(() => {
		if (publicUrl === null || !safeDocument || !client) return;
		const controller = new AbortController();
		const failureAtStart = failureGeneration;
		pending = controller;
		void client.pageview(new URL(publicUrl, window.location.origin), controller.signal).then((result) => {
			if (result === 'sent' && !controller.signal.aborted && failureGeneration === failureAtStart) unavailable = false;
		}).catch(() => {
			if (!controller.signal.aborted) unavailable = true;
		});
		return () => controller.abort();
	});
</script>

{#if eligible && safeDocument && unavailable}
	<p class="analytics-status" role="status">Optional usage measurement is unavailable.</p>
{/if}

<style>
	.analytics-status { padding: 8px 24px; color: var(--ink-2); font-size: 12px; }
</style>
