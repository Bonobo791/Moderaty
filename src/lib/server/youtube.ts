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

const YT = 'https://www.googleapis.com/youtube/v3';

export interface NewComment {
	id: string;
	threadId: string;
	authorChannelId: string;
	authorName: string;
	text: string;
	publishedAt: string;
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID!,
			client_secret: env.GOOGLE_CLIENT_SECRET!,
			refresh_token: refreshToken,
			grant_type: 'refresh_token'
		})
	});
	const data = await res.json();
	if (!res.ok || !data.access_token) {
		throw new Error(`token refresh failed: ${res.status} ${JSON.stringify(data)}`);
	}
	return data.access_token as string;
}

async function ytFetch(path: string, accessToken: string, init?: RequestInit): Promise<Response> {
	const res = await fetch(`${YT}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) }
	});
	return res;
}

export async function fetchNewComments(
	channelId: string,
	accessToken: string,
	cursor: string | null
): Promise<NewComment[]> {
	const out: NewComment[] = [];
	let pageToken: string | null = null;
	for (let page = 0; page < 3; page++) {
		const params = new URLSearchParams({
			part: 'snippet',
			allThreadsRelatedToChannelId: channelId,
			order: 'time',
			maxResults: '100',
			textFormat: 'plainText'
		});
		if (pageToken) params.set('pageToken', pageToken);
		const res = await ytFetch(`/commentThreads?${params}`, accessToken);
		const data = await res.json();
		if (!res.ok) throw new Error(`commentThreads.list failed: ${res.status} ${JSON.stringify(data)}`);
		let reachedCursor = false;
		for (const item of data.items ?? []) {
			const c = item.snippet.topLevelComment;
			const s = c.snippet;
			if (cursor && s.publishedAt <= cursor) {
				reachedCursor = true;
				continue;
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
		if (reachedCursor || !data.nextPageToken) break;
		pageToken = data.nextPageToken;
	}
	return out;
}

export async function setModerationStatus(
	ids: string[],
	status: 'heldForReview' | 'rejected',
	banAuthor: boolean,
	accessToken: string
): Promise<void> {
	for (let i = 0; i < ids.length; i += 50) {
		const batch = ids.slice(i, i + 50);
		const params = new URLSearchParams({
			id: batch.join(','),
			moderationStatus: status,
			banAuthor: String(banAuthor)
		});
		const res = await ytFetch(`/comments/setModerationStatus?${params}`, accessToken, { method: 'POST' });
		if (!res.ok) {
			const body = await res.text();
			throw new Error(`setModerationStatus failed: ${res.status} ${body}`);
		}
	}
}

export async function deleteComment(id: string, accessToken: string): Promise<void> {
	const res = await ytFetch(`/comments?id=${encodeURIComponent(id)}`, accessToken, { method: 'DELETE' });
	if (!res.ok && res.status !== 404) {
		const body = await res.text();
		throw new Error(`comments.delete failed: ${res.status} ${body}`);
	}
}
