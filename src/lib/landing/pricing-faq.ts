/**
 * The /pricing FAQ. Single source: PricingFaq.svelte renders it and
 * pricing/+page.svelte builds the FAQPage structured data from it.
 */
export const PRICING_FAQ_ENTRIES: { q: string; a: string }[] = [
	{
		q: 'Is there a subscription?',
		a: 'Yes. Hosted renews at $5 a month, even with no AI classifications. An eligible active paid subscription provides 100 AI classifications shared by moderation scores and enabled feedback digests. This allowance is available even when purchased credits are zero. Unused monthly allowance does not carry over. Automatic top-up is opt-in and off by default; it charges your saved card for your selected bundle when your balance drops below your chosen threshold.'
	},
	{
		q: 'What is the $49 lifetime deal?',
		a: 'The offer is limited to the first 1,000 purchases: one $49 payment for hosted Moderaty forever and unlimited moderated comments. You must provide and keep valid your own OpenAI API key for AI scoring, including feedback digests. OpenAI bills your account separately.'
	},
	{
		q: 'What does BYOK mean?',
		a: 'Bring your own key. Self-hosted Moderaty uses the OpenAI key configured on your infrastructure. The lifetime plan requires an organization owner to provide a valid OpenAI API key for scoring. OpenAI bills those API requests separately. The hosted monthly plan uses Moderaty’s key.'
	},
	{
		q: 'Why is self-hosting free?',
		a: 'Self-hosted Moderaty costs $0 from Moderaty under the source-available PolyForm Shield 1.0.0 license. The license excludes using the software to provide a competing product. You provide your own hosting and OpenAI API key. Your infrastructure provider and OpenAI charge separately, and those costs vary by provider, setup, and use.'
	},
	{
		q: 'What happens when my 100 AI classifications run out?',
		a: 'You can buy 500 credits for $20.40 or 2,000 for $64.65. One credit covers one AI moderation score; a feedback digest classification uses another. Rule and protected-handle decisions use no moderation credit, but digest classification of those comments still uses one. A requested history scan can charge again; retrying the same scan does not. For example, with the full 100-credit allowance and no purchased credits, 100 moderation scores plus 100 digest classifications need one 500-credit bundle: $25.40 including the subscription, with 400 purchased credits left. Purchased credits stay on your balance. The Usage page shows your balance; automatic top-up uses your selected bundle and threshold.'
	},
	{
		q: 'Can I pay in Brazilian reais?',
		a: 'Yes. Comment bundles are also sold through Mercado Pago in reais, and the bundle lands on your balance once the payment confirms. The $5 subscription and automatic top-up run on your saved card through Stripe.'
	},
	{
		q: 'Which one should I pick?',
		a: 'Choose hosted monthly if you want Moderaty to run the service and handle the AI key. Choose lifetime if you want hosted access without a monthly subscription and can provide an OpenAI key. Self-host if you can operate the infrastructure and want to manage your own key and deployment.'
	},
	{
		q: 'Can I get a refund?',
		a: 'Yes, within 7 days of any charge. Brazilian consumer law (CDC Art. 49) gives you 7 days from purchase for a full refund of everything you paid, no deductions, no questions asked, through any contact channel.'
	}
];
