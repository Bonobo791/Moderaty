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
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { t } from '$lib/i18n/messages';

	let { data } = $props();
</script>

<svelte:head>
	<title>{t(data.locale, 'accountDeletedTitle')}</title>
</svelte:head>

<!-- This page is fully translated — it may offer the selector (MOD-11). -->
<div class="switcher-bar"><LanguageSwitcher locale={data.locale} /></div>
<!-- Static confirmation; the session is already erased, so this page is public. -->
<main class="deleted-main">
	<div class="card deleted-card">
		<h1>{t(data.locale, 'accountDeletedTitle')}</h1>
		<p class="muted">
			{t(data.locale, 'accountDeletedBody')}
		</p>
		<a class="btn" href="/">{t(data.locale, 'accountDeletedBackHome')}</a>
	</div>
</main>

<style>
	/* Out of flow so the 100vh main below stays exactly one viewport tall. */
	.switcher-bar {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
	}
	.deleted-main {
		display: grid;
		place-items: center;
		min-height: 100vh;
		padding: 24px;
	}
	.deleted-card {
		max-width: 420px;
		text-align: center;
	}
	.deleted-card .btn {
		display: inline-block;
		margin-top: 16px;
	}
</style>
