<script lang="ts">
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { t } from '$lib/i18n/messages';

	let { data } = $props();
</script>

<svelte:head>
	<title>{t(data.locale, 'signInTitle')}</title>
</svelte:head>

<!-- This page is fully translated — it may offer the selector (MOD-11). -->
<div class="switcher-bar"><LanguageSwitcher locale={data.locale} /></div>
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
	/* Out of flow so the 100vh main below stays exactly one viewport tall. */
	.switcher-bar {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
	}
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
		margin-top: 16px;
	}
</style>
