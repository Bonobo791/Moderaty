export const HATE_COMMENTS = {
	path: '/blogs/how-to-deal-with-hate-comments-on-youtube/',
	title: 'How to deal with hate comments on YouTube',
	description: 'Decide when to ignore, reply, remove, hide or report YouTube comments. Keep useful criticism and reduce the abuse you have to read.',
	author: { name: 'Moderaty', path: '/' }
} as const;

export const HATE_COMMENT_SECTIONS = {
	summary: { id: 'summary', title: 'Summary' },
	takeaways: { id: 'key-takeaways', title: 'Key takeaways' },
	action: { id: 'choose-an-action', title: 'Choose an action for the comment' },
	criticism: { id: 'criticism-or-attack', title: 'Tell criticism from a personal attack' },
	reply: { id: 'reply-to-negative-comments', title: 'Reply only when it helps' },
	remove: { id: 'remove-or-hide', title: 'Remove a comment, hide the user or report abuse' },
	reduce: { id: 'reduce-hate-comments', title: 'Reduce how many harmful comments you have to read' },
	preview: { id: 'preview-moderation', title: 'When moderation software may help' },
	faq: { id: 'frequently-asked-questions', title: 'Frequently asked questions' },
	author: { id: 'about-the-author', title: 'About the author' }
} as const;
