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

<svelte:head>
	<title>Moderaty — Help</title>
</svelte:head>

<h1>Help</h1>
<p class="page-sub">How Moderaty moderates, and what you can take back.</p>

<div class="card">
	<h2>How it works</h2>
	<p>
		Moderaty scans new comments on your connected YouTube channels, scores them against your
		rules and sensitivity setting, and acts: hold for review, reject, delete, or ban the author.
		Uncertain comments land in the channel's review queue instead — nothing there is public yet.
	</p>
</div>

<div class="card">
	<h2>The audit log</h2>
	<p>
		Every moderation action, automatic or manual, is recorded in the channel's audit log
		(newest first, with the reason and who decided it — rule, AI, or you).
	</p>
</div>

<div class="card">
	<h2>What you can undo</h2>
	<table class="stack-table">
		<thead>
			<tr><th>Action</th><th>Reversible?</th></tr>
		</thead>
		<tbody>
			<tr>
				<td data-label="Action"><span class="badge attention">hold</span></td>
				<td data-label="Reversible?">Yes — Undo on the audit log restores the comment.</td>
			</tr>
			<tr>
				<td data-label="Action"><span class="badge danger">reject</span></td>
				<td data-label="Reversible?">Yes — Undo on the audit log restores the comment.</td>
			</tr>
			<tr>
				<td data-label="Action"><span class="badge danger">ban</span></td>
				<td data-label="Reversible?">
					Partly — Undo restores the comment, but author bans cannot be lifted, reversed, or
					undone: YouTube provides no way to un-ban an author through its API.
				</td>
			</tr>
			<tr>
				<td data-label="Action"><span class="badge danger">delete</span></td>
				<td data-label="Reversible?">
					No — deleted comments cannot be restored, reversed, or undone. Deletion is
					permanent.
				</td>
			</tr>
		</tbody>
	</table>
	<p class="muted">This matches Section 9.4 of the <a href="/terms">Terms of Service</a>.</p>
</div>
