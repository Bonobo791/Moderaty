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

// Per-channel protected-handle allowlist: comments from a listed handle are
// always approved, skipping rules and AI scoring (identity beats text).

import { and, desc, eq } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { channelAllowedHandles } from '$lib/server/db/schema';

export const MAX_HANDLES_PER_CHANNEL = 100;

const HANDLE_PATTERN = /^[a-z0-9._-]+$/;

/**
 * Normalizes a raw handle for storage and comparison. Deliberately minimal:
 * trim the ends, lowercase, strip ONE leading '@'. Inner whitespace is NOT
 * collapsed — YouTube handles cannot contain spaces, so a spaced value fails
 * validateHandle's character check loudly at the form, and in the pipeline
 * simply never matches a stored handle.
 */
export function normalizeHandle(raw: string): string {
	return raw.trim().toLowerCase().replace(/^@/, '');
}

/**
 * Normalizes and validates a user-entered handle: 3–30 characters of
 * lowercase letters, digits, dots, underscores, and hyphens (YouTube's handle
 * alphabet, post-normalization). Throws with a human-readable reason on any
 * violation — the form action turns that into fail(400).
 */
export function validateHandle(raw: string): string {
	const handle = normalizeHandle(raw);
	if (handle.length === 0) throw new Error('handle is empty');
	if (handle.length < 3 || handle.length > 30) {
		throw new Error(`handle must be between 3 and 30 characters (got ${handle.length})`);
	}
	if (!HANDLE_PATTERN.test(handle)) {
		throw new Error('handle may only contain lowercase letters, digits, dots, underscores, and hyphens');
	}
	return handle;
}

/** All protected handles for a channel, newest first. */
export async function listHandles(channelId: string) {
	return db
		.select()
		.from(channelAllowedHandles)
		.where(eq(channelAllowedHandles.channelId, channelId))
		.orderBy(desc(channelAllowedHandles.id))
		.all();
}

/**
 * Adds a handle to a channel's allowlist: validate, enforce the per-channel
 * cap, dedupe. Re-adding an already-protected handle returns the existing row
 * without error (idempotent add). The cap is checked before the dedupe, so at
 * capacity even a duplicate add is rejected loudly.
 */
export async function addHandle(channelId: string, raw: string) {
	const handle = validateHandle(raw);
	const existing = await db
		.select()
		.from(channelAllowedHandles)
		.where(eq(channelAllowedHandles.channelId, channelId))
		.all();
	if (existing.length >= MAX_HANDLES_PER_CHANNEL) {
		throw new Error(`channel already has the maximum of ${MAX_HANDLES_PER_CHANNEL} protected handles`);
	}
	const duplicate = existing.find((row) => row.handle === handle);
	if (duplicate) return duplicate;
	const inserted = await db
		.insert(channelAllowedHandles)
		.values({ channelId, handle, createdAt: new Date().toISOString() })
		.returning();
	return inserted[0];
}

/**
 * Removes a handle, scoped to the channel so a request on one channel cannot
 * delete another channel's row. Returns the deleted row, or null when no
 * scoped row matched (the action turns that into fail(404)).
 */
export async function removeHandle(channelId: string, id: number) {
	if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid handle ID');
	const deleted = await db
		.delete(channelAllowedHandles)
		.where(and(eq(channelAllowedHandles.id, id), eq(channelAllowedHandles.channelId, channelId)))
		.returning();
	return deleted[0] ?? null;
}

/** The pipeline seam: all normalized protected handles for a channel as a Set. */
export async function loadHandleSet(channelId: string): Promise<Set<string>> {
	const rows = await db
		.select({ handle: channelAllowedHandles.handle })
		.from(channelAllowedHandles)
		.where(eq(channelAllowedHandles.channelId, channelId))
		.all();
	return new Set(rows.map((row) => row.handle));
}
