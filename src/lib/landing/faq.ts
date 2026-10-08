export type FaqEntry = { q: string; a: string };

/**
 * The landing-page Q&As. Single source for both the visible FAQ
 * accordion and the FAQPage JSON-LD in +page.svelte — keep them verbatim.
 */
const FAQ_COPY: [question: string, answer: string][] = [
	[
		'What is Moderaty?',
		"Moderaty checks published top-level comments on connected, active YouTube channels in background batches. Protected handles skip rules and AI. Your rules run before AI screening and scoring; uncertain results and scoring failures go to your review queue. If a check runs out of time, unfinished comments retry on a later check instead. Replies and a separate sweep of YouTube's held-for-review or spam queues are outside the current scanning scope. Live chat is also outside this scope. It's source-available and free to self-host under PolyForm Shield License 1.0.0, subject to its commercial restrictions."
	],
	[
		'Will Moderaty ban my real fans?',
		'Not by default. Protected handles skip rules and AI. For other scanned comments, a matching ban rule bans without an AI score once YouTube confirms the action. Without a rule, only comments scoring 0.95 or higher on the AI\'s toxicity analysis trigger an automatic ban; the stricter tone analysis only ever hides a comment, never bans. Anything uncertain waits in your review queue for a one-click decision, and every action is logged in your audit trail.'
	],
	[
		"What happens when the AI isn't sure about a comment?",
		"It goes to your review queue. If the AI can't score a comment at all, it is queued for you, never auto-approved and never auto-rejected. If a check runs out of time, unfinished comments retry on a later check instead. Queued comments may remain public on YouTube until their hold is confirmed."
	],
	[
		'Does Moderaty reply to comments or post anything?',
		'No. Moderaty is protection-only. It holds, hides, deletes, and bans. It never writes replies, never posts under your name, and never does growth automation.'
	],
	[
		'What is the feedback digest?',
		'An opt-in report per channel that groups scanned top-level comments into what keeps coming up: recurring questions, substantive criticism, corrections, and requests. A theme is listed only once enough comments raise it (2 to 10, your threshold). Abusive wording stays concealed inside the digest, which is read-only: it never replies, never posts, and never changes a comment\'s moderation. Run it weekly, every 100 new comments, or only when you ask, and scan back up to 24 months of history. On metered plans each comment it classifies costs one credit, the same as AI scoring.'
	],
	[
		'Can Moderaty clean up comments that are already there?',
		'Yes, for published top-level comments. Analyze history re-decides comments in a selected 1, 3, 6, 12, or 24-month window with the same rules and AI: hold, reject, delete, or ban, drained in background batches. It is a moderation run and can change comments on YouTube. The feedback digest\'s own history scan covers the same windows and is read-only. Starting either live history scan requires purchased credits, available paid subscription allowance, or, for lifetime teams, a usable OpenAI key. Replies and separate sweeps of YouTube-held or spam comments are outside both scans.'
	],
	[
		'Can my team help moderate?',
		'Yes. Invite people to your team with a role. Members moderate: they can work the review queue, write rules, and read the audit log. Admins can also manage channels and invites. Billing and feedback settings stay with the owner.'
	],
	[
		'What YouTube account access does Moderaty need?',
		'Google\'s standard YouTube permission, the youtube.force-ssl scope; YouTube offers no comments-only permission. Moderaty uses it only to read and moderate comments on the channels you connect, to read your videos\' titles and descriptions as context for the AI\'s tone analysis, and, during setup, to list the channels your Google account owns (titles and IDs) so you can pick which one to connect. If you own several, that list is held briefly in an encrypted cookie while you choose, then discarded. Nothing else. The code is source-available under PolyForm Shield, so you can verify exactly what it does with that access.'
	],
	[
		'Is Moderaty really free?',
		'Self-hosted, yes: source-available and free to self-host under the PolyForm Shield license, forever. If we host it for you, that is $5 a month with 100 comments included, or $49 once for lifetime if you are among the first 1,000 users.'
	],
	[
		'How is Moderaty different from CommentShark or YouTube Studio?',
		'YouTube Studio flags comments but leaves you to read and act on them. CommentShark automates engagement, including AI replies. Moderaty focuses on protection: your rules and AI scoring help moderate published top-level comments, with uncertain decisions left for your review.'
	],
	[
		'Can I test Moderaty without changing anything on my channel?',
		'Each channel gets 1 free moderation dry run and 1 free feedback dry run. Neither spends credits. Moderation previews drain the selected window in the background; feedback previews cover the first page, up to 100 comments.'
	],
	[
		'Is Moderaty LGPD compliant?',
		'Yes. Moderaty is built in Brazil around the LGPD: comment text is kept with the verdict record so your review queue works, and the commenter\'s public handle appears with it in the activity log for up to 30 days, is then erased automatically, and can be erased on demand at any time. No other author identifiers are kept from comments: no channel IDs, no profiles. A blocked-user rule or protected handle stores only the identifier you enter yourself. No author profiling, no model training on comment data. About you, we keep only what your account needs to run. Delete your account and it is all erased on the spot, except the consent record the LGPD requires us to keep. No selling data, no ad profiling, no training models on you. The Privacy Policy and DPA, linked in the footer, spell it out.'
	]
];

export const FAQ_ENTRIES: FaqEntry[] = FAQ_COPY.map(([q, a]) => ({ q, a }));
