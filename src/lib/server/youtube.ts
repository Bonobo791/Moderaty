// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { env } from '$env/dynamic/private';
import { fetchWithRetry } from '$lib/server/http';

const YT = 'https://www.googleapis.com/youtube/v3';

type JsonObject = Record<string, unknown>;

export interface NewComment {
	id: string;
	threadId: string;
	videoId: string | null;
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

export type CommentModerationStatus = 'heldForReview' | 'rejected' | 'published' | 'likelySpam';

function object(value: unknown, context: string): JsonObject {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${context} is missing or invalid`);
	}
	return value as JsonObject;
}

function requiredString(value: unknown, context: string): string {
	if (typeof value !== 'string' || !value) throw new Error(`${context} is missing or invalid`);
	return value;
}

function optionalPageToken(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	return requiredString(value, 'commentThreads.list response nextPageToken');
}

async function jsonResponse(response: Response, operation: string): Promise<unknown> {
	const body = await response.text();
	if (!response.ok) throw new Error(`${operation} failed: ${response.status} ${body}`);
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new Error(`${operation} returned invalid JSON`);
	}
}

function optionalString(value: unknown): string | null {
	return typeof value === 'string' && value ? value : null;
}

function parseComment(item: unknown, index: number): NewComment | null {
	const context = `commentThreads.list response item ${index}`;
	const thread = object(item, context);
	const topLevelComment = object(object(thread.snippet, `${context}.snippet`).topLevelComment, `${context}.topLevelComment`);
	const snippet = object(topLevelComment.snippet, `${context}.topLevelComment.snippet`);
	const id = optionalString(topLevelComment.id);
	const threadId = optionalString(thread.id);
	const publishedAt = optionalString(snippet.publishedAt);
	const text = optionalString(snippet.textDisplay);
	// Stryker disable next-line StringLiteral: equivalent — object() already validated thread.snippet above, so this context string belongs to an unreachable throw
	const videoId = optionalString(snippet.videoId) ?? optionalString(object(thread.snippet, `${context}.snippet`).videoId);
	if (!id || !threadId || !text || !publishedAt || Number.isNaN(Date.parse(publishedAt))) {
		console.warn(`${context} is malformed (missing id, text, or a valid publishedAt); skipping it`);
		return null;
	}
	if (!videoId) {
		// Omni moderation and rule matching do not need a videoId — keep the
		// comment and let tone scoring degrade to empty context (best-effort).
		console.warn(`${context} (comment ${id}) has no videoId; tone context will be empty`);
	}
	const channelIdObject = snippet.authorChannelId;
	const authorChannelId =
		// Stryker disable next-line ConditionalExpression: equivalent — authorChannelId comes from JSON.parse, so a truthy non-object is a string/number/boolean primitive, whose .value is always undefined, matching the null branch
		channelIdObject && typeof channelIdObject === 'object' && !Array.isArray(channelIdObject)
			? optionalString((channelIdObject as JsonObject).value)
			: null;
	if (authorChannelId === null) {
		console.warn(`${context} (comment ${id}) has no authorChannelId; the author channel may be deleted`);
	}
	const authorName = optionalString(snippet.authorDisplayName);
	if (authorName === null) {
		console.warn(`${context} (comment ${id}) has no authorDisplayName; the author channel may be deleted`);
	}
	return {
		id,
		threadId,
		videoId,
		authorChannelId: authorChannelId ?? '',
		authorName: authorName ?? '[unavailable author]',
		text,
		publishedAt
	};
}

const MAX_VIDEO_DESCRIPTION_LENGTH = 500;

/**
 * Fetches titles and descriptions for videos, for tone-scoring context.
 *
 * @param videoIds - The video IDs to look up (batched 50 per API call).
 * @param accessToken - The OAuth access token for the YouTube API.
 * @param deadline - Optional request deadline.
 * @returns A map from video ID to its title and truncated description; videos
 * whose metadata fails validation are omitted (and logged), never fatal.
 */
export async function fetchVideoMetadata(
	videoIds: string[],
	accessToken: string,
	deadline?: number
): Promise<Map<string, { title: string; description: string }>> {
	const out = new Map<string, { title: string; description: string }>();
	for (let i = 0; i < videoIds.length; i += 50) {
		const batch = videoIds.slice(i, i + 50);
		const params = new URLSearchParams({ part: 'snippet', id: batch.join(',') });
		const res = await ytFetch(`/videos?${params}`, accessToken, undefined, deadline);
		const data = object(await jsonResponse(res, 'videos.list'), 'videos.list response');
		if (!Array.isArray(data.items)) throw new Error('videos.list response items is missing or invalid');
		for (const [index, item] of data.items.entries()) {
			const context = `videos.list response item ${index}`;
			try {
				const video = object(item, context);
				const id = requiredString(video.id, `${context}.id`);
				const snippet = object(video.snippet, `${context}.snippet`);
				const title = requiredString(snippet.title, `${context}.snippet.title`);
				out.set(id, {
					title,
					description: optionalString(snippet.description)?.slice(0, MAX_VIDEO_DESCRIPTION_LENGTH) ?? ''
				});
			} catch (error) {
				console.warn('videos.list response item is malformed; skipping it:', context, error);
			}
		}
	}
	return out;
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
	const data = object(await jsonResponse(res, 'token refresh'), 'token refresh response');
	return requiredString(data.access_token, 'token refresh response access_token');
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
		// Stryker disable next-line LogicalOperator: equivalent — no ytFetch caller passes init.headers, so `init?.headers` is always undefined and spreading `?? {}` vs `&& {}` yields identical headers
		headers: { Authorization: `Bearer ${accessToken}`, ...init?.headers }
	}, deadline);
	return res;
}

/**
 * Fetches recent top-level comments for a YouTube channel.
 *
 * Stops when the cursor boundary is reached or the configured page limit is exhausted.
 *
 * @param cursor - Timestamp boundary; comments published earlier than this instant are excluded.
 * Any `Date.parse`-valid timestamp is accepted and compared by instant, not lexicographically.
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
	const cursorMs = cursor === null ? null : Date.parse(cursor);
	// Stryker disable next-line ConditionalExpression: equivalent — cursorMs is null only when cursor is null, and Number.isNaN(null) is false, so replacing the null check with `true` cannot change the outcome
	if (cursorMs !== null && Number.isNaN(cursorMs)) {
		throw new Error(`fetchNewComments cursor is invalid: ${cursor}`);
	}
	for (let page = 0; page < maxPages; page++) {
		const { items, nextPageToken } = await fetchCommentPage(channelId, accessToken, pageToken, deadline);
		const reachedCursor = collectUntilCursor(items, cursorMs, out);
		if (reachedCursor || !nextPageToken) {
			return { comments: out, nextPageToken: null, reachedCursor };
		}
		pageToken = nextPageToken;
	}
	return { comments: out, nextPageToken: pageToken, reachedCursor: false };
}

/** Fetches one page of comment threads for the channel (≤100 comments, I10). */
async function fetchCommentPage(
	channelId: string,
	accessToken: string,
	pageToken: string | null,
	deadline: number | undefined
): Promise<{ items: unknown[]; nextPageToken: string | null }> {
	const params = new URLSearchParams({
		part: 'snippet',
		allThreadsRelatedToChannelId: channelId,
		order: 'time',
		maxResults: '100',
		textFormat: 'plainText'
	});
	if (pageToken) params.set('pageToken', pageToken);
	const res = await ytFetch(`/commentThreads?${params}`, accessToken, undefined, deadline);
	const data = object(await jsonResponse(res, 'commentThreads.list'), 'commentThreads.list response');
	if (!Array.isArray(data.items)) throw new Error('commentThreads.list response items is missing or invalid');
	return { items: data.items as unknown[], nextPageToken: optionalPageToken(data.nextPageToken) };
}

/** Pushes parsed comments into out until the cursor boundary, returning whether it was reached. */
function collectUntilCursor(items: unknown[], cursorMs: number | null, out: NewComment[]): boolean {
	for (const [index, item] of items.entries()) {
		const comment = parseComment(item, index);
		if (!comment) continue;
		if (cursorMs !== null && Date.parse(comment.publishedAt) < cursorMs) return true;
		out.push(comment);
	}
	return false;
}

/**
 * Updates the moderation status of comments, optionally banning their authors.
 *
 * `'published'` restores a held or rejected comment (undo). A deleted comment
 * is gone for good and an author ban cannot be lifted — YouTube offers no API
 * for either.
 *
 * @param ids - The comment IDs to update
 * @param status - The moderation status to apply
 * @param banAuthor - Whether to ban the authors of the comments
 */
export async function setModerationStatus(
	ids: string[],
	status: 'heldForReview' | 'rejected' | 'published',
	banAuthor: boolean,
	accessToken: string,
	deadline?: number
): Promise<void> {
	for (let i = 0; i < ids.length; i += 50) {
		const batch = ids.slice(i, i + 50);
		const params = new URLSearchParams({
			id: batch.join(','),
			moderationStatus: status
		});
		// banAuthor is only valid alongside 'rejected' (and defaults to false) —
		// sending it with 'heldForReview'/'published' risks a 400 from YouTube.
		if (banAuthor) params.set('banAuthor', 'true');
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
 * Returns a comment's current moderation status, or null when it no longer exists.
 *
 * @param id - The YouTube comment ID.
 * @param accessToken - The OAuth access token for the YouTube API.
 * @param deadline - Optional request deadline.
 */
export async function getCommentModerationStatus(
	id: string,
	accessToken: string,
	deadline?: number
): Promise<CommentModerationStatus | null> {
	const params = new URLSearchParams({ part: 'snippet', id });
	const res = await ytFetch(`/comments?${params}`, accessToken, undefined, deadline);
	if (res.status === 404) return null;
	const data = object(await jsonResponse(res, 'comments.list'), 'comments.list response');
	if (!Array.isArray(data.items)) throw new Error('comments.list response items is missing or invalid');
	if (!data.items.length) return null;
	if (data.items.length !== 1) throw new Error('comments.list response returned multiple comments');
	const status = requiredString(
		object(object(data.items[0], 'comments.list response item').snippet, 'comments.list response item snippet').moderationStatus,
		'comments.list response moderationStatus'
	);
	if (status !== 'heldForReview' && status !== 'rejected' && status !== 'published' && status !== 'likelySpam') {
		throw new Error(`comments.list response moderationStatus is unsupported: ${status}`);
	}
	return status;
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
