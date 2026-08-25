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
	import Ticker from '$lib/Ticker.svelte';
	import { relativeTime } from '$lib/relative-time';

	let { data, children } = $props();

	const base = $derived(`/channels/${data.ch.id}`);
	const tabs = $derived([
		{ key: 'overview', label: 'Overview', href: base },
		{ key: 'rules', label: 'Rules', href: `${base}/rules` },
		{ key: 'queue', label: `Review queue (${data.pending})`, href: `${base}/queue` },
		{ key: 'log', label: 'Audit log', href: `${base}/log` }
	]);

	// ARIA tablist keyboard pattern: Arrow keys move focus between tabs
	// (manual activation — Enter follows the link, since tabs are routes).
	function onTabKeydown(event: KeyboardEvent) {
		if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
		const current = event.currentTarget as HTMLAnchorElement;
		const links = Array.from(
			current.closest('[role="tablist"]')!.querySelectorAll<HTMLAnchorElement>('[role="tab"]')
		);
		const index = links.indexOf(current);
		if (index === -1) return;
		event.preventDefault();
		const next = event.key === 'ArrowRight' ? index + 1 : index - 1;
		links[(next + links.length) % links.length].focus();
	}
</script>

{#if data.maintenance}
	<!-- Mid-load outage: the (app) overlay only triggers on ITS layout data,
		so a channel-shell query that failed after a healthy shell load renders
		its own state instead of an empty header (I12). -->
	<div class="error-box" role="alert">
		<strong>Maintenance</strong> — Moderaty is temporarily unable to reach its database.
		Nothing on this page will work right now; try again in a minute.
	</div>
{:else}
	<header class="channel-header">
		<a class="link-u caps-label back-link" href="/dashboard">← Back to channels</a>
		<div class="channel-headline">
			<div class="channel-identity">
				<h1>{data.ch.title}</h1>
				<p class="mono channel-sub">
					ID: {data.ch.id} · Last checked {data.ch.lastRunAt ? relativeTime(data.ch.lastRunAt) : 'never'}
				</p>
			</div>
			<div class="channel-status">
				<div class="protected">
					<span class="caps-label protected-label">Protected</span>
					<span class="protected-sub">
						{#if data.pending > 0}
							<a href="{base}/queue">{data.pending} comment{data.pending === 1 ? '' : 's'} waiting for review</a>
						{:else}
							queue is clear
						{/if}
					</span>
				</div>
				<div class="banned">
					<span class="banned-count"><Ticker value={data.banned} /></span>
					<span class="caps-label banned-label">Edge lords banned</span>
				</div>
			</div>
		</div>
	</header>

	<div class="tab-bar" role="tablist" aria-label="Channel sections">
		{#each tabs as tab (tab.key)}
			<a
				class="tab"
				class:active={data.tab === tab.key}
				role="tab"
				aria-selected={data.tab === tab.key}
				href={tab.href}
				onkeydown={onTabKeydown}>{tab.label}</a
			>
		{/each}
	</div>

	{@render children()}
{/if}

<style>
	.channel-header {
		margin-bottom: 8px;
	}
	.back-link {
		display: inline-block;
		margin-bottom: 20px;
		text-transform: uppercase;
	}
	.channel-headline {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 24px;
		flex-wrap: wrap;
	}
	.channel-identity h1 {
		font-size: 44px;
		font-weight: 600;
		line-height: 1.05;
		margin: 0 0 10px;
	}
	.channel-sub {
		color: var(--text-3);
		font-size: 12px;
		margin: 0;
	}
	.channel-status {
		display: flex;
		align-items: flex-end;
		gap: 40px;
		text-align: right;
	}
	.protected {
		display: flex;
		flex-direction: column;
		gap: 6px;
		align-items: flex-end;
	}
	.protected-label {
		color: var(--ok);
	}
	.protected-sub {
		font-size: 13px;
		color: var(--text-2);
	}
	.banned {
		display: flex;
		flex-direction: column;
		gap: 6px;
		align-items: flex-end;
	}
	.banned-count {
		font-size: 32px;
		line-height: 1;
		color: var(--accent);
	}
	.banned-label {
		color: var(--text-3);
	}
	.tab-bar {
		display: flex;
		gap: 28px;
		border-bottom: 1px solid var(--line);
		margin: 28px 0 32px;
	}
	.tab {
		padding: 0 2px 12px;
		font-size: 13px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-2);
		text-decoration: none;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		transition:
			color 150ms var(--ease-out),
			border-color 150ms var(--ease-out);
	}
	.tab:hover {
		color: var(--text);
	}
	.tab.active {
		color: var(--text);
		border-bottom-color: var(--accent);
	}
</style>
