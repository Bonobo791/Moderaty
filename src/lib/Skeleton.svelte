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
