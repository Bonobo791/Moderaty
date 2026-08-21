<!--
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher

Licensed under the PolyForm Shield License 1.0.0; you may not use
this file except in compliance with the License. You may obtain a
copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.

The software is provided "as is", without warranty or condition of
any kind, express or implied. See the License for the specific
language governing permissions and limitations under the License.
A copy of the License is included in the LICENSE file at the
repository root.

Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md
-->

<script lang="ts">
	// I12 exception (approved for static marketing routes, same as the
	// homepage): this page is fully static and prerendered (see +page.ts) —
	// there is no data loading, so loading/empty/error states cannot occur
	// and SSR always renders the populated page.
	import LegalPage from '$lib/components/landing/legal/LegalPage.svelte';
	import Terms from '$lib/components/landing/legal/Terms.svelte';
	import { TERMS_DOC } from '$lib/landing/legal';
</script>

<LegalPage doc={TERMS_DOC} content={Terms} />
