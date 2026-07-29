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

import { env } from '$env/dynamic/private';
import { fetchWithRetry } from '$lib/server/http';

const YT = 'https://www.googleapis.com/youtube/v3';

export interface NewComment {
	id: string;
	threadId: string;
	authorChannelId: string;
	authorName: string;
	text: string;
	publishedAt: string;
}

export interface FetchCommentsOptions {
	maxPages?: number;
	pageToken?: string | null;
	deadline?: number;
}

export interface CommentPage {
	comments: NewComment[];
	nextPageToken: string | null;
	reachedCursor: boolean;
}

/**
 * Refreshes an OAuth access token using a Google refresh token.
 *
 * @param refreshToken - The Google OAuth refresh token.
 * @returns The refreshed OAuth access token.
 */
export async function refreshAccessToken(refreshToken: string, deadline?: number): Promise<string> {
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required');
	}
	const res = await fetchWithRetry('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			refresh_token: refreshToken,
			grant_type: 'refresh_token'
		})
	}, deadline);
	const data = await res.json();
	if (!res.ok || !data.access_token) {
		throw new Error(`token refresh failed: ${res.status} ${JSON.stringify(data)}`);
	}
	return data.access_token as string;
}

/**
 * Sends an authenticated request to the YouTube Data API.
 *
 * @param path - The API path to append to the YouTube API base URL
 * @param accessToken - The OAuth access token used for authorization
 * @param init - Optional request configuration
 * @param deadline - Optional request deadline
 * @returns The raw API response
 */
async function ytFetch(
	path: string,
	accessToken: string,
	init?: RequestInit,
	deadline?: number
): Promise<Response> {
	const res = await fetchWithRetry(`${YT}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) }
	}, deadline);
	return res;
}

/**
 * Fetches recent top-level comments for a YouTube channel.
 *
 * Stops when the cursor boundary is reached or the configured page limit is exhausted. Comment text is limited to 500 characters.
 *
 * @param cursor - Timestamp boundary; comments published earlier than this value are excluded.
 * @param maxPages - Maximum number of API pages to fetch.
 * @param pageToken - Token for the initial API page.
 * @param deadline - Optional request deadline.
 * @returns The fetched comments, a token for the next page when applicable, and whether the cursor boundary was reached.
 */
export async function fetchNewComments(
	channelId: string,
	accessToken: string,
	cursor: string | null,
	{ maxPages = 3, pageToken: initialPageToken = null, deadline }: FetchCommentsOptions = {}
): Promise<CommentPage> {
	const out: NewComment[] = [];
	let pageToken = initialPageToken;
	for (let page = 0; page < maxPages; page++) {
		const params = new URLSearchParams({
			part: 'snippet',
			allThreadsRelatedToChannelId: channelId,
			order: 'time',
			maxResults: '100',
			textFormat: 'plainText'
		});
		if (pageToken) params.set('pageToken', pageToken);
		const res = await ytFetch(`/commentThreads?${params}`, accessToken, undefined, deadline);
		const data = await res.json();
		if (!res.ok) throw new Error(`commentThreads.list failed: ${res.status} ${JSON.stringify(data)}`);
		let reachedCursor = false;
		for (const item of data.items ?? []) {
			const c = item.snippet.topLevelComment;
			const s = c.snippet;
			if (cursor && s.publishedAt < cursor) {
				reachedCursor = true;
				break;
			}
			out.push({
				id: c.id,
				threadId: item.id,
				authorChannelId: s.authorChannelId?.value ?? 'unknown',
				authorName: s.authorDisplayName ?? 'unknown',
				text: (s.textDisplay ?? '').slice(0, 500),
				publishedAt: s.publishedAt
			});
		}
		if (reachedCursor || !data.nextPageToken) {
			return { comments: out, nextPageToken: null, reachedCursor };
		}
		pageToken = data.nextPageToken;
	}
	return { comments: out, nextPageToken: pageToken, reachedCursor: false };
}

/**
 * Updates the moderation status of comments, optionally banning their authors.
 *
 * @param ids - The comment IDs to update
 * @param status - The moderation status to apply
 * @param banAuthor - Whether to ban the authors of the comments
 */
export async function setModerationStatus(
	ids: string[],
	status: 'heldForReview' | 'rejected',
	banAuthor: boolean,
	accessToken: string,
	deadline?: number
): Promise<void> {
	for (let i = 0; i < ids.length; i += 50) {
		const batch = ids.slice(i, i + 50);
		const params = new URLSearchParams({
			id: batch.join(','),
			moderationStatus: status,
			banAuthor: String(banAuthor)
		});
		const res = await ytFetch(
			`/comments/setModerationStatus?${params}`,
			accessToken,
			{ method: 'POST' },
			deadline
		);
		if (!res.ok) {
			const body = await res.text();
			throw new Error(`setModerationStatus failed: ${res.status} ${body}`);
		}
	}
}

/**
 * Deletes a YouTube comment.
 *
 * A missing comment is treated as a successful deletion.
 *
 * @param id - The ID of the comment to delete
 * @param accessToken - The OAuth access token for the YouTube API
 * @param deadline - Optional request deadline
 */
export async function deleteComment(id: string, accessToken: string, deadline?: number): Promise<void> {
	const res = await ytFetch(
		`/comments?id=${encodeURIComponent(id)}`,
		accessToken,
		{ method: 'DELETE' },
		deadline
	);
	if (!res.ok && res.status !== 404) {
		const body = await res.text();
		throw new Error(`comments.delete failed: ${res.status} ${body}`);
	}
}
