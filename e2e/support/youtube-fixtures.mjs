// Synthetic provider responses. Handle lookup returns channel IDs.
// Comment snippets intentionally contain no invented authorHandle field.
export const channelId = 'UCsynthetic_moderaty_owner';
export const protectedAuthorId = 'UCsynthetic_protected_author';
export const controlAuthorId = 'UCsynthetic_control_author';
export const protectedHandle = '@protected_creator';
export const protectedDisplayName = 'Protected Creator';
export const controlDisplayName = 'Unprotected Creator';
export const banKeyword = 'synthetic-ban-trigger';

export const authorChannels = {
	items: [
		{ id: protectedAuthorId, snippet: { title: protectedDisplayName, customUrl: protectedHandle } },
		{ id: controlAuthorId, snippet: { title: controlDisplayName, customUrl: '@unprotected_creator' } }
	]
};

export function commentPage() {
	const publishedAt = new Date().toISOString();
	return {
		items: [
			['protected-comment', protectedAuthorId, protectedDisplayName],
			['control-comment', controlAuthorId, controlDisplayName]
		].map(([id, authorChannelId, authorDisplayName]) => ({
			id: `thread-${id}`,
			snippet: {
				videoId: 'synthetic-video',
				topLevelComment: {
					id,
					snippet: {
						videoId: 'synthetic-video', authorChannelId: { value: authorChannelId },
						authorDisplayName, authorChannelUrl: `https://www.youtube.com/channel/${authorChannelId}`,
						textDisplay: banKeyword, publishedAt
					}
				}
			}
		}))
	};
}
