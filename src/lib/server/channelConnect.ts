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

// Multi-channel connect: when one Google account owns several YouTube
// channels, the OAuth callback parks the granted refresh token plus the
// candidate channels here until the user picks ONE at /connect-channel. The
// refresh token is never persisted before that pick — we don't store tokens
// for channels that were never connected. Also home to the single conditional
// upsert both the single-channel callback path and the picker action run, so
// the cross-team ownership guard exists in exactly one place. Cookie pattern
// mirrors the pending-consent cookie in legal.ts (encrypted, state-keyed,
// 10-minute TTL, bounded entries).

import type { Cookies } from '@sveltejs/kit';

import { eq, isNull, or } from 'drizzle-orm';

import { decrypt, encrypt } from '$lib/server/crypto';
import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { cookieSecure } from '$lib/server/oauthState';

import type { SessionUser } from '$lib/server/session';

export const CHANNEL_PICK_COOKIE = 'moderaty_channel_pick_pending';
const PICK_TTL_MS = 10 * 60 * 1000;
// Bounds the cookie; a user realistically has one or two tabs mid-flow. Each
// parked pick is keyed by its flow's OAuth state so concurrent tabs connecting
// different accounts never overwrite one another.
const MAX_PENDING_PICKS = 5;

/** What the OAuth callback parks for the picker: the grant plus its channels. */
export type PendingChannelPick = {
	refreshToken: string;
	channels: Array<{ id: string; title: string }>;
};

type PickEntry = PendingChannelPick & { state: string; ts: number };

function readEntries(cookies: Cookies): PickEntry[] {
	const raw = cookies.get(CHANNEL_PICK_COOKIE);
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(decrypt(raw));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(
		(e): e is PickEntry =>
			typeof e === 'object' && e !== null && typeof (e as PickEntry).state === 'string'
	) as PickEntry[];
}

function writeEntries(cookies: Cookies, entries: PickEntry[]): void {
	if (entries.length === 0) {
		cookies.delete(CHANNEL_PICK_COOKIE, { path: '/' });
		return;
	}
	cookies.set(CHANNEL_PICK_COOKIE, encrypt(JSON.stringify(entries)), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: cookieSecure(),
		maxAge: PICK_TTL_MS / 1000
	});
}

/**
 * Parks a granted YouTube refresh token and its candidate channels, keyed by
 * the OAuth state of the flow, in a short-lived encrypted httpOnly cookie.
 * AES-GCM makes the payload tamper-proof and confidential, so the picker can
 * trust that both the token and the channel list came from Google's callback.
 */
export function parkPendingChannelPick(cookies: Cookies, state: string, payload: PendingChannelPick): void {
	const now = Date.now();
	const entries = readEntries(cookies).filter(
		(e) => e.state !== state && now - e.ts <= PICK_TTL_MS
	);
	entries.push({ ...payload, state, ts: now });
	writeEntries(cookies, entries.slice(-MAX_PENDING_PICKS));
}

/**
 * Reads and validates the parked pick for ONE flow. Returns null when the
 * entry is missing, tampered, malformed, or expired — the caller fails loudly
 * so the user reconnects. Other flows' entries are untouched.
 */
export function readPendingChannelPick(cookies: Cookies, state: string): PendingChannelPick | null {
	const entry = readEntries(cookies).find((e) => e.state === state);
	if (!entry || typeof entry.ts !== 'number' || Date.now() - entry.ts > PICK_TTL_MS) return null;
	if (typeof entry.refreshToken !== 'string' || !entry.refreshToken) return null;
	if (!Array.isArray(entry.channels) || entry.channels.length === 0) return null;
	const valid = entry.channels.every(
		(c) => typeof c === 'object' && c !== null && typeof c.id === 'string' && c.id && typeof c.title === 'string'
	);
	if (!valid) return null;
	return { refreshToken: entry.refreshToken, channels: entry.channels };
}

/** Clears only this flow's parked pick once the channel is connected. */
export function clearPendingChannelPick(cookies: Cookies, state: string): void {
	writeEntries(
		cookies,
		readEntries(cookies).filter((e) => e.state !== state)
	);
}

/**
 * The one conditional channel upsert. A channel already owned by another team
 * must not be reattached (or have its refresh token overwritten) by this one;
 * a teammate re-connecting a channel their team already owns IS allowed (the
 * token-handover path). The conditional upsert keeps that check atomic with
 * the write — a SELECT-then-upsert would race. Returns 'conflict' when the
 * row belongs to a different org and was left untouched.
 */
export async function upsertChannelConnection(
	user: SessionUser,
	channel: { id: string; title: string },
	refreshToken: string
): Promise<'ok' | 'conflict'> {
	const refreshTokenEnc = encrypt(refreshToken);
	const updated = await db
		.insert(channels)
		.values({
			id: channel.id,
			userId: user.id,
			orgId: user.orgId,
			title: channel.title,
			refreshTokenEnc,
			active: 1,
			createdAt: new Date().toISOString()
		})
		.onConflictDoUpdate({
			target: channels.id,
			set: { userId: user.id, orgId: user.orgId, title: channel.title, refreshTokenEnc, active: 1 },
			setWhere: or(isNull(channels.orgId), eq(channels.orgId, user.orgId))
		})
		.returning({ id: channels.id });
	return updated.length === 0 ? 'conflict' : 'ok';
}
