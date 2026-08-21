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
			Google asks for standard YouTube access, used only on your comments. Free and open source (PolyForm Shield). Dry-run mode proves it
			before anything changes. We keep no data on you beyond what your account needs to run, and nothing after you leave that
			the LGPD does not require.
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
