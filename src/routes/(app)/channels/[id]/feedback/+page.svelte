<!-- Feedback digest: recurring questions, criticism, corrections, and
	 requests grouped from comments — supporting evidence stays concealed
	 unless a viewer explicitly reveals the original for this visit (MOD-71/72). -->

<script lang="ts">
	import { enhance } from '$app/forms';
	import EmptyState from '$lib/EmptyState.svelte';
	import Skeleton from '$lib/Skeleton.svelte';
	import { autoRefresh } from '$lib/auto-refresh.svelte';
	import { HISTORY_MONTH_PRESETS } from '$lib/historyWindow';
	import { relativeTime } from '$lib/relative-time';
	import type { FeedbackPreview } from '$lib/server/feedbackDigest';

	let { data, form } = $props();
	autoRefresh();
	const feedbackDryRunForm = $derived(
		form as { scope?: string; ok?: boolean; attempted?: boolean; dryRunUsed?: boolean; preview?: FeedbackPreview; message?: string; error?: string } | null | undefined
	);
	const feedbackPreviewUsed = $derived(
		data.dryRunUsed ||
			(feedbackDryRunForm?.scope === 'feedbackDryRun' && (feedbackDryRunForm.attempted === true || feedbackDryRunForm.dryRunUsed === true))
	);
	const feedbackPreview = $derived(
		feedbackDryRunForm?.scope === 'feedbackDryRun' && feedbackDryRunForm.ok ? feedbackDryRunForm.preview ?? null : null
	);
	const revealForm = $derived(
		form as { scope?: string; evidenceId?: number; text?: string; error?: string; confirmationRequired?: boolean } | null | undefined
	);

	// In-flight guard for Generate now — a double-submit would race the
	// lease claim into a spurious 409 and could spend twice before it lands.
	let generating = $state(false);
	let analyzingHistory = $state(false);
	let previewingFeedback = $state(false);
	let revealedEvidence = $state<Record<number, string>>({});
	let hiddenEvidence = $state<Record<number, boolean>>({});
	let revealErrors = $state<Record<number, string>>({});

	function withoutKey<T>(record: Record<number, T>, id: number): Record<number, T> {
		const { [id]: removed, ...rest } = record;
		void removed;
		return rest;
	}

	function hideOriginal(id: number): void {
		revealedEvidence = withoutKey(revealedEvidence, id);
		hiddenEvidence = { ...hiddenEvidence, [id]: true };
		revealErrors = withoutKey(revealErrors, id);
	}

	const HISTORY_WINDOWS = HISTORY_MONTH_PRESETS.map((months) => ({
		value: String(months),
		label: months === 1 ? '1 month' : `${months} months`
	}));

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
	{#if form?.scope !== 'reveal' && form?.error}
		<div class="error-box" role="alert">
			{form.error}
			{#if form && 'historyAccess' in form && form.historyAccess === 'purchase'}
				<a href="/usage">View plans and credits</a>
			{:else if form && 'historyAccess' in form && form.historyAccess === 'key'}
				<a href="/org">OpenAI key setup on the Team page</a>
			{/if}
		</div>
	{/if}
	{#if form?.scope !== 'reveal' && form?.message}<div class="flash" role="status">{form.message}</div>{/if}

	<div class="credit-notice" role="note">
		<strong>Feedback uses 1 credit per comment processed on metered plans, in addition to moderation. Historical analysis uses the same credits. Your one free feedback dry run uses no credits.</strong>
		<p>Lifetime-plan and self-hosted unmetered accounts are not charged credits.</p>
	</div>
	{#if data.history.active}
		<div class="flash history-status" role="status">
			{#if !data.ch.active || !data.settings.enabled}
				Historical feedback analysis is paused while this channel is paused or feedback is turned off. Re-enable both to resume the saved checkpoint.
			{:else}
				Historical feedback analysis is continuing in the background under cron, including on manual digest cadence.
			{/if}
		</div>
	{/if}

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
				{data.history.active
					? 'historical analysis continues on the next cron tick.'
					: data.settings.cadence === 'manual'
						? 'use Generate now to retry.'
						: 'it will retry on the next cron tick.'}
				{data.latest
					? `The digest below is the last complete one (window ended ${relativeTime(data.latest.windowEnd)}).`
					: 'No complete digest exists yet.'}
			</div>
		{:else if newestAttention?.status === 'deferred'}
			<div class="error-box" role="alert">
				<strong>Latest digest run deferred</strong> —
				{#if data.history.active}
					{#if newestAttention.error === 'credits'}
						There are not enough credits for this batch. <a href="/usage">Add credits on the Usage page; historical analysis retries automatically.</a>
					{:else if newestAttention.error === 'deadline'}
						The time limit was reached. Historical analysis retries on the next cron tick.
					{:else}
						Historical analysis retries on the next cron tick.
					{/if}
				{:else if newestAttention.error === 'credits'}
					{#if data.settings.cadence === 'manual'}
						There are not enough credits for this batch. <a href="/usage">Add credits on the Usage page</a>, then use Generate now.
					{:else}
						There are not enough credits for this batch. <a href="/usage">Add credits on the Usage page</a>; it retries on the next cron tick.
					{/if}
				{:else if data.settings.cadence === 'manual'}
					The time limit was reached. Use Generate now to retry.
				{:else}
					The time limit was reached and will retry on the next cron tick.
				{/if}
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
						· {data.latest.commentsFailed} failed{/if} · {data.latest.creditsUsed === null ? 'unmetered' : `${data.latest.creditsUsed} credits used`} · generated {relativeTime(data.latest.createdAt)}
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
								<details
									class="evidence-details"
									open={revealForm?.scope === 'reveal' && finding.evidence.some((e) => e.id === revealForm.evidenceId)}
								>
									<summary>
										Show {finding.evidence.length} supporting comment{finding.evidence.length === 1 ? '' : 's'}<span class="sr-only"> for “{finding.summary}”</span>
									</summary>
									<ul class="evidence-list">
										{#each finding.evidence as e, i (e.id)}
											{@const serverOriginal = revealForm?.scope === 'reveal' && revealForm.evidenceId === e.id && revealForm.text ? revealForm.text : undefined}
											{@const original = revealedEvidence[e.id] ?? (hiddenEvidence[e.id] ? undefined : serverOriginal)}
											{@const serverError = revealForm?.scope === 'reveal' && revealForm.evidenceId === e.id && revealForm.error ? revealForm.error : undefined}
											{@const revealError = revealErrors[e.id] ?? serverError}
											{@const confirmationRequired = revealForm?.scope === 'reveal' && revealForm.evidenceId === e.id && revealForm.confirmationRequired === true}
											<li class="evidence" class:concealed={e.hasAbuse === 1 && !original}>
												<blockquote class="quote">{original ?? e.sanitizedExcerpt}</blockquote>
												{#if confirmationRequired && e.hasAbuse === 1}
													<p class="muted reveal-warning">This comment contains abusive wording. Show it anyway?</p>
													<form class="reveal-form" method="POST" action="?/reveal">
														<input type="hidden" name="evidenceId" value={e.id} />
														<input type="hidden" name="confirmedAbuse" value="yes" />
														<button
															class="btn secondary small"
															aria-label={`Show abusive original comment ${i + 1} for “${finding.summary}”`}
														>Show the abusive comment</button>
													</form>
												{:else if original !== undefined}
													<button
														class="btn secondary small reveal-button"
														type="button"
														aria-label={`Hide original comment ${i + 1} for “${finding.summary}”`}
														onclick={() => hideOriginal(e.id)}
													>Hide original</button>
												{:else}
													{#if e.hasAbuse === 1}
														<span class="caps-label concealed-label">wording concealed</span>
													{/if}
													<form
														class="reveal-form"
														method="POST"
														action="?/reveal"
														use:enhance={({ cancel, formData }) => {
															if (e.hasAbuse === 1) {
																if (!confirm('This comment contains abusive wording. Show it anyway?')) {
																	cancel();
																	return;
																}
																formData.set('confirmedAbuse', 'yes');
															}
															revealErrors = withoutKey(revealErrors, e.id);
															return async ({ result }) => {
																if (
																	result.type === 'success' &&
																	result.data?.evidenceId === e.id &&
																	typeof result.data.text === 'string'
																) {
																	revealedEvidence = { ...revealedEvidence, [e.id]: result.data.text };
																	hiddenEvidence = withoutKey(hiddenEvidence, e.id);
																	return;
																}
																const message =
																	result.type === 'failure' && typeof result.data?.error === 'string'
																		? result.data.error
																		: 'The original comment could not be shown.';
																revealErrors = { ...revealErrors, [e.id]: message };
															};
														}}
													>
														<input type="hidden" name="evidenceId" value={e.id} />
														<button
															class="btn secondary small"
															aria-label={`Show original comment ${i + 1} for “${finding.summary}”`}
														>Show original comment</button>
													</form>
												{/if}
												{#if revealError}
													<div class="error-box reveal-error" role="alert">{revealError}</div>
												{/if}
											</li>
										{/each}
									</ul>
								</details>
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

	<section class="card history-tools" aria-label="Historical feedback and preview">
		<h3 class="caps-label">Historical feedback and preview</h3>
		<p class="muted">Historical analysis reads YouTube comments without changing moderation. It processes up to 100 comments per cron batch and charges the same per-comment credit as the live feedback digest on metered plans.</p>
		{#if canOperate}
			<div class="history-tool-grid">
				<form
					method="POST"
					action="?/analyzeHistory"
					class="settings-form"
					use:enhance={() => {
						analyzingHistory = true;
						return async ({ update }) => {
							try {
								await update();
							} finally {
								analyzingHistory = false;
							}
						};
					}}
				>
					<label class="field">
						<span>Analyze feedback history window</span>
						<select name="months" disabled={analyzingHistory}>
							{#each HISTORY_WINDOWS as window (window.value)}
								<option value={window.value} selected={window.value === '3'}>{window.label}</option>
							{/each}
						</select>
					</label>
					<p class="muted settings-note">Requires enough credits for each complete batch. Turning feedback off pauses this checkpoint; it does not erase it.</p>
					<button class="btn small" disabled={analyzingHistory || data.history.active || !data.ch.active || !data.settings.enabled || data.dryRunDeployment}>
						{analyzingHistory ? 'Queueing…' : data.history.active ? 'History analysis active' : 'Analyze feedback history'}
					</button>
				</form>
				<form
					method="POST"
					action="?/dryRun"
					class="settings-form"
					use:enhance={() => {
						previewingFeedback = true;
						return async ({ update }) => {
							try {
								await update();
							} finally {
								previewingFeedback = false;
							}
						};
					}}
				>
					<label class="field">
						<span>Feedback dry-run preview window</span>
						<select name="months" disabled={previewingFeedback}>
							{#each HISTORY_WINDOWS as window (window.value)}
								<option value={window.value} selected={window.value === '3'}>{window.label}</option>
							{/each}
							<option value="all">All time</option>
						</select>
					</label>
					<p class="muted settings-note">Scores only the first YouTube page, up to 100 comments. No digest, history, or moderation state is saved.</p>
					<button class="btn small" disabled={previewingFeedback || feedbackPreviewUsed || !data.ch.active}>
						{previewingFeedback ? 'Previewing…' : feedbackPreviewUsed ? 'Feedback preview already used' : 'Run feedback dry run'}
					</button>
				</form>
			</div>
		{/if}
		<p class="limit-note">Limited to 1 free feedback dry run per channel. This one free feedback preview is used when it starts, even if it later fails. No credits are charged.{#if feedbackPreviewUsed} This channel has used its feedback preview allowance.{/if}</p>
		{#if !canOperate}<p class="muted settings-note">Only an organization owner can start historical analysis or use the feedback dry run.</p>{/if}
		{#if analyzingHistory}<div class="preview-loading" role="status" aria-busy="true"><Skeleton rows={1} /></div>{/if}
		{#if previewingFeedback}<div class="preview-loading" role="status" aria-busy="true"><Skeleton rows={2} /></div>{/if}
		{#if feedbackPreview}
			<section class="preview-results" aria-label="Feedback dry-run results">
				<h4>Feedback dry-run preview</h4>
				<p class="muted">{feedbackPreview.commentsClassified} classified · {feedbackPreview.commentsFailed} failed · {feedbackPreview.pooled} pooled · 0 credits used</p>
				<p class="muted">Preview covers only the first page, up to 100 comments; run historical analysis for the full window.</p>
				{#if feedbackPreview.hasMore}<p class="muted">More comments are available beyond this preview page.</p>{/if}
				{#if feedbackPreview.findings.length}
					{#each feedbackPreview.findings as finding, index (finding.category + finding.summary)}
						<div class="preview-finding">
							<h5>{finding.category}: {finding.summary}</h5>
						<p class="muted">{finding.supporterCount} supporting comments</p>
						<ul class="preview-evidence">
							{#each finding.evidence as evidence, evidenceIndex (`${index}-${evidenceIndex}`)}
								<li class:concealed={evidence.hasAbuse === 1}>
									<blockquote class="quote">{evidence.sanitizedExcerpt}</blockquote>
									{#if evidence.hasAbuse === 1}<span class="caps-label concealed-label">wording concealed</span>{/if}
								</li>
							{/each}
						</ul>
						</div>
					{/each}
				{:else}
					<EmptyState title="No grouped findings in this preview" hint="No themes met the feedback settings threshold on this page." />
				{/if}
			</section>
		{/if}
	</section>

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
							, {d.commentsClassified} classified{#if d.pooledCount}, {d.pooledCount} pooled{/if}, {d.creditsUsed === null ? 'unmetered' : `${d.creditsUsed} credits used`}{/if}{#if d.status === 'failed'}
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
	.evidence-details summary {
		cursor: pointer;
		color: var(--text-2);
		font-size: 14px;
	}
	.evidence-list {
		list-style: none;
		margin: 12px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.evidence .quote {
		margin: 0;
	}
	.reveal-form {
		margin-top: 8px;
	}
	.reveal-button {
		margin-top: 8px;
	}
	.reveal-error {
		margin: 8px 0 0;
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
	.credit-notice {
		padding: 16px 18px;
		margin: 0 0 24px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--surface);
		line-height: 1.5;
	}
	.credit-notice p {
		margin: 6px 0 0;
		color: var(--text-2);
		font-size: 13px;
	}
	.history-status {
		margin: 0 0 24px;
	}
	.history-tools > h3 {
		margin: 0 0 10px;
	}
	.history-tools > p {
		margin: 0 0 16px;
	}
	.history-tool-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 24px;
	}
	.limit-note {
		margin: 18px 0 0;
		font-weight: 600;
		font-size: 13px;
	}
	.preview-loading {
		margin-top: 16px;
	}
	.preview-results {
		margin-top: 22px;
		padding-top: 18px;
		border-top: 1px solid var(--line);
	}
	.preview-results h4,
	.preview-finding h5 {
		margin: 0 0 8px;
	}
	.preview-results > p {
		margin: 0 0 8px;
	}
	.preview-finding {
		padding: 14px 0;
		border-bottom: 1px solid var(--line);
	}
	.preview-finding > p {
		margin: 0 0 10px;
	}
	.preview-evidence {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.preview-evidence li {
		padding: 10px;
		border-radius: 6px;
		background: var(--bg);
	}
	.preview-evidence .quote {
		margin: 0;
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
