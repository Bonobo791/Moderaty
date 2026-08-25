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
	import Nav from '$lib/components/landing/Nav.svelte';
	import Footer from '$lib/components/landing/Footer.svelte';

	let { data } = $props();
</script>

<svelte:head>
	<title>Confirm your contact request | Moderaty</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<Nav />

<main class="verify-main">
	<div class="verify-inner">
		{#if data.state === 'verified'}
			<div class="card outcome" role="status">
				<h1 class="outcome-title">E-mail confirmed</h1>
				<p>Thanks{data.email ? `, ${data.email}` : ''} — your contact request is confirmed and we will get back to you.</p>
				<a href="/" class="btn secondary">Back to homepage</a>
			</div>
		{:else if data.state === 'already_verified'}
			<div class="card outcome" role="status">
				<h1 class="outcome-title">Already confirmed</h1>
				<p>This e-mail address was already verified — no further action is needed.</p>
				<a href="/" class="btn secondary">Back to homepage</a>
			</div>
		{:else if data.state === 'expired'}
			<div class="card outcome">
				<h1 class="outcome-title">Link expired</h1>
				<p>This verification link is no longer valid (links expire after 7 days).</p>
				<a href="/contact" class="btn">Submit again</a>
			</div>
		{:else}
			<div class="card outcome">
				<h1 class="outcome-title">Invalid link</h1>
				<p>This verification link is not valid. Double-check the link in the e-mail, or start over.</p>
				<a href="/contact" class="btn">Open the contact form</a>
			</div>
		{/if}
	</div>
</main>

<Footer />

<style>
	.verify-main {
		padding-top: 128px;
	}
	.verify-inner {
		max-width: 640px;
		margin: 0 auto;
		padding: 0 24px 96px;
	}
	.outcome-title {
		margin: 0 0 10px;
		font-family: var(--font-display);
		font-size: 28px;
		font-weight: 800;
		letter-spacing: -0.02em;
		color: var(--paper);
	}
	.outcome p {
		margin: 0 0 18px;
		line-height: 1.6;
	}
</style>
