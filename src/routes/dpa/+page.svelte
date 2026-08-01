<!--
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
-->

<script lang="ts">
	// I12 exception (approved for static marketing routes, same as the
	// homepage): this page is fully static and prerendered (see +page.ts) —
	// there is no data loading, so loading/empty/error states cannot occur
	// and SSR always renders the populated page.
	import LegalPage from '$lib/components/landing/legal/LegalPage.svelte';
	import Dpa from '$lib/components/landing/legal/Dpa.svelte';
	import { DPA_DOC } from '$lib/landing/legal';
</script>

<LegalPage doc={DPA_DOC} content={Dpa} />
