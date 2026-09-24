<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children, data } = $props();

	// hooks.server.ts rewrites <html lang> only on a full page load; after
	// client-side navigation the layout load re-runs (data.locale is already
	// gated to the surface's coverage) but the attribute would go stale —
	// keep it describing the rendered surface (cubic, PR #142).
	$effect(() => {
		document.documentElement.lang = data.locale;
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
