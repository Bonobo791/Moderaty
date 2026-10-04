<script lang="ts">
	import { FEEDBACK_URL, GITHUB_URL, POLYFORM_URL } from '$lib/landing/links';
</script>

<svelte:head>
	<title>Moderaty — Help</title>
</svelte:head>

<h1>Help</h1>
<p class="page-sub">Set up your channels, choose your rules, and understand every action.</p>

<nav class="help-contents card" aria-label="Help topics">
	<a href="#getting-started">Getting started</a>
	<a href="#moderation">Moderation and sensitivity</a>
	<a href="#rules">Rules and protected handles</a>
	<a href="#channel-controls">Channel controls</a>
	<a href="#review">Review queue</a>
	<a href="#audit">Audit log and undo</a>
	<a href="#feedback">Feedback digest</a>
	<a href="#history">History scans and previews</a>
	<a href="#billing">Plans, credits, and payments</a>
	<a href="#teams">Teams and permissions</a>
	<a href="#privacy">Privacy and account controls</a>
	<a href="#troubleshooting">Troubleshooting and support</a>
</nav>

<section id="getting-started" class="card">
	<h2>Getting started</h2>
	<ol>
		<li>Sign in with Google and complete the account consent screen.</li>
		<li>
			Open <a href="/dashboard">Dashboard</a> and select <strong>Connect YouTube channel</strong>.
			Google sign-in identifies you; the separate YouTube connection asks for permission to read
			and moderate comments. If your Google account owns multiple channels, choose the one to connect.
		</li>
		<li>Open the channel to find Overview, Rules, Review queue, Feedback, and Audit log.</li>
		<li>Set your sensitivity and rules, then use a free preview to see what Moderaty would do.</li>
	</ol>
	<p>
		YouTube's permission is broader than comments alone because Google offers no comments-only
		permission. Moderaty uses it for channel selection, comments, and video titles and descriptions
		as AI context. It never writes replies or posts on your behalf.
	</p>
	<p>
		The sign-in and account-deleted pages offer English and Brazilian Portuguese. The signed-in app,
		including this Help page, is currently in English.
	</p>
</section>

<section id="moderation" class="card">
	<h2>Moderation and sensitivity</h2>
	<p>
		Moderaty scans new comments on connected, active channels. Protected handles are checked first,
		then your rules. Comments that need AI scoring are screened for possible prompt-injection
		attacks; flagged comments go to the review queue without moderation scoring. AI scoring
		failures and uncertain results also go to review rather than being automatically approved or rejected.
	</p>
	<p>On the channel's <strong>Overview</strong> tab, choose your sensitivity:</p>
	<ul>
		<li><strong>EDGE LORD:</strong> toxicity moderation without the additional tone analysis.</li>
		<li>
			<strong>STRICT:</strong> adds analysis of demeaning, condescending, or sarcastic tone.
			Tone enforcement hides comments; it never deletes comments or bans authors. Your explicit
			rules and the separate toxicity assessment can still take stronger actions.
		</li>
	</ul>
	<p>
		The <strong>Strict protection</strong> switches add heightened scrutiny for harassment targeting
		LGBTQIA+ people and women, at either sensitivity level. Settings save automatically; check for
		the saved state or an error before leaving. AI can make mistakes, so review the outcomes and
		adjust your settings to your community.
	</p>
</section>

<section id="rules" class="card">
	<h2>Rules and protected handles</h2>
	<p>
		The <strong>Rules</strong> tab supports keyword matches, regex patterns, and blocked-user rules
		using a YouTube channel ID. Choose hold for review, reject (hide), delete permanently, or
		reject and ban the author. Rules run before AI; a matching rule can take its selected action
		without an AI score. Invalid or unsafe regex patterns are rejected when you save them.
	</p>
	<p>
		Add trusted viewers to <strong>Protected handles</strong>, up to 100 per channel. Their comments
		skip both rules and AI scanning and are approved. Use the viewer's handle here, not a channel ID.
		Rule matches and protected handles never spend moderation credits; an enabled feedback digest
		can still incur its separate processing charge.
	</p>
</section>

<section id="channel-controls" class="card">
	<h2>Channel controls and status</h2>
	<p>
		<strong>Pause moderation</strong> on Overview stops checks; new comments go unchecked while paused.
		You can resume at any time: the connection and saved data stay in place. A saved moderation
		preview window pauses with the channel and continues when you resume.
	</p>
	<p>
		Dashboard and the channel header show <strong>Not checked yet</strong>, <strong>Protected</strong>,
		<strong>Paused</strong>, or <strong>Check failed</strong>, along with the last check and pending
		reviews. An empty review queue does not by itself mean the latest check succeeded.
	</p>
	<p>
		Owners and admins can use <strong>Danger zone — disconnect channel</strong> on Overview.
		Disconnecting asks Google to revoke access and immediately erases that channel's rules,
		comments, and moderation history; there is no restore. Reconnecting starts the channel fresh.
		Use Pause if you only want a temporary break.
	</p>
</section>

<section id="review" class="card">
	<h2>Review queue</h2>
	<p>
		Open <strong>Review queue</strong> to see the comment, why it was queued, and whether its hold
		has landed on YouTube. Queued comments may remain public on YouTube until their hold is confirmed.
		<strong>Held on YouTube</strong> means the comment is no longer public.
	</p>
	<ul>
		<li><strong>Approve:</strong> publish the comment.</li>
		<li><strong>Reject:</strong> hide the comment.</li>
		<li><strong>Delete:</strong> permanently remove the comment after confirmation.</li>
		<li><strong>Ban author:</strong> reject the comment and ban its author after confirmation.</li>
	</ul>
	<p>If an action fails, read the error and check the row's state before trying again.</p>
</section>

<section id="audit" class="card">
	<h2>The audit log and what you can undo</h2>
	<p>
		Every moderation action, automatic or manual, is recorded in the channel's audit log, newest
		first, with its reason, such as a rule match or AI score, and actor: <code>system</code> for
		automatic actions or <code>user</code> for manual actions. Dry-run entries show simulated decisions.
		Use <strong>Older</strong> to read previous pages and <strong>Newest</strong> to return.
		Undo controls appear where a comment can be restored.
	</p>
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
					Partly — Undo comment restores the comment, but author bans cannot be lifted, reversed,
					or undone through Moderaty: YouTube provides no way to un-ban an author through its API.
				</td>
			</tr>
			<tr>
				<td data-label="Action"><span class="badge danger">delete</span></td>
				<td data-label="Reversible?">
					No — deleted comments cannot be restored, reversed, or undone. Deletion is permanent.
				</td>
			</tr>
		</tbody>
	</table>
	<p class="muted">This matches Section 9.4 of the <a href="/terms">Terms of Service</a>.</p>
</section>

<section id="feedback" class="card">
	<h2>The feedback digest</h2>
	<p>
		The channel's <strong>Feedback</strong> tab groups recurring questions, substantive criticism,
		corrections, and requests. The owner can enable it, choose categories, and generate a digest
		weekly, every 100 new comments, or manually with <strong>Generate now</strong>. Set an evidence
		threshold of 2 to 10 comments before a theme becomes a finding; one-off remarks are counted
		but not listed as findings. Use <strong>Recent digests</strong> to revisit past results.
	</p>
	<p>
		The digest is read-only: it never changes moderation status or replies for you. Abusive wording
		is concealed in the findings. Supporting comments are hidden until you choose
		<strong>Show original comment</strong> or the separate abusive-comment reveal. Revealing text
		is temporary for that visit; the reveal choice is not saved.
	</p>
	<p>
		On metered plans, feedback costs one credit per comment in addition to moderation. The full
		batch must have enough credits before processing starts; if the balance is short, the batch
		pauses without processing. Lifetime plans and self-hosted unmetered accounts are not charged credits.
	</p>
</section>

<section id="history" class="card">
	<h2>History scans and previews</h2>
	<p>
		Analyze history on the Overview tab can apply moderation actions to older comments.
		It requires purchased credits, available paid subscription allowance, or a lifetime plan with
		a usable OpenAI key. Check your rules and sensitivity before starting a live scan.
	</p>
	<p>
		A history scan on the Feedback tab only reads comments and groups feedback; it never changes moderation.
		Choose 1, 3, 6, 12, or 24 months. The scan runs in background batches of up to 100 comments and keeps going automatically, even when digests are set to manual.
		Comments already included in a digest are skipped, and retries are not charged twice.
		Turning feedback off pauses the scan; re-enabling it resumes where it stopped.
		Only an owner can start feedback history scans or previews.
	</p>
	<p>
		Each channel gets 1 free moderation dry run and 1 free feedback dry run. Neither spends credits
		or changes comments on YouTube. The allowance is used when a preview starts, even if it later fails.
		Moderation previews drain the selected window in the background; feedback previews cover the first page, up to 100 comments.
		The moderation preview also offers <strong>all time</strong>. Check its simulated actions in
		the Audit log; feedback previews appear under Recent digests.
	</p>
	<p>
		Leaving or refreshing the page does not stop a background scan. Progress and failures appear
		on the channel pages. These dashboard previews are separate from self-hosted
		<code>DRY_RUN=true</code> mode, which simulates a deployment.
	</p>
</section>

<section id="billing" class="card">
	<h2>Plans, credits, and payments</h2>
	<p>
		<a href="/usage">Usage</a> shows your team's plan, credits, consumption, and purchase history.
		Owners manage purchases and payment settings. Check <a href="/pricing">Pricing</a> and the
		offers shown in Usage for current prices and availability.
	</p>
	<ul>
		<li>
			<strong>Metered plans:</strong> each comment processed with AI scoring on a live run uses
			one credit. Feedback processing has its own one-credit charge per comment. The hosted
			subscription includes a per-period allowance; unused included credits do not roll over,
			and prepaid credits cover overage. When credits run out, AI scoring pauses while rules
			and protected handles continue; scoring resumes after credits arrive.
		</li>
		<li>
			<strong>Lifetime:</strong> requires your own OpenAI API key, saved by an owner on
			<a href="/org">Team</a>. OpenAI bills your API usage separately. The key is validated,
			stored encrypted, and never displayed again. Without a usable key, AI scoring cannot run.
			Lifetime does not need Moderaty credits or automatic top-ups.
		</li>
		<li>
			<strong>Self-hosted:</strong> use your own infrastructure and service credentials.
			Moderaty is source-available under <a href={POLYFORM_URL}>PolyForm Shield</a>, with
			commercial restrictions. Free self-hosting does not cover your hosting or provider costs.
		</li>
	</ul>
	<p>
		Use <strong>Manage cards</strong> for saved payment methods and <strong>Manage subscription</strong>
		for a hosted subscription. To switch from hosted to lifetime, cancel the hosted subscription
		first; its included allowance remains available until the paid period ends.
	</p>
	<p>
		<strong>Automatic top-up</strong> is optional and requires your consent, a saved Stripe payment
		method, a bundle, and a balance threshold. Charges are limited to once every 24 hours and up to
		30 times per month. You can disable it in Usage. After a card change, payment failure, or refund,
		read its status before expecting another top-up. Buy credits in advance for large scans.
	</p>
	<p>
		Mercado Pago prepaid-credit purchases in Brazilian reais are available when offered on Usage.
		Credits arrive after payment approval is confirmed. Automatic top-up uses Stripe only.
	</p>
</section>

<section id="teams" class="card">
	<h2>Teams and permissions</h2>
	<p>
		Create or manage teams on <a href="/org">Team</a>. If you belong to more than one, choose the
		active team in the navigation. Its channels and credit balance are separate from other teams.
	</p>
	<ul>
		<li>
			<strong>Members</strong> work the review queue, manage rules, and read the audit log and digests.
			They can also change sensitivity and protections, pause or resume moderation, start
			moderation history scans that can spend team credits, and erase stored commenter handles.
		</li>
		<li>
			<strong>Admins</strong> also connect or disconnect channels, rename teams, and create or revoke
			invite links. They can remove ordinary members, but cannot remove owners or other admins.
		</li>
		<li><strong>Owners</strong> also manage member roles, billing, feedback settings and runs, and the lifetime OpenAI key.</li>
	</ul>
	<p>
		An invite link works once and expires after 7 days. Share it with the intended teammate; revoke
		unused invitations on Team. Owners must promote a teammate before leaving a team.
	</p>
</section>

<section id="privacy" class="card">
	<h2>Privacy and account controls</h2>
	<p>
		Comment text is stored with moderation records, limited to 500 characters. Commenter handles
		in the audit records are kept for 30 days, then erased automatically. Use
		<strong>Erase handles now</strong> in a channel's Audit log to remove its stored commenter handles
		earlier. This does not remove the protected handles or blocked-user rules you entered yourself.
	</p>
	<p>
		Open <a href="/account">Account</a> from your name in the navigation to see your connection
		details, sign out, or delete your account. Account deletion is immediate and permanent, with
		no restore window. Teams where you are the only member and their channel data are erased. Shared teams with other
		members remain, and channels you connected there need a teammate to reconnect them. Consent
		evidence is retained under the legal retention policy; your email in those records is erased
		after 10 years.
	</p>
	<p>
		Read the <a href="/privacy">Privacy Policy</a> and <a href="/dpa">Data Processing Agreement</a>
		for retention, service providers, and your rights. You can also revoke access through your
		<a href="https://security.google.com/settings/security/permissions" target="_blank" rel="noreferrer">Google security settings</a>.
	</p>
</section>

<section id="troubleshooting" class="card">
	<h2>Troubleshooting and support</h2>
	<ul>
		<li><strong>Not checked yet:</strong> wait for the first scheduled check; inspect the channel status again.</li>
		<li><strong>YouTube access expired:</strong> reconnect the channel using Connect YouTube channel on Dashboard.</li>
		<li><strong>Out of credits:</strong> ask an owner to add credits on Usage; lifetime owners should check their OpenAI key on Team.</li>
		<li><strong>Quota or timeout failure:</strong> read the status message. Moderaty retries unfinished work on later scheduled checks.</li>
		<li>
			<strong>AI scoring failure:</strong> affected comments are stored in the review queue and are
			not automatically scored again on later normal checks. Review and resolve them manually
			in Review queue.
		</li>
		<li><strong>Digest deferred:</strong> resolve the reported credit or key issue. Manual digests need Generate now; scheduled digests and history scans retry automatically.</li>
		<li><strong>Maintenance:</strong> the database is temporarily unavailable. Wait for recovery before changing settings or moderating.</li>
		<li><strong>Self-hosted scans are not advancing:</strong> verify that your installation's cron job is running. Keeping a browser tab open does not run the scheduler.</li>
	</ul>
	<p>
		Use <a href="/contact">Contact</a> for help, the <a href={FEEDBACK_URL} target="_blank" rel="noreferrer">feedback board</a>
		for feature requests, and the <a href={GITHUB_URL} target="_blank" rel="noreferrer">repository</a>
		for source code and self-hosting instructions. Include the channel ID and the visible error,
		but never send API keys, OAuth tokens, passwords, or payment details.
	</p>
</section>

<style>
	a {
		color: var(--text);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	a:visited {
		color: var(--text-2);
	}
	a:hover {
		color: var(--accent);
	}
	a:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
	}
	.help-contents {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
		gap: 12px 24px;
	}
	section {
		scroll-margin-top: 24px;
	}
	section h2 {
		margin-top: 0;
	}
	li + li {
		margin-top: 8px;
	}
</style>
