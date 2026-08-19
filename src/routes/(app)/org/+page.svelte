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

Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
-->

<script lang="ts">
	import { enhance } from '$app/forms';
	import EmptyState from '$lib/EmptyState.svelte';

	let { data, form } = $props();

	const isOwner = $derived(data.user?.orgRole === 'owner');
	const isAdminUp = $derived(data.user?.orgRole === 'owner' || data.user?.orgRole === 'admin');
</script>

<svelte:head>
	<title>Moderaty — Team</title>
</svelte:head>

<h1>Team</h1>
<p class="page-sub">
	{data.user?.orgName} — your role: <span class="badge neutral">{data.user?.orgRole}</span>
</p>

{#if form?.error}
	<p class="error-box" role="alert">{form.error}</p>
{/if}

{#if isAdminUp}
	<div class="card">
		<h2 style="margin-top:0">Rename team</h2>
		<form method="POST" action="?/rename" use:enhance>
			<label for="team-name">Team name</label>
			<input id="team-name" type="text" name="name" value={data.user?.orgName} maxlength="80" required />
			<button class="btn secondary small" type="submit">Rename team</button>
		</form>
	</div>
{/if}

<div class="card">
	<h2 style="margin-top:0">Members</h2>
	<table class="stack-table">
		<thead>
			<tr><th>Name</th><th>Role</th><th>Actions</th></tr>
		</thead>
		<tbody>
			{#each data.members as member (member.userId)}
				<tr>
					<td data-label="Name">
						{member.displayName}
						{#if member.isYou}<span class="badge ok">You</span>{/if}
					</td>
					<td data-label="Role"><span class="badge neutral">{member.role}</span></td>
					<td data-label="Actions">
						{#if isOwner && !member.isYou}
							<form method="POST" action="?/setRole" use:enhance>
								<input type="hidden" name="userId" value={member.userId} />
								<label for="role-{member.userId}">Role for {member.displayName}</label>
								<select id="role-{member.userId}" name="role">
									<option value="owner" selected={member.role === 'owner'}>owner</option>
									<option value="admin" selected={member.role === 'admin'}>admin</option>
									<option value="member" selected={member.role === 'member'}>member</option>
								</select>
								<button class="btn secondary small" type="submit">Change role for {member.displayName}</button>
							</form>
						{/if}
						{#if !member.isYou && member.role !== 'owner' && (isOwner || (data.user?.orgRole === 'admin' && member.role === 'member'))}
							<form method="POST" action="?/remove" use:enhance>
								<input type="hidden" name="userId" value={member.userId} />
								<button class="btn secondary small" type="submit">Remove {member.displayName} from team</button>
							</form>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

{#if isAdminUp}
	<div class="card">
		<h2 style="margin-top:0">Invite a teammate</h2>
		<form method="POST" action="?/invite" use:enhance>
			<label for="invite-role">Role for invite</label>
			<select id="invite-role" name="role">
				<option value="member" selected>member</option>
				<option value="admin">admin</option>
			</select>
			<button class="btn secondary small" type="submit">Create invite link</button>
		</form>
		{#if form?.inviteToken}
			<label for="invite-url">Invite link (works once, expires in 7 days)</label>
			<input id="invite-url" type="text" readonly value="{data.inviteBase}{form.inviteToken}" />
		{/if}
		<h3>Open invite links</h3>
		{#each data.invites as invite (invite.token)}
			{@const expires = new Date(invite.expiresAt).toLocaleDateString()}
			<p>
				<span class="badge neutral">{invite.role}</span>
				<span class="muted">expires {expires}</span>
			</p>
			<form method="POST" action="?/revokeInvite" use:enhance>
				<input type="hidden" name="token" value={invite.token} />
				<button class="btn secondary small" type="submit">Revoke the {invite.role} invite link expiring {expires}</button>
			</form>
		{:else}
			<EmptyState title="No open invite links" />
		{/each}
	</div>
{/if}

<div class="card">
	<h2 style="margin-top:0">Create another team</h2>
	<form method="POST" action="?/createTeam" use:enhance>
		<label for="new-team-name">New team name</label>
		<input id="new-team-name" type="text" name="name" maxlength="80" required />
		<button class="btn secondary small" type="submit">Create team</button>
	</form>
</div>

<div class="card">
	<h2 style="margin-top:0">Leave team</h2>
	<p class="muted">Owners must promote a teammate before leaving.</p>
	<form method="POST" action="?/leave" use:enhance>
		<button class="btn danger" type="submit">Leave team</button>
	</form>
</div>
