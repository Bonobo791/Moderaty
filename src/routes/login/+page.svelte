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
	import { t } from '$lib/i18n/messages';

	let { data } = $props();
</script>

<svelte:head>
	<title>{t(data.locale, 'signInTitle')}</title>
</svelte:head>

<!-- Static sign-in prompt; the guard redirect lives in +page.server.ts. -->
<main class="login-main">
	<div class="card login-card">
		<h1>{t(data.locale, 'signInTitle')}</h1>
		<p class="muted">
			{t(data.locale, 'signInDescription')}
		</p>
		<a class="btn" href="/api/auth/google/login">{t(data.locale, 'signInGoogle')}</a>
	</div>
</main>

<style>
	.login-main {
		display: grid;
		place-items: center;
		min-height: 100vh;
		padding: 24px;
	}
	.login-card {
		max-width: 420px;
		text-align: center;
	}
	.login-card .btn {
		display: inline-block;
		margin-top: 16px;
	}
</style>
