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
			refresh this page in a moment — your purchase is recorded by the payment provider either way.
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
