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
import { fetchNewComments, getCommentModerationStatus, setModerationStatus } from './youtube';

function comment(id: string, publishedAt: string, text = `Comment ${id}`) {
	return {
		id: `thread-${id}`,
		snippet: {
			topLevelComment: {
				id,
				snippet: {
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
	const fetch = vi.fn().mockResolvedValue(page([
		deletedAuthor,
		comment('normal', '2026-01-03T00:00:00.000Z')
	]));
	vi.stubGlobal('fetch', fetch);
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

	const result = await fetchNewComments('channel', 'token', null);

	expect(result.comments.map((item) => item.id)).toEqual(['deleted', 'normal']);
	expect(result.comments[0]).toMatchObject({ authorChannelId: '', authorName: '[unavailable author]' });
	expect(warn).toHaveBeenCalled();
});

test('skips a malformed comment without failing the page', async () => {
	const malformed = comment('malformed', '2026-01-04T00:00:00.000Z');
	delete (malformed.snippet.topLevelComment.snippet as Record<string, unknown>).textDisplay;
	const fetch = vi.fn()
		.mockResolvedValueOnce(page([
			malformed,
			comment('normal', '2026-01-03T00:00:00.000Z')
		], 'page-2'))
		.mockResolvedValueOnce(page([comment('next', '2026-01-02T00:00:00.000Z')]));
	vi.stubGlobal('fetch', fetch);
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

	const result = await fetchNewComments('channel', 'token', null);

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
