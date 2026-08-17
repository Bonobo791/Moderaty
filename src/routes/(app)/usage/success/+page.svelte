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
	let { data } = $props();
</script>

<svelte:head>
	<title>Moderaty — Payment</title>
</svelte:head>

<h1>Payment</h1>

{#if data.granted}
	<div class="card">
		<h2 style="margin-top:0">Thank you!</h2>
		<p>Your credits have been added to your balance.</p>
		<a class="btn primary" href="/usage">Back to Usage</a>
	</div>
{:else if data.pending}
	<div class="card">
		<h2 style="margin-top:0">Payment received — almost there</h2>
		<p>
			Your credits will appear on the Usage tab within a few seconds. If they do not,
			refresh this page in a moment — your purchase is recorded on Stripe's side either way.
		</p>
		<a class="btn primary" href="/usage">Back to Usage</a>
	</div>
{:else}
	<div class="card">
		<h2 style="margin-top:0">No purchase found</h2>
		<p>This link does not point to a completed purchase for your account.</p>
		<a class="btn primary" href="/usage">Back to Usage</a>
	</div>
{/if}
