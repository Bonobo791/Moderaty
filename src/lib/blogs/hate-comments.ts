export const HATE_COMMENTS = {
	path: '/blogs/how-to-deal-with-hate-comments-on-youtube/',
	title: 'How to deal with hate comments on YouTube',
	description: 'Decide when to ignore, reply, remove, hide or report YouTube comments. Keep useful criticism and reduce the abuse you have to read.'
} as const;

export const HATE_COMMENT_SECTIONS = {
	action: { id: 'choose-an-action', title: 'Choose an action for a hate comment' },
	criticism: { id: 'criticism-or-attack', title: 'Tell useful criticism from a personal attack' },
	reply: { id: 'reply-to-negative-comments', title: 'Reply to negative comments when you can help the reader' },
	remove: { id: 'remove-or-hide', title: 'Remove a comment or hide the user from your channel' },
	report: { id: 'report-harassment', title: 'Report harassment and threats before removing the evidence' },
	reduce: { id: 'reduce-hate-comments', title: 'Reduce the hate comments you have to read' },
	rules: { id: 'channel-rules', title: 'Keep your channel rules separate from algorithm guesses' },
	preview: { id: 'preview-moderation', title: 'Preview moderation before allowing automatic actions' }
} as const;

export const COMMENT_SOURCES = {
	settings: 'https://support.google.com/youtube/answer/9483359?hl=en',
	changeSettings: 'https://support.google.com/youtube/answer/9482556?hl=en&co=GENIE.Platform%3DDesktop',
	moderate: 'https://support.google.com/youtube/answer/15535966?hl=en&co=GENIE.Platform%3DDesktop',
	hide: 'https://support.google.com/youtube/answer/9482361?hl=en',
	reply: 'https://support.google.com/youtube/answer/9482367?hl=en&co=GENIE.Platform%3DDesktop',
	report: 'https://support.google.com/youtube/answer/2802027?hl=en&co=GENIE.Platform%3DDesktop',
	harassment: 'https://support.google.com/youtube/answer/2802268?hl=en'
} as const;
