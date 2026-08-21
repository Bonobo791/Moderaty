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
