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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

/**
 * The /pricing FAQ. Single source: PricingFaq.svelte renders it and
 * pricing/+page.svelte builds the FAQPage structured data from it.
 */
export const PRICING_FAQ_ENTRIES: { q: string; a: string }[] = [
	{
		q: 'Is there a subscription?',
		a: 'Yes, exactly one: $5 a month, auto-renewed, with 100 moderated comments included. Everything else is opt-in and off by default: automatic top-up that charges your saved card for a comment bundle whenever your balance drops below the threshold you set.'
	},
	{
		q: 'What is the $49 lifetime deal?',
		a: 'First 1,000 users only: one $49 payment, hosted forever, unlimited moderated comments, and we run the AI for you. When the 1,000 are gone, the deal is gone.'
	},
	{
		q: 'What does BYOK mean?',
		a: 'Bring your own key. Self-hosted Moderaty scores comments with your OpenAI API key, on your account, so the AI cost for most self-hosters is near zero. We never see the key.'
	},
	{
		q: 'Why is self-hosting free?',
		a: 'Moderaty is PolyForm Shield 1.0.0 open source. On your hardware, with your key, there is nothing of ours to meter. We would rather you be protected for free than profitable for us.'
	},
	{
		q: 'What happens when my 100 comments run out?',
		a: 'Buy a bundle of 100, 500, or 2,000 comments; every comment your channel processes with AI scoring on a live run consumes one from your balance (rules and protected handles are free), and the Usage tab shows exactly how many are left. Top up manually any time, or switch on automatic top-up and we charge your saved card for the smallest bundle whenever your balance drops below the threshold you set.'
	},
	{
		q: 'Which one should I pick?',
		a: 'If you have a server, self-host: it is free and it is everything. If you are early and have an OpenAI key, the $49 lifetime is the best deal we will ever make. Otherwise $5 a month, and if your volume dwarfs that, contact us for custom pricing. Same hammer either way.'
	},
	{
		q: 'Can I get a refund?',
		a: 'Yes, within 7 days of any charge. Brazilian consumer law (CDC Art. 49) gives you 7 days from purchase for a full refund of everything you paid, no deductions, no questions asked, through any contact channel.'
	}
];
