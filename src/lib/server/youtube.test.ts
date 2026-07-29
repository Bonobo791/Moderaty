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
import { fetchNewComments, setModerationStatus } from './youtube';

function comment(id: string, publishedAt: string) {
	return {
		id: `thread-${id}`,
		snippet: {
			topLevelComment: {
				id,
				snippet: {
					authorChannelId: { value: `author-${id}` },
					authorDisplayName: `Author ${id}`,
					textDisplay: `Comment ${id}`,
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

test('batches moderation-status updates into groups of fifty', async () => {
	const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
	vi.stubGlobal('fetch', fetch);
	const ids = Array.from({ length: 101 }, (_, index) => `comment-${index + 1}`);

	await setModerationStatus(ids, 'rejected', false, 'token');

	expect(fetch).toHaveBeenCalledTimes(3);
	const batches = fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('id')!.split(','));
	expect(batches).toEqual([ids.slice(0, 50), ids.slice(50, 100), ids.slice(100)]);
});
