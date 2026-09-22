<!--
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher
#
# Licensed under the PolyForm Shield License 1.0.0; you may not use
# this file except in compliance with the License. You may obtain a
# copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
#
# The software is provided "as is", without warranty or condition of
# any kind, express or implied. See the License for the specific
# language governing permissions and limitations under the License.
# A copy of the License is included in the LICENSE file at the
# repository root.
#
# Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md
-->

<!-- Feedback digest: recurring questions, criticism, corrections, and
	 requests grouped from comments — supporting evidence is the sanitized
	 excerpt only; abusive wording never reaches this page (MOD-71/72). -->

<script lang="ts">
	import Skeleton from '$lib/Skeleton.svelte';
	import { relativeTime } from '$lib/relative-time';

	let { data, form } = $props();

	const CATEGORY_LABELS: Record<string, string> = {
		question: 'Recurring questions',
		criticism: 'Substantive criticism',
		correction: 'Corrections',
		request: 'Requests'
	};

	// Findings arrive supporter-count-desc; group them under the fixed
	// category order so the page reads consistently between digests.
	const grouped = $derived(
		['question', 'criticism', 'correction', 'request']
			.map((category) => ({
				category,
				label: CATEGORY_LABELS[category],
				findings: (data.findings ?? []).filter((f) => f.category === category)
			}))
			.filter((g) => g.findings.length > 0)
	);

	// The category checkboxes: the typed union from the load becomes a plain
	// string set so includes() accepts checkbox values.
	const enabledSet = $derived(new Set<string>(data.settings?.categories ?? []));

	const newestFailed = $derived(
		(data.digests ?? []).find((d) => d.status === 'failed' && (!data.latest || d.id > data.latest.id)) ?? null
	);

	function windowLabel(digest: { windowStart: string; windowEnd: string }): string {
		const start = digest.windowStart === '1970-01-01T00:00:00.000Z' ? 'the beginning' : relativeTime(digest.windowStart);
		return `${start} → ${relativeTime(digest.windowEnd)}`;
	}
</script>

<svelte:head>
	<title>Moderaty — Feedback</title>
</svelte:head>

<!-- Accessible heading only: the shared channel header (h1) and the active
	 tab already identify this section visually. -->
<h2 class="sr-only">Feedback digest</h2>
<p class="page-sub">
	Recurring questions, criticism, corrections, and requests from your comments — abusive wording is concealed, and
	nothing here changes moderation.
</p>

{#if data.maintenance || data.digests === undefined}
	<Skeleton rows={3} />
{:else}
	{#if form?.error}<div class="error-box" role="alert">{form.error}</div>{/if}
	{#if form?.message}<div class="flash" role="status">{form.message}</div>{/if}

	{#if !data.settings.enabled}
		<div class="card">
			<p class="card-title">Feedback digest is off for this channel.</p>
			<p class="muted">
				Turn it on below and Moderaty will group your comments into recurring questions, criticism, corrections,
				and requests — without ever showing you the abusive wording.
			</p>
		</div>
	{:else}
		{#if newestFailed}
			<div class="error-box" role="alert">
				<strong>Latest digest run failed</strong> — it will retry on the next cron tick. The digest below is the last
				complete one{data.latest ? ` (window ended ${relativeTime(data.latest.windowEnd)})` : ''}.
			</div>
		{/if}

		<div class="digest-head">
			<form class="inline" method="POST" action="?/generate">
				<button class="btn small">Generate now</button>
			</form>
			{#if data.latest}
				<p class="muted">
					Window {windowLabel(data.latest)} · {data.latest.commentsClassified} classified{#if data.latest.commentsFailed}
						· {data.latest.commentsFailed} failed{/if}
				</p>
			{/if}
		</div>

		{#if data.latest}
			{#each grouped as group (group.category)}
				<section class="digest-section" aria-label={group.label}>
					<h3 class="caps-label">{group.label}</h3>
					{#each group.findings as finding (finding.id)}
						<div class="finding">
							<p class="finding-summary">{finding.summary}</p>
							{#if finding.evidence.length}
								<ul class="evidence-list">
									{#each finding.evidence as e (e.id)}
										<li class="evidence" class:concealed={e.hasAbuse === 1}>
											<blockquote class="quote">{e.sanitizedExcerpt}</blockquote>
											{#if e.hasAbuse === 1}
												<span class="caps-label concealed-label">wording concealed</span>
											{/if}
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					{/each}
				</section>
			{/each}
			{#if data.latest.pooledCount}
				<p class="muted pooled">
					Plus {data.latest.pooledCount} other comment{data.latest.pooledCount === 1 ? '' : 's'} below the evidence
					threshold — counted, but not shown as a recurring theme.
				</p>
			{/if}
			{#if !grouped.length && !data.latest.pooledCount}
				<p class="digest-empty">No recurring feedback this window — nothing met the evidence threshold.</p>
			{/if}
		{:else}
			<p class="digest-empty">
				No digest yet. The next cron tick generates one automatically — or use <strong>Generate now</strong>.
			</p>
		{/if}
	{/if}

	<section class="card settings-card" aria-label="Feedback digest settings">
		<h3 class="caps-label">Digest settings</h3>
		<form method="POST" action="?/settings" class="settings-form">
			<label class="check">
				<input type="checkbox" name="enabled" checked={data.settings.enabled} />
				Enable the feedback digest for this channel
			</label>
			<label class="field">
				<span>Generate a digest</span>
				<select name="cadence">
					<option value="weekly" selected={data.settings.cadence === 'weekly'}>Once a week</option>
					<option value="per_100" selected={data.settings.cadence === 'per_100'}>Every 100 new comments</option>
					<option value="manual" selected={data.settings.cadence === 'manual'}>Only when I click Generate now</option>
				</select>
			</label>
			<fieldset class="field categories">
				<legend>Include these categories</legend>
				{#each [['question', 'Questions'], ['criticism', 'Criticism'], ['correction', 'Corrections'], ['request', 'Requests']] as [value, label] (value)}
					<label class="check">
						<input type="checkbox" name="category" {value} checked={enabledSet.has(value)} />
						{label}
					</label>
				{/each}
			</fieldset>
			<label class="field">
				<span>Minimum supporters before a theme becomes a finding</span>
				<input type="number" name="threshold" min="2" max="10" value={data.settings.threshold} />
			</label>
			<label class="check">
				<input type="checkbox" name="email" checked={data.settings.email} />
				E-mail me each new digest
			</label>
			<button class="btn small">Save settings</button>
		</form>
	</section>

	{#if data.digests.length > 1}
		<section class="history" aria-label="Digest history">
			<h3 class="caps-label">Recent digests</h3>
			<ul class="history-list">
				{#each data.digests as d (d.id)}
					<li class="muted">
						{relativeTime(d.createdAt)} — {d.status}{#if d.status === 'complete'}
							, {d.commentsClassified} classified{#if d.pooledCount}, {d.pooledCount} pooled{/if}{/if}{#if d.status === 'failed'}
							({d.error ?? 'error'}){/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
{/if}

<style>
	.digest-head {
		display: flex;
		align-items: center;
		gap: 16px;
		margin-bottom: 28px;
	}
	.digest-head p {
		margin: 0;
	}
	.digest-section {
		margin-bottom: 32px;
	}
	.digest-section h3 {
		margin: 0 0 12px;
	}
	.finding {
		padding: 16px 4px;
		border-bottom: 1px solid var(--line);
	}
	.finding-summary {
		margin: 0 0 10px;
		font-weight: 600;
	}
	.evidence-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.evidence .quote {
		margin: 0;
	}
	.concealed .quote {
		opacity: 0.75;
		font-style: italic;
	}
	.concealed-label {
		display: inline-block;
		margin-top: 4px;
		color: var(--text-3);
	}
	.pooled {
		margin: 20px 0 0;
	}
	.digest-empty {
		margin: 0;
		padding: 40px 0;
		font-size: 14px;
		color: var(--text-2);
	}
	.card {
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 20px;
		margin-bottom: 24px;
	}
	.card-title {
		margin: 0 0 8px;
		font-weight: 600;
	}
	.settings-card h3 {
		margin: 0 0 16px;
	}
	.settings-form {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 14px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: 14px;
		max-width: 360px;
	}
	.field select,
	.field input[type='number'] {
		font: inherit;
		padding: 6px 8px;
		background: var(--bg);
		color: var(--text);
		border: 1px solid var(--line);
		border-radius: 6px;
	}
	fieldset.categories {
		border: 0;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	fieldset.categories legend {
		font-size: 14px;
		padding: 0;
		margin-bottom: 4px;
	}
	.history {
		margin-top: 32px;
	}
	.history h3 {
		margin: 0 0 12px;
	}
	.history-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: 13px;
	}
</style>
