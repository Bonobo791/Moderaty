/**
 * Plan panel copy, shared by the homepage pricing section (short lists) and
 * the /pricing page (detailed lists). Billing-policy claims are limited to
 * what the product actually does: the hosted plan renews monthly, and all
 * top-up automation is opt-in and off by default.
 */
export const TICKS_SELF_HOSTED = [
	'Full rules engine and 13-category AI scoring',
	'Feedback digest: the questions and requests that keep coming',
	'Your key, your server, your data',
	'Audit log and 1 free dry run per feature per channel',
	'Fork it, audit it, trust no one'
];

export const TICKS_SELF_HOSTED_DETAILED = [
	'Full rules engine: KEYWORD, REGEX, and USER rules fire before the AI',
	'13-category AI scoring with your thresholds',
	'Feedback digest: recurring questions, criticism, corrections, and requests, grouped',
	'Review queue for the borderline, with team roles for whoever helps',
	'Audit log: held and rejected comments can be restored. Deletions are permanent; author bans cannot be lifted in Moderaty',
	'1 free dry run per feature per channel'
];

export const TICKS_HOSTED = [
	'Auto-renews monthly, 100 AI classifications included',
	'500 credits for $20.40 or 2,000 for $64.65',
	'Automatic top-up is opt-in',
	'Same rules, same model, same audit log'
];

export const TICKS_HOSTED_DETAILED = [
	'Everything in self-hosted',
	'We run it, patch it, and keep it awake',
	'One-click YouTube OAuth',
	'100 AI classifications per paid month, shared by moderation scoring and enabled feedback digests',
	'500 credits for $20.40 or 2,000 for $64.65 when you need more',
	'Automatic top-up is opt-in, off by default'
];

export const TICKS_LIFETIME = [
	'One payment, hosted forever',
	'AI scoring on your own OpenAI API key',
	'Unlimited moderated comments',
	'Limited to the first 1,000 purchases'
];

export const TICKS_LIFETIME_DETAILED = [
	'Everything in hosted, minus the monthly bill',
	'We run it, patch it, and keep it awake, forever',
	'AI scoring runs on your own OpenAI API key (Terms §6.1(c))',
	'Unlimited moderated comments, no meter',
	'Limited to the first 1,000 purchases'
];
