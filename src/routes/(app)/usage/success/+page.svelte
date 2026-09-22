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
		{#if data.test}
			<h2 style="margin-top:0">Test checkout passed</h2>
			<p>
				Stripe's webhook received the payment and granted the test credit — checkout,
				webhook, and ledger are verified end-to-end on this deployment.
			</p>
		{:else}
			<h2 style="margin-top:0">Thank you!</h2>
			<p>Your credits have been added to your balance.</p>
		{/if}
		<a class="btn primary" href="/usage">Back to Usage</a>
	</div>
{:else if data.pending}
	<div class="card">
		{#if data.test}
			<h2 style="margin-top:0">Payment received — waiting for the webhook</h2>
			<p>
				The test only counts once Stripe's webhook confirms the credit grant — refresh in
				a few seconds. If it never confirms, the webhook endpoint is not reaching this
				deployment (check the Stripe webhook configuration and the server log).
			</p>
		{:else}
			<h2 style="margin-top:0">Payment received — almost there</h2>
			<p>
				Your credits will appear on the Usage tab within a few seconds. If they do not,
				refresh this page in a moment — your purchase is recorded by the payment provider either way.
			</p>
		{/if}
		<a class="btn primary" href="/usage">Back to Usage</a>
	</div>
{:else if data.refunded}
	<div class="card">
		{#if data.test}
			<h2 style="margin-top:0">Test checkout refunded</h2>
			<p>
				This plan is unmetered, so the payment was refunded instead of granting a credit —
				the refund path was exercised end-to-end. Refunds usually land within a few
				business days.
			</p>
		{:else}
			<h2 style="margin-top:0">Payment refunded</h2>
			<p>
				This purchase could not be completed — your payment is being refunded automatically
				and nothing was granted. Refunds usually land within a few business days.
			</p>
		{/if}
		<a class="btn primary" href="/usage">Back to Usage</a>
	</div>
{:else if data.manualRefund}
	<div class="card">
		<h2 style="margin-top:0">Payment received — refund needs review</h2>
		<p>
			This purchase could not be completed, and the automatic refund could not be
			confirmed. Nothing was granted and your payment is flagged for a manual refund —
			contact support if it has not landed within a few business days.
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
