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
		a: 'Yes, exactly one: $5 a month, auto-renewed, with 100 moderated comments included. Everything else is opt-in and off by default: automatic top-up when the monthly 100 run out, and auto-charge when a top-up balance hits $0.'
	},
	{
		q: 'What is the $49 lifetime deal?',
		a: "First 1,000 users only: one $49 payment, hosted forever, unlimited moderated comments, with your own OpenAI key. OpenAI's moderation endpoint is free to use, so after the $49 your running cost is likely zero. When the 1,000 are gone, the deal is gone."
	},
	{
		q: 'What does BYOK mean?',
		a: "Bring your own key. Self-hosted Moderaty and the lifetime deal score comments with your OpenAI API key, on your account. OpenAI's moderation endpoint is free to use, so for most channels the model cost is zero. We never see the key."
	},
	{
		q: 'Why is self-hosting free?',
		a: 'Moderaty is AGPL-3.0 open source. On your hardware, with your key, there is nothing of ours to meter. We would rather you be protected for free than profitable for us.'
	},
	{
		q: 'What happens when my 100 comments run out?',
		a: 'Top up at the same 5 cents a comment, in any amount. Do it manually each time, or switch on automatic top-up and never think about it. Unused monthly comments do not carry over.'
	},
	{
		q: 'Which one should I pick?',
		a: 'If you have a server and five minutes, self-host: it is free and it is everything. If you are early and have an OpenAI key, the $49 lifetime is the best deal we will ever make. Otherwise $5 a month, and if your volume dwarfs that, contact us for custom pricing. Same hammer either way.'
	},
	{
		q: 'Can I get a refund?',
		a: 'Yes, within 7 days of any charge. Brazilian consumer law (CDC Art. 49) gives you 7 days from purchase for a full refund of everything you paid, no deductions, no questions asked, through any contact channel.'
	}
];
