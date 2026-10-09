// Per-channel protected handles bind to verified YouTube channel identities.
// Protected identities skip rules and AI scoring (identity beats text).

import { and, desc, eq, isNull } from 'drizzle-orm';

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
 * cap, dedupe. A resolver verifies new UI entries before any write. Verified
 * duplicates keep their original identity. Legacy entries can be resolved
 * in place, including at capacity; adds at capacity remain rejected.
 */
export async function addHandle(channelId: string, raw: string, resolve?: () => Promise<string>) {
	const handle = validateHandle(raw);
	const existing = await db
		.select()
		.from(channelAllowedHandles)
		.where(eq(channelAllowedHandles.channelId, channelId))
		.all();
	const duplicate = existing.find((row) => row.handle === handle);
	if (existing.length >= MAX_HANDLES_PER_CHANNEL && !(duplicate && !duplicate.resolvedChannelId && resolve)) {
		throw new Error(`channel already has the maximum of ${MAX_HANDLES_PER_CHANNEL} protected handles`);
	}
	if (duplicate?.resolvedChannelId || (duplicate && !resolve)) return duplicate;
	const resolvedChannelId = resolve ? await resolve() : null;
	if (duplicate) {
		const updated = await db
			.update(channelAllowedHandles)
			.set({ resolvedChannelId })
			.where(and(
				eq(channelAllowedHandles.id, duplicate.id),
				eq(channelAllowedHandles.channelId, channelId),
				isNull(channelAllowedHandles.resolvedChannelId)
			))
			.returning();
		if (updated[0]) return updated[0];
		// A concurrent resolution may win; never rebind its verified identity.
		const current = (await listHandles(channelId)).find(row => row.id === duplicate.id);
		if (!current) throw new Error('protected handle was removed during resolution');
		return current;
	}
	const inserted = await db
		.insert(channelAllowedHandles)
		.values({ channelId, handle, resolvedChannelId, createdAt: new Date().toISOString() })
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

/** Handle labels for callers that need configuration rather than identity matching. */
export async function loadHandleSet(channelId: string): Promise<Set<string>> {
	const rows = await db
		.select({ handle: channelAllowedHandles.handle })
		.from(channelAllowedHandles)
		.where(eq(channelAllowedHandles.channelId, channelId))
		.all();
	return new Set(rows.map((row) => row.handle));
}

export interface ProtectedIdentities {
	byChannelId: Map<string, string>;
	unresolved: boolean;
	configured: boolean;
}

/** Names are labels; only verified channel IDs can grant protection. */
export async function loadProtectedIdentities(channelId: string): Promise<ProtectedIdentities> {
	const rows = await listHandles(channelId);
	return {
		byChannelId: new Map(rows.filter((row) => row.resolvedChannelId).map((row) => [row.resolvedChannelId!, row.handle])),
		unresolved: rows.some((row) => !row.resolvedChannelId),
		configured: rows.length > 0
	};
}
