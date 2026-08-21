// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

export type FaqEntry = { q: string; a: string };

/**
 * The 8 landing-page Q&As. Single source for both the visible FAQ
 * accordion and the FAQPage JSON-LD in +page.svelte — keep them verbatim.
 */
export const FAQ_ENTRIES: FaqEntry[] = [
	{
		q: 'What is Moderaty?',
		a: "Moderaty is comment protection for YouTube creators. It reads every new comment on every channel you connect, enforces your rules instantly, scores the rest with AI across 13 toxicity categories, and holds anything borderline for your one-click review. It's free and open source under the PolyForm Shield license."
	},
	{
		q: 'Will Moderaty ban my real fans?',
		a: 'Not by default. Your rules act first: a ban rule bans on the spot, whatever the AI would have scored. Without a rule, only comments scoring 0.95 or higher on the AI\'s toxicity or tone analysis trigger an automatic ban. Anything uncertain waits in your review queue for a one-click decision, and every action is logged in your audit trail.'
	},
	{
		q: "What happens when the AI isn't sure about a comment?",
		a: "It goes to your queue. If the AI can't score a comment at all, the comment is held for you, never auto-approved and never auto-rejected."
	},
	{
		q: 'Does Moderaty reply to comments or post anything?',
		a: 'No. Moderaty is protection-only. It holds, hides, deletes, and bans. It never writes replies, never posts under your name, and never does growth automation.'
	},
	{
		q: 'What YouTube account access does Moderaty need?',
		a: 'Google\'s standard YouTube permission, the youtube.force-ssl scope; YouTube offers no comments-only permission. Moderaty uses it only to read and moderate comments on the channels you connect, to read your videos\' titles and descriptions as context for the AI\'s tone analysis, and, during setup, to list the channels your Google account owns (titles and IDs) so you can pick which one to connect. If you own several, that list is held briefly in an encrypted cookie while you choose, then discarded. Nothing else. The code is open source under PolyForm Shield, so you can verify exactly what it does with that access.'
	},
	{
		q: 'Is Moderaty really free?',
		a: 'Self-hosted, yes: free and open source under the PolyForm Shield license, forever. If we host it for you, that is $5 a month with 100 comments included, or $49 once for lifetime if you are among the first 1,000 users.'
	},
	{
		q: 'How is Moderaty different from CommentShark or YouTube Studio?',
		a: 'YouTube Studio flags comments but leaves you to read and act on them. CommentShark automates engagement, including AI replies. Moderaty does one job: enforce your norms so you never have to read the hate.'
	},
	{
		q: 'Can I test Moderaty without changing anything on my channel?',
		a: 'Yes. Dry-run mode classifies everything and changes nothing. The audit trail shows exactly what would have happened, comment by comment.'
	},
	{
		q: 'Is Moderaty LGPD compliant?',
		a: 'Yes. Moderaty is built in Brazil around the LGPD: comment text is kept with the verdict record so your review queue works, and the commenter\'s public handle appears with it in the activity log for up to 30 days, is then erased automatically, and can be erased on demand at any time. No other author identifiers are kept from comments: no channel IDs, no profiles. A blocked-user rule or protected handle stores only the identifier you enter yourself. No author profiling, no model training on comment data. About you, we keep only what your account needs to run. Delete your account and it is all erased on the spot, except the consent record the LGPD requires us to keep. No selling data, no ad profiling, no training models on you. The Privacy Policy and DPA, linked in the footer, spell it out.'
	}
];
