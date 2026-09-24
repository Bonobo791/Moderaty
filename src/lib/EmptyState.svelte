<script lang="ts">
	let { title, hint = '' }: { title: string; hint?: string } = $props();
</script>

<div class="empty">
	<p>{title}</p>
	{#if hint}<span class="muted">{hint}</span>{/if}
</div>
