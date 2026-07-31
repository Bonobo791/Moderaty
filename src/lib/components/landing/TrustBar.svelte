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
	const SIGNALS = ['YouTube Data API', 'OpenAI Moderation', 'Open source on GitHub'];
</script>

<section class="trust">
	<div class="trust-inner">
		<ul class="signals">
			{#each SIGNALS as s}
				<li class="signal">{s}</li>
			{/each}
		</ul>
		<p class="microcopy">
			Google asks for comment access only. Free and open source (AGPL). Dry-run mode proves it
			before anything changes.
		</p>
	</div>
</section>

<style>
	.trust {
		border-top: 1px solid var(--line);
		border-bottom: 1px solid var(--line);
	}
	.trust-inner {
		max-width: 1152px;
		margin: 0 auto;
		padding: 32px 24px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 20px;
	}
	.signals {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 8px 24px;
		opacity: 0.6;
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.signal {
		font-family: var(--font-mono);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: rgb(244 244 248 / 0.8);
	}
	.microcopy {
		max-width: 52ch;
		text-align: center;
		font-family: var(--font-mono);
		font-size: 11px;
		text-transform: uppercase;
		line-height: 1.6;
		letter-spacing: 0.14em;
		color: rgb(244 244 248 / 0.5);
		margin: 0;
	}
	@media (min-width: 768px) {
		.trust-inner {
			flex-direction: row;
			justify-content: space-between;
		}
		.microcopy {
			text-align: right;
		}
	}
</style>
