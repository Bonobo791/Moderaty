<script lang="ts">
	import { browser } from '$app/environment';
	import { beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { isAnalyticsPage, loadAnalytics } from '$lib/analytics';

	let unavailable = $state(false);
	let pending: AbortController | undefined;

	const eligible = $derived(browser && isAnalyticsPage(page.url));

	// Removing the script cannot stop an executed container. Unload this
	// document before the router exposes a sensitive URL or account content.
	beforeNavigate((navigation) => {
		if (navigation.willUnload || !navigation.to) return;
		const destinationEligible = isAnalyticsPage(navigation.to.url);
		if (!destinationEligible) pending?.abort();
		if (destinationEligible === isAnalyticsPage(page.url)) return;
		// Entering public pages must also unload: otherwise Back can expose
		// sensitive history URLs to a container before the router handles them.
		if (!destinationEligible && !document.getElementById('moderaty-gtm')) return;
		navigation.cancel();
		window.location.assign(navigation.to.url.href);
	});

	$effect(() => {
		if (!eligible) return;
		unavailable = false;
		const controller = new AbortController();
		pending = controller;
		void loadAnalytics(controller.signal).catch((cause) => {
			if (controller.signal.aborted) return;
			console.error('analytics initialization failed:', cause);
			unavailable = true;
		});
		return () => controller.abort();
	});
</script>

{#if eligible && unavailable}
	<p class="analytics-status" role="status">Optional usage measurement is unavailable.</p>
{/if}

<style>
	.analytics-status {
		padding: 8px 24px;
		color: var(--ink-2);
		font-size: 12px;
	}
</style>
