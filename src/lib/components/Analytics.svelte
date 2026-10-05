<script lang="ts">
	import { browser } from '$app/environment';
	import { beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy } from 'svelte';
	import { createAnalyticsClient } from '$lib/analytics';
	import { isAnalyticsPage } from '$lib/analytics-policy';

	let unavailable = $state(false);
	let pending: AbortController | undefined;
	const eligible = $derived(browser && isAnalyticsPage(page.url));
	let safeDocument = $state(browser && isAnalyticsPage(page.url));
	const client = browser ? createAnalyticsClient({ onFailure: () => { unavailable = true; } }) : undefined;

	beforeNavigate((navigation) => {
		if (!navigation.to || isAnalyticsPage(navigation.to.url)) return;
		safeDocument = false;
		pending?.abort();
		client?.stop();
	});
	onDestroy(() => { pending?.abort(); client?.stop(); });
	$effect(() => {
		if (!eligible || !safeDocument || !client) return;
		const controller = new AbortController();
		pending = controller;
		void client.pageview(page.url, controller.signal).catch(() => {
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
