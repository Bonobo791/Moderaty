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
	import Nav from '$lib/components/landing/Nav.svelte';
	import Footer from '$lib/components/landing/Footer.svelte';

	// data.optInText is CONTACT_OPT_IN_TEXT itself — the exact sentence logged
	// verbatim on the submission row, so the visible box can never drift from
	// what was agreed. form.values re-populates the fields after a validation
	// error (I12: the error state renders the form, never a blank page).
	//
	// I12 exception (same as the static marketing routes): this page has no
	// client-side data loading — SSR renders the populated form (or the
	// ?sent=1 success state) and validation failures re-render the form with
	// the .error-box, so loading/empty skeletons cannot occur.
	let { data, form } = $props();
</script>

<svelte:head>
	<title>Contact Moderaty</title>
	<meta
		name="description"
		content="Contact Moderaty. Tell us what you need — a license question, a feature idea, or support. Leave your name and e-mail and confirm your address in one click."
	/>
</svelte:head>

<Nav />

<main class="contact-main">
	<div class="contact-inner">
		<h1 class="title">Contact Moderaty</h1>
		<p class="lede">
			License questions, support, feature ideas — whatever you need. Leave your name and e-mail,
			tick the opt-in box, and confirm your address with one click from the e-mail we send you.
		</p>

		{#if data.sent}
			<div class="card success" role="status">
				<h2 class="success-title">Check your inbox</h2>
				<p>
					We sent a one-time verification link to the address you entered. Open it to confirm
					your e-mail and complete your contact request. The link is valid for 7 days.
				</p>
				<p class="success-note">
					Didn't get it? Check the spam folder, or submit the form again — we will resend the
					verification e-mail to the same address.
				</p>
				<a href="/" class="btn secondary">Back to homepage</a>
			</div>
		{:else}
			<form method="POST" class="card contact-form">
				{#if form?.error}
					<p class="error-box" role="alert">{form.error}</p>
				{/if}

				<label class="field" for="contact-name">Name</label>
				<input
					id="contact-name"
					name="name"
					type="text"
					autocomplete="name"
					maxlength="200"
					placeholder="Your name"
					value={form?.values?.name ?? ''}
					required
				/>

				<label class="field" for="contact-email">E-mail</label>
				<input
					id="contact-email"
					name="email"
					type="email"
					autocomplete="email"
					maxlength="254"
					placeholder="you@example.com"
					value={form?.values?.email ?? ''}
					required
				/>

				<label class="check" for="contact-opt-in">
					<input id="contact-opt-in" name="opt_in" type="checkbox" required />
					<span>{data.optInText}</span>
				</label>

				<button class="btn" type="submit">Send verification e-mail</button>
				<p class="microcopy">
					Your name and e-mail are stored only after you confirm the opt-in above, and only so we
					can reply to your request.
				</p>
			</form>
		{/if}
	</div>
</main>

<Footer />

<style>
	.contact-main {
		padding-top: 128px;
	}
	.contact-inner {
		max-width: 640px;
		margin: 0 auto;
		padding: 0 24px 96px;
	}
	.title {
		font-family: var(--font-display);
		font-size: 40px;
		font-weight: 800;
		line-height: 1.05;
		letter-spacing: -0.02em;
		color: var(--paper);
		margin: 0;
	}
	.lede {
		margin: 16px 0 32px;
		max-width: 52ch;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.6);
	}
	.contact-form {
		display: grid;
		gap: 10px;
		margin-bottom: 0;
	}
	.field {
		margin-top: 8px;
		font-family: var(--font-mono);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: rgb(244 244 248 / 0.55);
	}
	.contact-form input[type='text'],
	.contact-form input[type='email'] {
		width: 100%;
		box-sizing: border-box;
	}
	.check {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		margin-top: 14px;
		font-size: 14px;
		line-height: 1.5;
	}
	.check input {
		margin-top: 3px;
		flex-shrink: 0;
	}
	.contact-form .btn {
		justify-self: start;
		margin-top: 18px;
	}
	.microcopy {
		margin: 14px 0 0;
		font-size: 12px;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.45);
	}
	.success-title {
		margin: 0 0 10px;
		font-family: var(--font-display);
		font-size: 24px;
		font-weight: 700;
		color: var(--paper);
	}
	.success p {
		margin: 0 0 12px;
		line-height: 1.6;
	}
	.success-note {
		font-size: 13px;
		color: rgb(244 244 248 / 0.6);
	}
	.success .btn {
		margin-top: 8px;
	}
</style>
