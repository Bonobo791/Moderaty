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
	<h2>The feedback digest</h2>
	<p>
		Beyond moderation, Moderaty can group your comments into a digest of what keeps coming
		up: recurring questions, substantive criticism, corrections, and requests. A theme
		only shows up once enough comments raise it — one-off remarks are counted but never listed.
	</p>
	<p>
		Abusive wording is always concealed: the digest shows the sanitized claim, never the insult.
		The digest is read-only insight — it never changes a comment's moderation status and never
		replies on your behalf. On metered plans each comment the digest processes consumes one
		credit, the same as AI scoring. Turn it on per channel from the channel's
		<strong>Feedback</strong> tab, where you can also pick the categories, the cadence, and the
		evidence threshold.
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
