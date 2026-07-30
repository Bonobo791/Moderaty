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
