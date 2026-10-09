import { afterEach, expect, test, vi } from 'vitest';
import { setupTestDb } from './testdb';
import { prepareDecisionBatch } from './pipeline/scoring';
import type { NewComment } from './youtube';

setupTestDb(['comments', 'rules', 'channel_allowed_handles']);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const comment = (id: string): NewComment => ({
	id, threadId: id, videoId: null, authorChannelId: id, authorName: 'Synthetic',
	text: 'Synthetic comment', publishedAt: '2026-10-09T00:00:00Z'
});
const options = { accessToken: 'synthetic-token', toneLevel: 0, protections: {}, rescore: false, consumeCredits: false, orgId: null };

test('enrichment copies frozen provider comments and leaves the fetched page unchanged', async () => {
	const original = Object.freeze(comment('author'));
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ items: [{ id: 'author', snippet: { customUrl: '@valid_handle' } }] })));
	const batch = await prepareDecisionBatch('owner', { comments: [original], nextPageToken: null, reachedCursor: true }, options);
	expect(batch.newComments).toEqual([{ ...original, authorHandle: 'valid_handle' }]);
	expect(batch.newComments[0]).not.toBe(original);
	expect(original).not.toHaveProperty('authorHandle');
	expect(batch.handleLookupError).toBe(false);
});

test('malformed identity items trigger run health while retaining valid audit handles', async () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ items: [
		{ id: 'valid', snippet: { customUrl: '@valid_handle' } },
		{ id: 'invalid', snippet: null }
	] })));
	const batch = await prepareDecisionBatch('owner', { comments: [comment('valid'), comment('invalid')], nextPageToken: null, reachedCursor: true }, options);
	expect(batch.handleLookupError).toBe(true);
	expect(batch.newComments.map(item => item.authorHandle)).toEqual(['valid_handle', null]);
	expect(warn).toHaveBeenCalled();
});
