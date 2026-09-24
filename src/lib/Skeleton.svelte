<script lang="ts">
	let { rows = 3 }: { rows?: number } = $props();
</script>

<div aria-busy="true" aria-label="Loading">
	{#each Array(rows) as _, i}
		<div class="card">
			<div class="skeleton" style="width: 40%; margin-bottom: 10px"></div>
			<div class="skeleton" style="width: {i % 2 === 0 ? '85%' : '70%'}"></div>
		</div>
	{/each}
</div>
