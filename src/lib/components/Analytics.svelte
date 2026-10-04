<script lang="ts">
	import { onMount } from 'svelte';
	import { loadAnalytics } from '$lib/analytics';

	let unavailable = $state(false);

	onMount(() => {
		void loadAnalytics().catch((cause) => {
			console.error('analytics initialization failed:', cause);
			unavailable = true;
		});
	});
</script>

{#if unavailable}
	<p class="analytics-status" role="status">Optional usage measurement is unavailable.</p>
{/if}

<style>
	.analytics-status {
		padding: 8px 24px;
		color: var(--ink-2);
		font-size: 12px;
	}
</style>
