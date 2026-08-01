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

/**
 * The /pricing FAQ. Single source: PricingFaq.svelte renders it and
 * pricing/+page.svelte builds the FAQPage structured data from it.
 */
export const PRICING_FAQ_ENTRIES: { q: string; a: string }[] = [
	{
		q: 'Is there a subscription?',
		a: 'No. $5 buys 500 moderated comments. When they run out, buy another pack or do not. Nothing renews, nothing auto-charges, and the free tier never gets worse to change your mind.'
	},
	{
		q: 'What does BYOK mean?',
		a: "Bring your own key. Self-hosted Moderaty scores comments with your OpenAI API key, on your account. OpenAI's moderation endpoint is free to use, so for most channels the model cost is zero. We never see the key."
	},
	{
		q: 'Why is self-hosting free?',
		a: 'Moderaty is AGPL-3.0 open source. On your hardware, with your key, there is nothing of ours to meter. We would rather you be protected for free than profitable for us.'
	},
	{
		q: 'What happens when my 500 comments run out?',
		a: 'You top up another 500 for $5, or switch to self-hosting and bring your own key. Your rules, thresholds, and audit history are yours either way.'
	},
	{
		q: 'Which one should I pick?',
		a: 'If you have a server and five minutes, self-host. It is free and it is everything. If you would rather click one OAuth button and never think about infrastructure, buy a pack. Same hammer either way.'
	},
	{
		q: 'Can I get a refund?',
		a: 'Yes, within 7 days. Brazilian consumer law (CDC Art. 49) gives you 7 days from purchase for a full refund, no questions, through any contact channel. After that, all sales are final: unused credits are not refunded. Nothing renews, nothing auto-charges.'
	}
];
