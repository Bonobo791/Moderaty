<script>
	import Page from '../../src/routes/(app)/channels/[id]/log/+page.svelte';
	let data = $state({ ch: { id: 'UC1', title: 'Ch' }, entries: [], nextCursor: null, hasPrev: false, canRecover: true, recovery: [], dispatches: [] });
	export function updateRecovery(recovery) { data = { ...data, recovery }; }
</script>

<Page {data} form={null} />
