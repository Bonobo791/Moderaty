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

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: {
		GOOGLE_CLIENT_ID: 'client-id',
		GOOGLE_CLIENT_SECRET: 'client-secret'
	} as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

import { deleteComment, fetchNewComments, fetchVideoMetadata, getCommentModerationStatus, refreshAccessToken, setModerationStatus } from './youtube';

beforeEach(() => {
	mocks.env.GOOGLE_CLIENT_ID = 'client-id';
	mocks.env.GOOGLE_CLIENT_SECRET = 'client-secret';
});

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

test('sends banAuthor=true when banning a comment author', async () => {
	const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
	vi.stubGlobal('fetch', fetch);

	await setModerationStatus(['comment'], 'rejected', true, 'token');

	const url = new URL(String(fetch.mock.calls[0]?.[0]));
	// Dropping this parameter silently degrades every ban to a plain reject.
	expect(url.searchParams.get('banAuthor')).toBe('true');
	expect(url.searchParams.get('moderationStatus')).toBe('rejected');
});

test('posts the moderation update and fails loudly on a non-OK response', async () => {
	const fetch = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }));
	vi.stubGlobal('fetch', fetch);

	// A failed write must throw — otherwise the pipeline confirms an action
	// YouTube never enforced (I3).
	await expect(setModerationStatus(['comment'], 'rejected', false, 'token')).rejects.toThrow(
		'setModerationStatus failed: 403 forbidden'
	);
	expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
});

test('deletes a comment with a DELETE request and tolerates an already-deleted comment', async () => {
	const fetch = vi.fn()
		.mockResolvedValueOnce(new Response(null, { status: 204 }))
		.mockResolvedValueOnce(new Response(null, { status: 404 }));
	vi.stubGlobal('fetch', fetch);

	await expect(deleteComment('comment id/with+chars', 'token')).resolves.toBeUndefined();
	expect(String(fetch.mock.calls[0]?.[0])).toContain(`id=${encodeURIComponent('comment id/with+chars')}`);
	expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });

	// 404 means the comment is already gone — that IS a successful delete (I4).
	await expect(deleteComment('gone', 'token')).resolves.toBeUndefined();
});

test('fails loudly when a comment delete is rejected', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('quota exceeded', { status: 403 })));

	await expect(deleteComment('comment', 'token')).rejects.toThrow('comments.delete failed: 403');
});

test('requests new comments in time order for the watched channel', async () => {
	const fetch = vi.fn().mockResolvedValue(page([comment('1', '2026-01-04T00:00:00.000Z')]));
	vi.stubGlobal('fetch', fetch);

	await fetchNewComments('channel', 'token', null);

	const url = new URL(String(fetch.mock.calls[0]?.[0]));
	// The cursor logic assumes time ordering; relevance ordering silently
	// skips comments on every run.
	expect(url.searchParams.get('order')).toBe('time');
	expect(url.searchParams.get('allThreadsRelatedToChannelId')).toBe('channel');
	expect(url.searchParams.get('maxResults')).toBe('100');
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
	const batches = fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('id')!.split(','));
	expect(batches).toEqual([ids.slice(0, 50), ['video-51']]);
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

function rawPage(payload: unknown) {
	return new Response(JSON.stringify(payload), { status: 200 });
}

test('does not warn for a fully-populated comment', async () => {
	const fetch = vi.fn().mockResolvedValue(page([comment('1', '2026-01-04T00:00:00.000Z')]));
	vi.stubGlobal('fetch', fetch);
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	// The spy may be shared with earlier tests in this file — start from zero.
	warn.mockClear();

	const result = await fetchNewComments('channel', 'token', null);

	expect(result.comments[0]).toMatchObject({
		id: '1',
		threadId: 'thread-1',
		videoId: 'video-1',
		authorChannelId: 'author-1',
		authorName: 'Author 1',
		publishedAt: '2026-01-04T00:00:00.000Z'
	});
	expect(warn).not.toHaveBeenCalled();
});

test('rejects a commentThreads response without an items array', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawPage({})));

	await expect(fetchNewComments('channel', 'token', null)).rejects.toThrow(
		'commentThreads.list response items is missing or invalid'
	);
});

test.each([
	[null, 'commentThreads.list response item 0 is missing or invalid'],
	[42, 'commentThreads.list response item 0 is missing or invalid'],
	[[], 'commentThreads.list response item 0 is missing or invalid'],
	[{ snippet: null }, 'commentThreads.list response item 0.snippet is missing or invalid'],
	[{ snippet: 42 }, 'commentThreads.list response item 0.snippet is missing or invalid'],
	[{ snippet: [] }, 'commentThreads.list response item 0.snippet is missing or invalid'],
	[{ snippet: {} }, 'commentThreads.list response item 0.topLevelComment is missing or invalid'],
	[
		{ snippet: { topLevelComment: {} } },
		'commentThreads.list response item 0.topLevelComment.snippet is missing or invalid'
	]
])('rejects a structurally malformed comment thread %j', async (item, message) => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawPage({ items: [item] })));

	// A malformed response fails loudly (I1) — the cron run must not treat a
	// garbled page as "no new comments".
	await expect(fetchNewComments('channel', 'token', null)).rejects.toThrow(message);
});

function brokenComment(missing: 'id' | 'threadId' | 'publishedAt' | 'validDate') {
	const broken = comment('broken', '2026-01-04T00:00:00.000Z');
	if (missing === 'id') delete (broken.snippet.topLevelComment as Record<string, unknown>).id;
	if (missing === 'threadId') delete (broken as Record<string, unknown>).id;
	if (missing === 'publishedAt') {
		delete (broken.snippet.topLevelComment.snippet as Record<string, unknown>).publishedAt;
	}
	if (missing === 'validDate') broken.snippet.topLevelComment.snippet.publishedAt = 'not-a-date';
	return broken;
}

test.each(['id', 'threadId', 'publishedAt', 'validDate'] as const)(
	'skips a comment with a missing or invalid %s without failing the page',
	async (missing) => {
		const { result, warn } = await fetchComments(page([
			brokenComment(missing),
			comment('normal', '2026-01-03T00:00:00.000Z')
		]));

		expect(result.comments.map((item) => item.id)).toEqual(['normal']);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('commentThreads.list response item 0 is malformed')
		);
	}
);

test.each([
	['an empty string', ''],
	['a number', 42]
])('normalizes %s videoId to null and warns', async (_label, videoId) => {
	const weird = comment('weird', '2026-01-04T00:00:00.000Z');
	(weird.snippet.topLevelComment.snippet as Record<string, unknown>).videoId = videoId;

	const { result, warn } = await fetchComments(page([weird]));

	expect(result.comments[0]?.videoId).toBeNull();
	expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no videoId'));
});

test('does not trip the cursor boundary on a pre-1970 comment when no cursor is set', async () => {
	const { result } = await fetchComments(page([comment('ancient', '1965-06-01T00:00:00.000Z')]));

	expect(result.comments.map((item) => item.id)).toEqual(['ancient']);
	expect(result.reachedCursor).toBe(false);
});

test.each([
	['a string', 'plain-string'],
	['a number', 7],
	['an array', [{ value: 'x' }]],
	['an explicit null', null]
])('normalizes %s authorChannelId to empty and warns', async (_label, authorChannelId) => {
	const weird = comment('weird', '2026-01-04T00:00:00.000Z');
	(weird.snippet.topLevelComment.snippet as Record<string, unknown>).authorChannelId = authorChannelId;

	const { result, warn } = await fetchComments(page([weird]));

	expect(result.comments[0]?.authorChannelId).toBe('');
	expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no authorChannelId'));
});

test('warns loudly for each missing author field', async () => {
	const deleted = comment('deleted', '2026-01-04T00:00:00.000Z');
	delete (deleted.snippet.topLevelComment.snippet as Record<string, unknown>).authorChannelId;
	delete (deleted.snippet.topLevelComment.snippet as Record<string, unknown>).authorDisplayName;

	const { result, warn } = await fetchComments(page([deleted]));

	expect(result.comments[0]).toMatchObject({ authorChannelId: '', authorName: '[unavailable author]' });
	expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no authorChannelId'));
	expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no authorDisplayName'));
});

test('sends an authenticated request without a page token by default', async () => {
	const fetch = vi.fn().mockResolvedValue(page([comment('1', '2026-01-04T00:00:00.000Z')]));
	vi.stubGlobal('fetch', fetch);

	await fetchNewComments('channel', 'token', null);

	const url = new URL(String(fetch.mock.calls[0]?.[0]));
	expect(url.searchParams.get('part')).toBe('snippet');
	expect(url.searchParams.get('textFormat')).toBe('plainText');
	expect(url.searchParams.has('pageToken')).toBe(false);
	// A dropped Authorization header turns every call into a 401 quota failure.
	expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer token' });
});

test('sends the provided page token for checkpoint resumes', async () => {
	const fetch = vi.fn().mockResolvedValue(page([comment('1', '2026-01-04T00:00:00.000Z')]));
	vi.stubGlobal('fetch', fetch);

	await fetchNewComments('channel', 'token', null, { pageToken: 'checkpoint' });

	const url = new URL(String(fetch.mock.calls[0]?.[0]));
	expect(url.searchParams.get('pageToken')).toBe('checkpoint');
});

test('treats an explicit null nextPageToken as the end of the list', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawPage({ items: [], nextPageToken: null })));

	const result = await fetchNewComments('channel', 'token', null);

	expect(result).toEqual({ comments: [], nextPageToken: null, reachedCursor: false });
});

test('rejects a non-string nextPageToken instead of echoing it back to YouTube', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawPage({ items: [], nextPageToken: 42 })));

	await expect(fetchNewComments('channel', 'token', null)).rejects.toThrow(
		'commentThreads.list response nextPageToken is missing or invalid'
	);
});

test('rejects a commentThreads response that is not a JSON object', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })));

	await expect(fetchNewComments('channel', 'token', null)).rejects.toThrow(
		'commentThreads.list response is missing or invalid'
	);
});

test('requests exactly one videos.list batch for fifty IDs', async () => {
	const ids = Array.from({ length: 50 }, (_, index) => `video-${index + 1}`);
	const fetch = vi.fn().mockResolvedValue(rawPage({ items: [] }));
	vi.stubGlobal('fetch', fetch);

	await fetchVideoMetadata(ids, 'token');

	// An off-by-one here sends an empty batch (id=) to YouTube on every run.
	expect(fetch).toHaveBeenCalledTimes(1);
	const url = new URL(String(fetch.mock.calls[0]?.[0]));
	expect(url.searchParams.get('part')).toBe('snippet');
	expect(url.searchParams.get('id')?.split(',')).toEqual(ids);
});

test('rejects a videos.list response without an items array', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawPage({})));

	await expect(fetchVideoMetadata(['video-1'], 'token')).rejects.toThrow(
		'videos.list response items is missing or invalid'
	);
});

test('rejects a videos.list response that is not a JSON object', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })));

	await expect(fetchVideoMetadata(['video-1'], 'token')).rejects.toThrow(
		'videos.list response is missing or invalid'
	);
});

test('defaults a missing or non-string video description to empty', async () => {
	const fetch = vi.fn().mockResolvedValue(rawPage({
		items: [
			{ id: 'missing', snippet: { title: 'Title missing' } },
			{ id: 'numeric', snippet: { title: 'Title numeric', description: 42 } }
		]
	}));
	vi.stubGlobal('fetch', fetch);

	const result = await fetchVideoMetadata(['missing', 'numeric'], 'token');

	expect(result.get('missing')).toEqual({ title: 'Title missing', description: '' });
	expect(result.get('numeric')).toEqual({ title: 'Title numeric', description: '' });
});

test.each([
	['missing', undefined],
	['empty', ''],
	['non-string', 42]
])('skips a video item with a %s title and logs the failing field', async (_label, title) => {
	const fetch = vi.fn().mockResolvedValue(rawPage({
		items: [{ id: 'bad', snippet: { title, description: 'd' } }]
	}));
	vi.stubGlobal('fetch', fetch);
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

	const result = await fetchVideoMetadata(['bad'], 'token');

	expect(result.has('bad')).toBe(false);
	expect(warn).toHaveBeenCalledWith(
		'videos.list response item is malformed; skipping it:',
		'videos.list response item 0',
		expect.objectContaining({
			message: expect.stringContaining('videos.list response item 0.snippet.title is missing or invalid')
		})
	);
});

test.each([
	[{ snippet: { title: 'T' } }, 'videos.list response item 0.id is missing or invalid'],
	[{ id: 'x' }, 'videos.list response item 0.snippet is missing or invalid']
])('skips a malformed video item %j and logs the failing field', async (item, message) => {
	const fetch = vi.fn().mockResolvedValue(rawPage({ items: [item] }));
	vi.stubGlobal('fetch', fetch);
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

	const result = await fetchVideoMetadata(['x'], 'token');

	expect(result.has('x')).toBe(false);
	expect(warn).toHaveBeenCalledWith(
		'videos.list response item is malformed; skipping it:',
		'videos.list response item 0',
		expect.objectContaining({ message: expect.stringContaining(message) })
	);
});

test('posts exactly one moderation batch for fifty comment IDs', async () => {
	const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
	vi.stubGlobal('fetch', fetch);
	const ids = Array.from({ length: 50 }, (_, index) => `comment-${index + 1}`);

	await setModerationStatus(ids, 'heldForReview', false, 'token');

	expect(fetch).toHaveBeenCalledTimes(1);
});

test.each(['heldForReview', 'published', 'likelySpam', 'rejected'] as const)(
	'returns the %s moderation status during recovery verification',
	async (status) => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawPage({
			items: [{ snippet: { moderationStatus: status } }]
		})));

		await expect(getCommentModerationStatus('comment', 'token')).resolves.toBe(status);
	}
);

test('fails loudly on an unsupported moderation status', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawPage({
		items: [{ snippet: { moderationStatus: 'spam' } }]
	})));

	// An unknown status must never be silently treated as a confirmed action (I2).
	await expect(getCommentModerationStatus('comment', 'token')).rejects.toThrow(
		'comments.list response moderationStatus is unsupported: spam'
	);
});

test('returns null when the comment is absent from the list', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawPage({ items: [] })));

	await expect(getCommentModerationStatus('comment', 'token')).resolves.toBeNull();
});

test('fails loudly when comments.list returns multiple comments', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawPage({
		items: [{ snippet: { moderationStatus: 'rejected' } }, { snippet: { moderationStatus: 'rejected' } }]
	})));

	await expect(getCommentModerationStatus('comment', 'token')).rejects.toThrow(
		'comments.list response returned multiple comments'
	);
});

test('fails loudly when comments.list items is missing', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawPage({})));

	await expect(getCommentModerationStatus('comment', 'token')).rejects.toThrow(
		'comments.list response items is missing or invalid'
	);
});

test('fails loudly when a comments.list response is not a JSON object', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })));

	await expect(getCommentModerationStatus('comment', 'token')).rejects.toThrow(
		'comments.list response is missing or invalid'
	);
});

test('fails loudly when moderationStatus is missing from the comment', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawPage({ items: [{ snippet: {} }] })));

	await expect(getCommentModerationStatus('comment', 'token')).rejects.toThrow(
		'comments.list response moderationStatus is missing or invalid'
	);
});

test.each([
	[[null], 'comments.list response item is missing or invalid'],
	[[{}], 'comments.list response item snippet is missing or invalid']
])('fails loudly when the comment entry is malformed: %j', async (items, message) => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawPage({ items })));

	await expect(getCommentModerationStatus('comment', 'token')).rejects.toThrow(message);
});

test('fails loudly when the comments.list request fails', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad request', { status: 400 })));

	await expect(getCommentModerationStatus('comment', 'token')).rejects.toThrow(
		'comments.list failed: 400 bad request'
	);
});

test('fails loudly when a commentThreads page is not valid JSON', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 200 })));

	await expect(fetchNewComments('channel', 'token', null)).rejects.toThrow(
		'commentThreads.list returned invalid JSON'
	);
});

test.each(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'both'] as const)(
	'refreshAccessToken fails loudly when %s is not configured',
	async (which) => {
		if (which !== 'GOOGLE_CLIENT_SECRET') mocks.env.GOOGLE_CLIENT_ID = undefined;
		if (which !== 'GOOGLE_CLIENT_ID') mocks.env.GOOGLE_CLIENT_SECRET = undefined;
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);

		await expect(refreshAccessToken('refresh-token')).rejects.toThrow(
			'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required'
		);
		expect(fetch).not.toHaveBeenCalled();
	}
);

test('refreshAccessToken posts the refresh grant to the Google token endpoint', async () => {
	const fetch = vi.fn().mockResolvedValue(rawPage({ access_token: 'fresh-token' }));
	vi.stubGlobal('fetch', fetch);

	await expect(refreshAccessToken('refresh-token')).resolves.toBe('fresh-token');

	expect(fetch).toHaveBeenCalledTimes(1);
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
	expect(url).toBe('https://oauth2.googleapis.com/token');
	expect(init.method).toBe('POST');
	expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
	const body = String(init.body);
	expect(body).toContain('client_id=client-id');
	expect(body).toContain('client_secret=client-secret');
	expect(body).toContain('refresh_token=refresh-token');
	expect(body).toContain('grant_type=refresh_token');
});

test('refreshAccessToken fails loudly when the token endpoint rejects the grant', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid_grant', { status: 400 })));

	await expect(refreshAccessToken('refresh-token')).rejects.toThrow(
		'token refresh failed: 400 invalid_grant'
	);
});

test('refreshAccessToken fails loudly when the token response is not JSON', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 200 })));

	await expect(refreshAccessToken('refresh-token')).rejects.toThrow('token refresh returned invalid JSON');
});

test('refreshAccessToken fails loudly when the token response is not a JSON object', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })));

	await expect(refreshAccessToken('refresh-token')).rejects.toThrow(
		'token refresh response is missing or invalid'
	);
});

test('refreshAccessToken fails loudly when the token response lacks an access token', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawPage({})));

	await expect(refreshAccessToken('refresh-token')).rejects.toThrow(
		'token refresh response access_token is missing or invalid'
	);
});
