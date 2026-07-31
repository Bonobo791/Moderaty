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
	<title>Moderaty — Sign in</title>
</svelte:head>

<main class="login-main">
	<div class="card login-card">
		<h1>Sign in to Moderaty</h1>
		<p class="muted">
			Sign in with your Google account, then connect your YouTube channel to start moderating
			comments automatically.
		</p>
		<a class="btn" href="/api/auth/google/login">Sign in with Google</a>
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
