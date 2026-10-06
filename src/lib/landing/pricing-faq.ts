/**
 * The /pricing FAQ. Single source: PricingFaq.svelte renders it and
 * pricing/+page.svelte builds the FAQPage structured data from it.
 */
export const PRICING_FAQ_ENTRIES: { q: string; a: string }[] = [
	{
		q: 'Is there a subscription?',
		a: 'Yes: the hosted plan renews at $5 a month, even when you process no AI classifications. Its 100 AI classifications cover moderation scoring and enabled feedback digests together. Automatic top-up is opt-in and off by default; it charges your saved card for your selected bundle when your balance drops below your chosen threshold.'
	},
	{
		q: 'What is the $49 lifetime deal?',
		a: 'First 1,000 users only: one $49 payment, hosted forever, unlimited moderated comments. AI scoring under this plan runs on your own OpenAI API key, which you provide and keep valid. When the 1,000 are gone, the deal is gone.'
	},
	{
		q: 'What does BYOK mean?',
		a: 'Bring your own key. Self-hosted Moderaty uses the OpenAI key configured on your infrastructure, so we never see it. The lifetime plan also scores on your OpenAI API key, so the AI cost is yours at OpenAI prices instead of ours; hosted keys are stored encrypted, and the service processes them to validate the key and score comments.'
	},
	{
		q: 'Why is self-hosting free?',
		a: 'Moderaty is source-available under PolyForm Shield 1.0.0 and free to self-host under its terms. On your hardware, with your key, there is nothing of ours to meter. We would rather you be protected for free than profitable for us.'
	},
	{
		q: 'What happens when my 100 AI classifications run out?',
		a: 'Buy 500 credits for $20.40 or 2,000 for $64.65. One credit covers one AI moderation score; one more covers a digest classification of that comment. Rule and protected-handle moderation decisions use no credit, but digest classifications of those comments do. Requested history scans can charge again; retries of the same scan do not. With the full 100-credit allowance and zero purchased balance, 100 moderation scores plus 100 digest classifications need one 500-credit bundle: $25.40 including the subscription, with 400 purchased credits left. Those leftovers stay on your balance. The Usage tab shows your actual balance; automatic top-up uses your selected bundle and threshold.'
	},
	{
		q: 'Can I pay in Brazilian reais?',
		a: 'Yes. Comment bundles are also sold through Mercado Pago in reais, and the bundle lands on your balance once the payment confirms. The $5 subscription and automatic top-up run on your saved card through Stripe.'
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
