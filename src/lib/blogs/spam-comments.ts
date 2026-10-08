export const SPAM_COMMENTS = {
	path: '/blogs/how-to-stop-spam-and-scam-comments-on-youtube/',
	title: 'How to stop spam and scam comments on your YouTube channel',
	description: 'Use YouTube’s native controls, review suspicious comments, and test narrow rules for impersonation, repeated messages, links, and phone-number patterns.'
} as const;

export const SPAM_COMMENT_SECTIONS = [
	{ id: 'native-controls', title: 'Start with YouTube’s comment controls' },
	{ id: 'impersonation', title: 'Check creator impersonation comments' },
	{ id: 'repeated-comments', title: 'Review repeated and copied messages' },
	{ id: 'suspicious-links', title: 'Hold suspicious links for review' },
	{ id: 'phone-number-patterns', title: 'Check phone-number requests in context' },
	{ id: 'reporting', title: 'Report scams and impersonation' },
	{ id: 'custom-rules', title: 'Test custom moderation rules' },
	{ id: 'false-positives', title: 'Protect legitimate comments' },
	{ id: 'preview-rules', title: 'Check the channel preview before broader use' },
	{ id: 'faq', title: 'Frequently asked questions' }
] as const;

// The article displays these exact examples; tests exercise the real matcher.
// They are educational hold rules, not a production detection configuration.
export const SPAM_RULE_EXAMPLES = [
	{ id: 1, type: 'keyword', pattern: 'pay a delivery fee', action: 'hold', purpose: 'A recurring prize-fee phrase', example: 'You won a prize. Pay a delivery fee to claim it.', limitation: 'Also catches a viewer quoting that phrase to warn others.' },
	{ id: 2, type: 'keyword', pattern: 'sub4sub', action: 'hold', purpose: 'A recurring promotion phrase', example: 'Sub4sub? Visit my channel.', limitation: 'Also catches “Please stop posting sub4sub.” It does not count duplicates.' },
	{ id: 3, type: 'regex', pattern: 'https?://', action: 'hold', purpose: 'A web-link marker', example: 'Claim at https://example.invalid/prize', limitation: 'Also catches a useful source link. It cannot assess the destination’s safety.' },
	{ id: 4, type: 'regex', pattern: String.raw`\b(?:whatsapp|telegram)[ :]+[+]?[0-9][0-9 ()-]{7,20}[0-9]\b`, action: 'hold', purpose: 'An app name followed by a number', example: 'Contact Telegram: +1 202 555 0147 to claim a prize.', limitation: 'Also catches a legitimate contact message. Other wording and number formats can pass.' }
] as const;
