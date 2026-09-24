<script lang="ts">
	import { enhance } from '$app/forms';

	let { data } = $props();
</script>

<svelte:head>
	<title>Moderaty — Team invite</title>
</svelte:head>

<h1>Team invite</h1>

{#if data.invite.expired || data.invite.accepted}
	<p class="error-box" role="alert">This invite link is no longer valid — ask for a new one.</p>
{:else if !data.signedIn}
	<div class="card">
		<p>
			You've been invited to join <strong>{data.invite.orgName}</strong> as
			<span class="badge neutral">{data.invite.role}</span>. Sign in with Google, then reopen this link to
			join.
		</p>
		<a class="btn" href="/login">Sign in with Google</a>
	</div>
{:else}
	<div class="card">
		<p>
			You've been invited to join <strong>{data.invite.orgName}</strong> as
			<span class="badge neutral">{data.invite.role}</span>.
		</p>
		<form method="POST" use:enhance>
			<button class="btn" type="submit">Join {data.invite.orgName}</button>
		</form>
	</div>
{/if}
