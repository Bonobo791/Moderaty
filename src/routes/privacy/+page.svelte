<script lang="ts">
	// I12 exception (approved for static marketing routes, same as the
	// homepage): this page is fully static and prerendered (see +page.ts) —
	// there is no data loading, so loading/empty/error states cannot occur
	// and SSR always renders the populated page.
	import LegalPage from '$lib/components/landing/legal/LegalPage.svelte';
	import Privacy from '$lib/components/landing/legal/Privacy.svelte';
	import { PRIVACY_DOC } from '$lib/landing/legal';
</script>

<LegalPage doc={PRIVACY_DOC} content={Privacy} />
