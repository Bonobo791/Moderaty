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
	let { data, form } = $props();
</script>

<svelte:head>
	<title>Moderaty — Choose a channel</title>
</svelte:head>

<main class="pick-main">
	<div class="card pick-card">
		<h1>Choose a channel</h1>
		<p class="muted">This Google account owns several YouTube channels. Pick the one Moderaty should moderate.</p>

		{#if form?.error}
			<p class="error-box" role="alert">{form.error}</p>
		{/if}

		<form method="POST">
			<fieldset>
				<legend>Your channels</legend>
				{#each data.channels as channel (channel.id)}
					<label class="check">
						<input type="radio" name="channel" value={channel.id} required />
						<span>{channel.title}</span>
					</label>
				{/each}
			</fieldset>
			<button class="btn" type="submit">Connect selected channel</button>
		</form>
	</div>
</main>

<style>
	.pick-main {
		display: grid;
		place-items: center;
		min-height: 100vh;
		padding: 24px;
	}
	.pick-card {
		max-width: 460px;
	}
	.pick-card form {
		display: grid;
		gap: 14px;
		margin-top: 16px;
	}
	.pick-card fieldset {
		display: grid;
		gap: 10px;
		border: none;
		padding: 0;
		margin: 0;
	}
	.pick-card legend {
		font-weight: 600;
		margin-bottom: 8px;
	}
</style>
