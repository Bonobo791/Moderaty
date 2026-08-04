// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

export type FaqEntry = { q: string; a: string };

/**
 * The 8 landing-page Q&As. Single source for both the visible FAQ
 * accordion and the FAQPage JSON-LD in +page.svelte — keep them verbatim.
 */
export const FAQ_ENTRIES: FaqEntry[] = [
	{
		q: 'What is Moderaty?',
		a: "Moderaty is comment protection for YouTube creators. It reads every new comment on every channel you connect, enforces your rules instantly, scores the rest with AI across 13 toxicity categories, and holds anything borderline for your one-click review. It's free and open source under AGPL."
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
		a: 'Google\'s standard YouTube permission, the youtube.force-ssl scope; YouTube offers no comments-only permission. Moderaty uses it only to read and moderate comments on the channels you connect and to read your videos\' titles and descriptions as context for the AI\'s tone analysis, nothing else. The code is open source under AGPL, so you can verify exactly what it does with that access.'
	},
	{
		q: 'Is Moderaty really free?',
		a: 'Self-hosted, yes: free and open source under the AGPL license, forever. If we host it for you, that is $5 a month with 100 comments included, or $49 once for lifetime if you are among the first 1,000 users.'
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
		a: 'Yes. Moderaty is built in Brazil around the LGPD: comment text is kept with the verdict record so your review queue works, but comment author identities are never stored from comments. A blocked-user rule stores only the channel ID you enter yourself. No author profiling, no model training on comment data. The Privacy Policy and DPA, linked in the footer, spell it out.'
	}
];
