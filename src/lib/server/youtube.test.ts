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

import { afterEach, expect, test, vi } from 'vitest';
import { fetchNewComments, fetchVideoMetadata, getCommentModerationStatus, setModerationStatus } from './youtube';

function comment(id: string, publishedAt: string, text = `Comment ${id}`) {
	return {
		id: `thread-${id}`,
		snippet: {
			topLevelComment: {
				id,
				snippet: {
					videoId: `video-${id}`,
					authorChannelId: { value: `author-${id}` },
					authorDisplayName: `Author ${id}`,
					textDisplay: text,
					publishedAt
				}
			}
		}
	};
}

function page(items: ReturnType<typeof comment>[], nextPageToken?: string) {
	return new Response(JSON.stringify({
		items,
		...(nextPageToken ? { nextPageToken } : {})
	}), { status: 200 });
}

/** Stubs fetch with the given commentThread pages, captures warnings, and runs one fetch. */
async function fetchComments(...pages: Response[]) {
	const fetch = vi.fn();
	for (const response of pages) fetch.mockResolvedValueOnce(response);
	vi.stubGlobal('fetch', fetch);
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const result = await fetchNewComments('channel', 'token', null);
	return { result, warn };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

test('stops pagination after the third page', async () => {
	const fetch = vi.fn()
		.mockResolvedValueOnce(page([comment('1', '2026-01-04T00:00:00.000Z')], 'page-2'))
		.mockResolvedValueOnce(page([comment('2', '2026-01-03T00:00:00.000Z')], 'page-3'))
		.mockResolvedValueOnce(page([comment('3', '2026-01-02T00:00:00.000Z')], 'page-4'));
	vi.stubGlobal('fetch', fetch);

	const result = await fetchNewComments('channel', 'token', null);

	expect(fetch).toHaveBeenCalledTimes(3);
	expect(result.comments.map((item) => item.id)).toEqual(['1', '2', '3']);
	expect(result).toMatchObject({ nextPageToken: 'page-4', reachedCursor: false });
});

test('stops pagination when a comment is older than the cursor', async () => {
	const fetch = vi.fn().mockResolvedValue(page([
		comment('new', '2026-01-04T00:00:00.000Z'),
		comment('old', '2026-01-01T00:00:00.000Z')
	], 'page-2'));
	vi.stubGlobal('fetch', fetch);

	const result = await fetchNewComments('channel', 'token', '2026-01-02T00:00:00.000Z');

	expect(fetch).toHaveBeenCalledTimes(1);
	expect(result.comments.map((item) => item.id)).toEqual(['new']);
	expect(result).toMatchObject({ nextPageToken: null, reachedCursor: true });
});

test('compares the cursor by instant, not lexicographically', async () => {
	const fetch = vi.fn().mockResolvedValue(page([
		comment('same-instant', '2026-01-02T00:00:00.000Z'),
		comment('older-offset', '2026-01-01T20:00:00-02:00')
	], 'page-2'));
	vi.stubGlobal('fetch', fetch);

	const result = await fetchNewComments('channel', 'token', '2026-01-02T00:00:00Z');

	expect(fetch).toHaveBeenCalledTimes(1);
	expect(result.comments.map((item) => item.id)).toEqual(['same-instant']);
	expect(result).toMatchObject({ nextPageToken: null, reachedCursor: true });
});

test('rejects a cursor that is not a valid timestamp', async () => {
	await expect(fetchNewComments('channel', 'token', 'not-a-date')).rejects.toThrow(
		'fetchNewComments cursor is invalid: not-a-date'
	);
});

test('returns the complete comment text for moderation', async () => {
	const text = 'x'.repeat(501);
	const fetch = vi.fn().mockResolvedValue(page([
		comment('long', '2026-01-04T00:00:00.000Z', text)
	]));
	vi.stubGlobal('fetch', fetch);

	const result = await fetchNewComments('channel', 'token', null);

	expect(result.comments[0]?.text).toBe(text);
});

test('normalizes missing author metadata instead of failing the page', async () => {
	const deletedAuthor = comment('deleted', '2026-01-04T00:00:00.000Z');
	delete (deletedAuthor.snippet.topLevelComment.snippet as Record<string, unknown>).authorChannelId;
	delete (deletedAuthor.snippet.topLevelComment.snippet as Record<string, unknown>).authorDisplayName;

	const { result, warn } = await fetchComments(page([
		deletedAuthor,
		comment('normal', '2026-01-03T00:00:00.000Z')
	]));

	expect(result.comments.map((item) => item.id)).toEqual(['deleted', 'normal']);
	expect(result.comments[0]).toMatchObject({ authorChannelId: '', authorName: '[unavailable author]' });
	expect(warn).toHaveBeenCalled();
});

test('skips a malformed comment without failing the page', async () => {
	const malformed = comment('malformed', '2026-01-04T00:00:00.000Z');
	delete (malformed.snippet.topLevelComment.snippet as Record<string, unknown>).textDisplay;

	const { result, warn } = await fetchComments(
		page([malformed, comment('normal', '2026-01-03T00:00:00.000Z')], 'page-2'),
		page([comment('next', '2026-01-02T00:00:00.000Z')])
	);

	expect(result.comments.map((item) => item.id)).toEqual(['normal', 'next']);
	expect(result).toMatchObject({ nextPageToken: null, reachedCursor: false });
	expect(warn).toHaveBeenCalled();
});

test('batches moderation-status updates into groups of fifty', async () => {
	const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
	vi.stubGlobal('fetch', fetch);
	const ids = Array.from({ length: 101 }, (_, index) => `comment-${index + 1}`);

	await setModerationStatus(ids, 'rejected', false, 'token');

	expect(fetch).toHaveBeenCalledTimes(3);
	const batches = fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('id')!.split(','));
	expect(batches).toEqual([ids.slice(0, 50), ids.slice(50, 100), ids.slice(100)]);
});

test('restores a comment by posting moderationStatus=published without banAuthor', async () => {
	const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
	vi.stubGlobal('fetch', fetch);

	await setModerationStatus(['comment'], 'published', false, 'token');

	const url = new URL(String(fetch.mock.calls[0]?.[0]));
	expect(url.searchParams.get('moderationStatus')).toBe('published');
	// banAuthor is only valid alongside 'rejected' — a restore must omit it.
	expect(url.searchParams.get('banAuthor')).toBeNull();
	expect(url.searchParams.get('id')).toBe('comment');
});

test('returns a comment moderation status for recovery verification', async () => {
	const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
		items: [{ snippet: { moderationStatus: 'rejected' } }]
	}), { status: 200 }));
	vi.stubGlobal('fetch', fetch);

	await expect(getCommentModerationStatus('comment', 'token')).resolves.toBe('rejected');
	expect(String(fetch.mock.calls[0]?.[0])).toContain('part=snippet');
	expect(String(fetch.mock.calls[0]?.[0])).toContain('id=comment');
});

test('treats a missing comment as absent during recovery verification', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

	await expect(getCommentModerationStatus('comment', 'token')).resolves.toBeNull();
});

test('parses each comment\'s video ID for tone context', async () => {
	const { result } = await fetchComments(page([comment('1', '2026-01-04T00:00:00.000Z')]));

	expect(result.comments[0]).toMatchObject({ id: '1', videoId: 'video-1' });
});

test('falls back to the thread video ID when the comment snippet lacks one', async () => {
	const fallback = comment('1', '2026-01-04T00:00:00.000Z');
	delete (fallback.snippet.topLevelComment.snippet as Record<string, unknown>).videoId;
	(fallback.snippet as Record<string, unknown>).videoId = 'video-thread';

	const { result } = await fetchComments(page([fallback]));

	expect(result.comments[0]).toMatchObject({ id: '1', videoId: 'video-thread' });
});

test('keeps a comment with no video ID so omni and rules still moderate it', async () => {
	const noVideo = comment('no-video', '2026-01-04T00:00:00.000Z');
	delete (noVideo.snippet.topLevelComment.snippet as Record<string, unknown>).videoId;

	const { result, warn } = await fetchComments(page([
		noVideo,
		comment('normal', '2026-01-03T00:00:00.000Z')
	]));

	expect(result.comments.map((item) => item.id)).toEqual(['no-video', 'normal']);
	expect(result.comments[0]).toMatchObject({ id: 'no-video', videoId: null });
	expect(warn).toHaveBeenCalled();
});

function videoItem(id: string, title = `Title ${id}`, description = `Description ${id}`) {
	return { id, snippet: { title, description } };
}

test('fetches video metadata in batches of fifty', async () => {
	const ids = Array.from({ length: 51 }, (_, index) => `video-${index + 1}`);
	const fetch = vi.fn()
		.mockResolvedValueOnce(new Response(JSON.stringify({ items: ids.slice(0, 50).map((id) => videoItem(id)) }), { status: 200 }))
		.mockResolvedValueOnce(new Response(JSON.stringify({ items: [videoItem('video-51')] }), { status: 200 }));
	vi.stubGlobal('fetch', fetch);

	const result = await fetchVideoMetadata(ids, 'token');

	expect(fetch).toHaveBeenCalledTimes(2);
	expect(String(fetch.mock.calls[0]?.[0])).toContain('part=snippet');
	expect(result.get('video-1')).toEqual({ title: 'Title video-1', description: 'Description video-1' });
	expect(result.get('video-51')).toEqual({ title: 'Title video-51', description: 'Description video-51' });
});

test('truncates long video descriptions for the tone prompt', async () => {
	const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
		items: [videoItem('video-1', 'Title', 'd'.repeat(600))]
	}), { status: 200 }));
	vi.stubGlobal('fetch', fetch);

	const result = await fetchVideoMetadata(['video-1'], 'token');

	expect(result.get('video-1')?.description).toBe('d'.repeat(500));
});

test('skips malformed video metadata items without failing the batch', async () => {
	const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
		items: [{ id: 'bad', snippet: {} }, videoItem('good')]
	}), { status: 200 }));
	vi.stubGlobal('fetch', fetch);
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

	const result = await fetchVideoMetadata(['bad', 'good'], 'token');

	expect(result.has('bad')).toBe(false);
	expect(result.get('good')).toEqual({ title: 'Title good', description: 'Description good' });
	expect(warn).toHaveBeenCalled();
});

test('fails loudly when the videos.list request fails', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('quota exceeded', { status: 403 })));

	await expect(fetchVideoMetadata(['video-1'], 'token')).rejects.toThrow('videos.list failed: 403');
});
