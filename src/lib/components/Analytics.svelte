<script lang="ts">
	import { browser } from '$app/environment';
	import { beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { isAnalyticsPage, loadAnalytics } from '$lib/analytics';

	let unavailable = $state(false);
	let pending: AbortController | undefined;

	const eligible = $derived(browser && isAnalyticsPage(page.url));
	let safeDocument = $state(browser && isAnalyticsPage(page.url));

	// Removing the script cannot stop an executed container. Unload this
	// document before the router exposes a sensitive URL or account content.
	beforeNavigate((navigation) => {
		if (navigation.willUnload || !navigation.to) return;
		if (isAnalyticsPage(navigation.to.url)) return;
		// A document that visits a sensitive page must never initialize GTM
		// later: Back would expose that URL before the router could intercept it.
		safeDocument = false;
		pending?.abort();
		if (!document.getElementById('moderaty-gtm')) return;
		navigation.cancel();
		window.location.assign(navigation.to.url.href);
	});

	$effect(() => {
		if (!eligible || !safeDocument) return;
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

{#if eligible && safeDocument && unavailable}
	<p class="analytics-status" role="status">Optional usage measurement is unavailable.</p>
{/if}

<style>
	.analytics-status {
		padding: 8px 24px;
		color: var(--ink-2);
		font-size: 12px;
	}
</style>
