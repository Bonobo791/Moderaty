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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

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

/**
 * The channel-connect OAuth state is SELF-AUTHENTICATING: the state value is
 * the AES-256-GCM-encrypted `{ userId, ts }` of the flow's starter (see
 * createChannelState/decodeChannelState below), so the callback derives the
 * starter from the state itself. The shared `oauth_state` cookie holds the
 * opaque state strings (login and channel flows share it) and remains the CSRF
 * layer; the binding cookie it used to pair with is gone.
 */
const CHANNEL_STATE_TTL_MS = 10 * 60 * 1000;

export function createChannelState(userId: string): string {
	return encrypt(JSON.stringify({ userId, ts: Date.now() }));
}

/** Decodes a channel-connect state; null when forged, tampered, or expired. */
export function decodeChannelState(state: string): { userId: string } | null {
	try {
		const plain = decrypt(state);
		if (plain === null) return null;
		const payload: unknown = JSON.parse(plain);
		if (typeof payload !== 'object' || payload === null) return null;
		const p = payload as { userId?: unknown; ts?: unknown };
		if (typeof p.userId !== 'string' || !p.userId) return null;
		// TTL + a future-ts guard (clock skew must not mint a fresh lease).
		if (typeof p.ts !== 'number' || p.ts > Date.now() || Date.now() - p.ts > CHANNEL_STATE_TTL_MS) return null;
		return { userId: p.userId };
	} catch {
		return null;
	}
}

/** What the OAuth callback parks for the picker: the grant plus its channels. */
export type PendingChannelPick = {
	refreshToken: string;
	channels: Array<{ id: string; title: string }>;
};

type PickEntry = PendingChannelPick & { state: string; ts: number; userId: string };

function readEntries(cookies: Cookies): PickEntry[] {
	const raw = cookies.get(CHANNEL_PICK_COOKIE);
	// Stryker disable next-line ConditionalExpression: equivalent — with the guard forced false, decrypt(undefined) throws and the catch below returns the same []
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(decrypt(raw));
	}
	// Stryker disable next-line BlockStatement: equivalent — an empty catch leaves parsed undefined, and the Array.isArray check below returns the same []
	catch {
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
 * the OAuth state of the flow and BOUND TO THE USER who parked it, in a
 * short-lived encrypted httpOnly cookie. AES-GCM makes the payload tamper-proof
 * and confidential, so the picker can trust that both the token and the channel
 * list came from Google's callback — and that only the same signed-in user can
 * complete the pick on a shared machine.
 */
export function parkPendingChannelPick(
	cookies: Cookies,
	state: string,
	payload: PendingChannelPick,
	userId: string
): void {
	const now = Date.now();
	const entries = readEntries(cookies).filter(
		(e) => e.state !== state && now - e.ts <= PICK_TTL_MS
	);
	entries.push({ ...payload, state, ts: now, userId });
	writeEntries(cookies, entries.slice(-MAX_PENDING_PICKS));
}

/**
 * Reads and validates the parked pick for ONE flow. Returns null when the
 * entry is missing, tampered, malformed, expired, or parked by a DIFFERENT
 * user — the caller fails loudly so the user reconnects. Other flows' entries
 * are untouched.
 */
export function readPendingChannelPick(cookies: Cookies, state: string, userId: string): PendingChannelPick | null {
	const entry = readEntries(cookies).find((e) => e.state === state);
	if (!entry || typeof entry.ts !== 'number' || Date.now() - entry.ts > PICK_TTL_MS) return null;
	// Bound to the parker: a pick is only readable by the signed-in user who
	// parked it, so another user on a shared machine can never complete it.
	// Entries parked BEFORE this binding shipped have no userId and read as
	// null — deliberate fail-closed invalidation (the picker tells the user
	// the selection expired and to reconnect), not a migration path that would
	// reopen the cross-user hole for the pre-binding window.
	if (entry.userId !== userId) return null;
	if (typeof entry.refreshToken !== 'string' || !entry.refreshToken) return null;
	if (!Array.isArray(entry.channels) || entry.channels.length === 0) return null;
	const valid = entry.channels.every(
		// Stryker disable next-line ConditionalExpression: equivalent — channels come from JSON.parse, which never yields undefined; a primitive's .id is undefined so typeof c.id !== 'string' keeps the conjunction false, and null fails c !== null either way
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
	const connectedAt = new Date().toISOString();
	const updated = await db
		.insert(channels)
		.values({
			id: channel.id,
			userId: user.id,
			orgId: user.orgId,
			title: channel.title,
			refreshTokenEnc,
			active: 1,
			// Nothing historical is analyzed on connect: the scan window opens at
			// connection time. Older comments only enter via the explicit
			// "analyze history" action on the dashboard.
			cursor: connectedAt,
			createdAt: connectedAt
		})
		.onConflictDoUpdate({
			target: channels.id,
			set: { userId: user.id, orgId: user.orgId, title: channel.title, refreshTokenEnc, active: 1 },
			setWhere: or(isNull(channels.orgId), eq(channels.orgId, user.orgId))
		})
		.returning({ id: channels.id });
	return updated.length === 0 ? 'conflict' : 'ok';
}
