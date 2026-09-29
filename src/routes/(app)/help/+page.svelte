<svelte:head>
	<title>Moderaty — Help</title>
</svelte:head>

<h1>Help</h1>
<p class="page-sub">How Moderaty moderates, and what you can take back.</p>

<div class="card">
	<h2>How it works</h2>
	<p>
		Moderaty scans new comments on your connected YouTube channels. Comments that need AI scoring
		are screened first for possible prompt-injection attacks; flagged comments go to the review
		queue without moderation scoring. Other comments are scored against your rules and sensitivity
		setting, then held, rejected, deleted, or used to ban the author. Queued comments may remain
		public on YouTube until their hold is confirmed.
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
	<h2>The feedback digest</h2>
	<p>
		Beyond moderation, Moderaty can group your comments into a digest of what keeps coming
		up: recurring questions, substantive criticism, corrections, and requests. A theme
		only shows up once enough comments raise it — one-off remarks are counted but never listed.
	</p>
	<p>
		Abusive wording is always concealed: the digest shows the sanitized claim, never the insult.
		Supporting comments are concealed by default; “Show original comment” reveals the original text
		on demand for that visit only — nothing is saved, and it is concealed again next time.
		The digest is read-only insight — it never changes a comment's moderation status and never
		replies on your behalf. On metered plans each comment the digest processes consumes one
		credit, the same as AI scoring. Turn it on per channel from the channel's
		<strong>Feedback</strong> tab, where you can also pick the categories, the cadence, and the
		evidence threshold.
	</p>
	<h3>History scans and previews</h3>
	<p>
		Analyze history on the Overview tab can apply moderation actions to older comments. A history scan on the Feedback tab only reads comments and groups feedback; it never changes moderation. Choose 1, 3, 6, 12, or 24 months. The scan runs in background batches of up to 100 comments and keeps going automatically, even when digests are set to manual. Comments already included in a digest are skipped, and retries are not charged twice. Turning feedback off pauses the scan; re-enabling it resumes where it stopped.
	</p>
	<p>
		On metered plans, feedback costs one credit per comment in addition to moderation. The full batch must have enough credits before processing starts; if the balance is short, the batch pauses without processing. Lifetime plans and self-hosted unmetered accounts are not charged credits.
	</p>
	<p>
		Each channel gets 1 free moderation dry run and 1 free feedback dry run. Neither spends credits. Moderation previews drain the selected window in the background; feedback previews cover the first page, up to 100 comments. The allowance is used when a preview starts, even if it later fails. No credits are charged. These dashboard previews are separate from self-hosted <code>DRY_RUN=true</code> mode, which simulates a deployment.
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
