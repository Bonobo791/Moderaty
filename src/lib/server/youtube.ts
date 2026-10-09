import { env } from '$env/dynamic/private';
import { fetchSingleAttempt, fetchWithRetry } from '$lib/server/http';

const YT = 'https://www.googleapis.com/youtube/v3';

/**
 * YouTube caps comma-separated `id` list parameters at 50 per request
 * (videos.list, comments.setModerationStatus). Every batching
 * loop that talks to those endpoints must share this bound.
 */
export const YOUTUBE_ID_BATCH_SIZE = 50;

type JsonObject = Record<string, unknown>;

export interface NewComment {
	id: string;
	threadId: string;
	videoId: string | null;
	authorChannelId: string;
	authorName: string;
	/** Verified configured handle, populated by protection matching only. */
	authorHandle?: string | null;
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

export class CommentNotFoundError extends Error {
	commentIds: string[];

	constructor(commentIds: string[]) {
		super(`comments not found on YouTube: ${commentIds.join(', ')}`);
		this.name = 'CommentNotFoundError';
		this.commentIds = [...commentIds];
	}
}

/** A settled validation/auth/quota refusal proves this attempt did not apply. */
export class YoutubeWriteRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'YoutubeWriteRefusedError';
	}
}

function writeFailure(status: number, message: string): Error {
	return [400, 401, 403, 405, 422, 429].includes(status) ? new YoutubeWriteRefusedError(message) : new Error(message);
}

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
 * @param videoIds - The video IDs to look up (batched YOUTUBE_ID_BATCH_SIZE per API call).
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
	const batches: string[][] = [];
	for (let i = 0; i < videoIds.length; i += YOUTUBE_ID_BATCH_SIZE) {
		batches.push(videoIds.slice(i, i + YOUTUBE_ID_BATCH_SIZE));
	}
	const responses = await Promise.all(
		batches.map(async (batch) => {
			const params = new URLSearchParams({ part: 'snippet', id: batch.join(',') });
			const res = await ytFetch(`/videos?${params}`, accessToken, undefined, deadline);
			const data = object(await jsonResponse(res, 'videos.list'), 'videos.list response');
			if (!Array.isArray(data.items)) throw new Error('videos.list response items is missing or invalid');
			return data.items;
		})
	);
	for (const items of responses) {
		for (const [index, item] of items.entries()) {
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
	deadline?: number,
	singleAttempt = false
): Promise<Response> {
	const request = singleAttempt ? fetchSingleAttempt : fetchWithRetry;
	const res = await request(`${YT}${path}`, {
		...init,
		// Normalize the caller's headers into a plain object before spreading:
		// spreading a Headers instance (or tuple array) yields an empty object,
		// silently dropping the caller's headers. Authorization is set LAST so
		// it always wins.
		headers: { ...callerHeaders(init), Authorization: `Bearer ${accessToken}` }
	}, deadline);
	return res;
}

/** Normalizes RequestInit.headers (Headers | tuples | record | undefined) to a plain record. */
function callerHeaders(init?: RequestInit): Record<string, string> {
	if (!init?.headers) return {};
	if (init.headers instanceof Headers) return Object.fromEntries(init.headers.entries());
	if (Array.isArray(init.headers)) return Object.fromEntries(init.headers);
	return init.headers as Record<string, string>;
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
	deadline?: number,
	singleAttempt = false
): Promise<void> {
	for (let i = 0; i < ids.length; i += YOUTUBE_ID_BATCH_SIZE) {
		const batch = ids.slice(i, i + YOUTUBE_ID_BATCH_SIZE);
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
			deadline,
			singleAttempt
		);
		if (res.status === 404) throw new CommentNotFoundError(batch);
		if (!res.ok) {
			const body = await res.text();
			throw writeFailure(res.status, `setModerationStatus failed: ${res.status} ${body}`);
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
export async function deleteComment(id: string, accessToken: string, deadline?: number, singleAttempt = false): Promise<void> {
	const res = await ytFetch(
		`/comments?id=${encodeURIComponent(id)}`,
		accessToken,
		{ method: 'DELETE' },
		deadline,
		singleAttempt
	);
	if (!res.ok && res.status !== 404) {
		const body = await res.text();
		throw writeFailure(res.status, `comments.delete failed: ${res.status} ${body}`);
	}
}

/** A verified empty lookup, safe to explain to the channel owner. */
export class HandleNotFoundError extends Error {
	constructor() {
		super('No YouTube channel uses this handle');
		this.name = 'HandleNotFoundError';
	}
}

/** Resolve the handle filter to its authoritative channel identity. */
export async function resolveHandleChannelId(handle: string, accessToken: string, deadline?: number): Promise<string> {
	const params = new URLSearchParams({ part: 'id', forHandle: handle });
	const response = await ytFetch(`/channels?${params}`, accessToken, {}, deadline);
	if (!response.ok) throw new YoutubeLookupError(response.status, await response.text());
	const payload = object(await response.json(), 'YouTube handle lookup response');
	const items: unknown = payload.items;
	if (!Array.isArray(items)) throw new Error('YouTube handle lookup returned malformed data');
	if (items.length === 0) throw new HandleNotFoundError();
	if (items.length !== 1) throw new Error('YouTube handle must resolve to exactly one channel');
	const item = object(items[0], 'YouTube handle lookup channel');
	const id = requiredString(item.id, 'YouTube handle lookup channel identity');
	if (!id.trim() || id !== id.trim()) throw new Error('YouTube handle lookup returned an invalid channel identity');
	return id;
}

/** Provider details remain server-side; form actions return fixed messages. */
export class YoutubeLookupError extends Error {
	constructor(readonly httpStatus: number, body: string) {
		super(`YouTube handle lookup failed: HTTP ${httpStatus} ${body}`);
	}
}

async function fetchIdentitySnippets(resource: 'channels' | 'comments', ids: string[], accessToken: string, deadline?: number) {
	const result = new Map<string, Record<string, unknown>>();
	let skippedItems = 0;
	const unique = [...new Set(ids.filter(Boolean))];
	for (let index = 0; index < unique.length; index += YOUTUBE_ID_BATCH_SIZE) {
		const batch = unique.slice(index, index + YOUTUBE_ID_BATCH_SIZE);
		const params = new URLSearchParams({part: 'snippet', id: batch.join(','), maxResults: '50'});
		const response = await ytFetch(`/${resource}?${params}`, accessToken, {}, deadline);
		const payload = object(await jsonResponse(response, `${resource}.list identity lookup`), 'identity lookup response');
		if (!Array.isArray(payload.items)) throw new Error('Identity lookup returned malformed items');
		for (const raw of payload.items) {
			try {
				const item = object(raw, 'identity lookup item');
				const id = requiredString(item.id, 'identity lookup ID');
				if (!batch.includes(id)) throw new Error('Unexpected identity lookup ID');
				result.set(id, object(item.snippet, 'identity lookup snippet'));
			} catch { skippedItems += 1; }
		}
	}
	if (skippedItems) console.warn('YouTube identity lookup skipped malformed items', { resource, skippedItems });
	return { snippets: result, skippedItems };
}

/** Authoritative normalized handles for audit retention; IDs stay in memory. */
export async function fetchAuthorHandles(ids: string[], accessToken: string, deadline?: number): Promise<Map<string, string> & { skippedItems?: number }> {
	const { snippets, skippedItems } = await fetchIdentitySnippets('channels', ids, accessToken, deadline);
	const result = new Map<string, string>();
	for (const [id, snippet] of snippets) {
		const raw = snippet.customUrl;
		if (typeof raw !== 'string' || !raw.startsWith('@')) continue;
		const handle = raw.slice(1).toLowerCase();
		if (/^[\p{L}\p{N}._-]{3,30}$/u.test(handle)) result.set(id, handle);
	}
	return skippedItems ? Object.assign(result, { skippedItems }) : result;
}

/** Re-read pending comment authors before destructive enforcement, without storage. */
export async function fetchCommentAuthorIds(ids: string[], accessToken: string, deadline?: number): Promise<Map<string, string>> {
	const { snippets } = await fetchIdentitySnippets('comments', ids, accessToken, deadline);
	const result = new Map<string, string>();
	for (const [id, snippet] of snippets) {
		const author = snippet.authorChannelId;
		if (author && typeof author === 'object' && !Array.isArray(author)) {
			const value = (author as Record<string, unknown>).value;
			if (typeof value === 'string' && value.trim() === value && value) result.set(id, value);
		}
	}
	return result;
}
