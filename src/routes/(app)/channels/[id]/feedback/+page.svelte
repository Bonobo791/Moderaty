<!-- Feedback digest: recurring questions, criticism, corrections, and
	 requests grouped from comments — supporting evidence is the sanitized
	 excerpt only; abusive wording never reaches this page (MOD-71/72). -->

<script lang="ts">
	import { enhance } from '$app/forms';
	import EmptyState from '$lib/EmptyState.svelte';
	import Skeleton from '$lib/Skeleton.svelte';
	import { relativeTime } from '$lib/relative-time';

	let { data, form } = $props();

	// In-flight guard for Generate now — a double-submit would race the
	// lease claim into a spurious 409 and could spend twice before it lands.
	let generating = $state(false);

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

	// The newest row that is not a successful digest — 'failed' or a
	// 'deferred' row the job records when it cannot run (out of credits /
	// budget gone). Anything older than the latest complete digest is stale.
	const newestAttention = $derived(
		(data.digests ?? []).find((d) => d.status !== 'complete' && (!data.latest || d.id > data.latest.id)) ?? null
	);
	const canOperate = $derived(data.orgRole === 'owner');

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
		{#if newestAttention?.status === 'failed'}
			<div class="error-box" role="alert">
				<strong>Latest digest run failed</strong> —
				{data.settings.cadence === 'manual'
					? 'use Generate now to retry.'
					: 'it will retry on the next cron tick.'}
				{data.latest
					? `The digest below is the last complete one (window ended ${relativeTime(data.latest.windowEnd)}).`
					: 'No complete digest exists yet.'}
			</div>
		{:else if newestAttention?.status === 'deferred'}
			<div class="error-box" role="alert">
				<strong>Latest digest run deferred</strong> —
				{newestAttention.error === 'credits'
					? 'the organization is out of credits. Top up on the Usage page and it will retry on the next cron tick.'
					: 'it ran out of time and will retry on the next cron tick.'}
				{data.latest
					? `The digest below is the last complete one (window ended ${relativeTime(data.latest.windowEnd)}).`
					: 'No complete digest exists yet.'}
			</div>
		{/if}

		<div class="digest-head">
			{#if canOperate}
				<form
					class="inline"
					method="POST"
					action="?/generate"
					use:enhance={() => {
						generating = true;
						return async ({ update }) => {
							await update();
							generating = false;
						};
					}}
				>
					<button class="btn small" disabled={generating}>
						{generating ? 'Generating…' : 'Generate now'}
					</button>
				</form>
			{/if}
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
					Plus {data.latest.pooledCount} other comment{data.latest.pooledCount === 1 ? '' : 's'} — below the
					minimum-comments threshold or in a category you turned off — counted, but not shown as a
					recurring theme.
				</p>
			{/if}
			{#if !grouped.length && !data.latest.pooledCount}
				<EmptyState
					title="No recurring feedback this window"
					hint="Nothing met the minimum-comments threshold — below-threshold feedback would show as the pooled count."
				/>
			{/if}
		{:else if !newestAttention}
			<EmptyState
				title="No digest yet"
				hint={!canOperate
					? data.settings.cadence === 'manual'
						? 'Manual cadence — an owner runs it with Generate now.'
						: 'The next cron tick generates one automatically.'
					: data.settings.cadence === 'manual'
						? 'Manual cadence — use Generate now to run the first one.'
						: 'The next cron tick generates one automatically — or use Generate now.'}
			/>
		{/if}
	{/if}

	<section class="card settings-card" aria-label="Feedback digest settings">
		<h3 class="caps-label">Digest settings</h3>
		{#if canOperate}
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
					<span>Minimum comments reporting a theme before it becomes a finding</span>
					<input type="number" name="threshold" min="2" max="10" value={data.settings.threshold} />
				</label>
				<p class="muted settings-note">
					On metered plans each comment the digest processes spends one credit — the run defers when
					credits run out.
				</p>
				<button class="btn small">Save settings</button>
			</form>
		{:else}
			<!-- Read-only for members/admins: the actions are owner-only, so
			     rendering the editable form would just throw a 403 error page. -->
			<ul class="settings-readonly muted">
				<li>Enabled: {data.settings.enabled ? 'yes' : 'no'}</li>
				<li>
					Cadence: {data.settings.cadence === 'weekly'
						? 'Once a week'
						: data.settings.cadence === 'per_100'
							? 'Every 100 new comments'
							: 'Manual'}
				</li>
				<li>Categories: {data.settings.categories.join(', ')}</li>
				<li>Minimum comments per finding: {data.settings.threshold}</li>
			</ul>
			<p class="muted settings-note">Only an organization owner can change these.</p>
		{/if}
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
	.settings-note {
		margin: 0;
		font-size: 13px;
	}
	.settings-readonly {
		margin: 0 0 12px;
		padding-left: 18px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 14px;
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
