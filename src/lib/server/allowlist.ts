// Only owner-entered handles persist; channel identities are resolved in memory.
// Protected identities skip rules and AI scoring (identity beats text).

import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { DeadlineExceededError } from '$lib/server/http';
import { db } from '$lib/server/db';
import { channelAllowedHandles, channels } from '$lib/server/db/schema';

export const MAX_HANDLES_PER_CHANNEL = 100;
export class HandleConfigurationError extends Error {
	constructor(message: string, readonly status = 400) { super(message); }
}

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
	if (handle.length === 0) throw new HandleConfigurationError('handle is empty');
	if (handle.length < 3 || handle.length > 30) {
		throw new HandleConfigurationError(`handle must be between 3 and 30 characters (got ${handle.length})`);
	}
	if (!HANDLE_PATTERN.test(handle)) {
		throw new HandleConfigurationError('handle may only contain lowercase letters, digits, dots, underscores, and hyphens');
	}
	return handle;
}

type HandleReader = Pick<typeof db, 'select'>;

/** All protected handles for a channel, newest first. */
export function listHandles(channelId: string, reader: HandleReader = db) {
	return reader
		.select()
		.from(channelAllowedHandles)
		.where(eq(channelAllowedHandles.channelId, channelId))
		.orderBy(desc(channelAllowedHandles.id))
		.all();
}

type ChannelConnection = Pick<typeof channels.$inferSelect, 'orgId' | 'refreshTokenEnc'>;

/**
 * Adds a handle to a channel's allowlist: validate, enforce the per-channel
 * cap and dedupe under a channel write lock. Provider verification happens
 * before the transaction; its channel ID is discarded.
 */
export async function addHandle(
	channelId: string,
	raw: string,
	resolve?: () => Promise<string>,
	connection?: ChannelConnection
) {
	const handle = validateHandle(raw);
	const existing = await db
		.select()
		.from(channelAllowedHandles)
		.where(eq(channelAllowedHandles.channelId, channelId))
		.all();
	const duplicate = existing.find((row) => row.handle === handle);
	if (existing.length >= MAX_HANDLES_PER_CHANNEL && !duplicate) {
		throw new HandleConfigurationError(`channel already has the maximum of ${MAX_HANDLES_PER_CHANNEL} protected handles`);
	}
	if (resolve) await resolve();
	// Network work is complete. Lock and recheck before any durable write.
	return db.transaction(async (tx) => {
		if (connection) {
			const connected = await tx.update(channels)
				.set({ id: sql`${channels.id}` })
				.where(and(
					eq(channels.id, channelId),
					connection.orgId === null ? isNull(channels.orgId) : eq(channels.orgId, connection.orgId),
					eq(channels.refreshTokenEnc, connection.refreshTokenEnc)
				))
				.returning({ id: channels.id });
			if (!connected[0]) throw new HandleConfigurationError('channel connection changed during handle verification', 409);
		} else {
			// Legacy configuration callers also lock before reading capacity.
			await tx.update(channels).set({ id: sql`${channels.id}` }).where(eq(channels.id, channelId));
		}
		const current = await tx.select().from(channelAllowedHandles)
			.where(eq(channelAllowedHandles.channelId, channelId)).all();
		const sameHandle = current.find(row => row.handle === handle);
		if (duplicate && sameHandle?.id !== duplicate.id) {
			throw new HandleConfigurationError('protected handle was removed during resolution');
		}
		if (sameHandle) return sameHandle;
		if (current.length >= MAX_HANDLES_PER_CHANNEL) {
			throw new HandleConfigurationError(`channel already has the maximum of ${MAX_HANDLES_PER_CHANNEL} protected handles`);
		}
		const inserted = await tx.insert(channelAllowedHandles)
			.values({ channelId, handle, createdAt: new Date().toISOString() }).returning();
		return inserted[0];
	});
}

/**
 * Removes a handle, scoped to the channel so a request on one channel cannot
 * delete another channel's row. Returns the deleted row, or null when no
 * scoped row matched (the action turns that into fail(404)).
 */
export async function removeHandle(channelId: string, id: number) {
	if (!Number.isInteger(id) || id <= 0) throw new HandleConfigurationError('Invalid handle ID');
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
	proofs?: Map<number, {handle: string; channelId: string}>;
	unresolved: boolean;
	configured: boolean;
}

/** Resolve current holders once per snapshot; reuse only unchanged row/handle proofs.
 * A new/removed configuration is never trusted from an earlier snapshot. */
export async function loadProtectedIdentities(
	channelId: string,
	reader: HandleReader = db,
	resolve?: (handle: string) => Promise<string>,
	previous?: ProtectedIdentities
): Promise<ProtectedIdentities> {
	const rows = await listHandles(channelId, reader);
	if (rows.length > MAX_HANDLES_PER_CHANNEL) throw new HandleConfigurationError('protected handle configuration exceeds the supported limit');
	const proofs = new Map<number, {handle: string; channelId: string}>();
	let unresolved = false;
	// Five concurrent lookups, at most 100 configured handles, all deadline-bound
	// by the provider resolver. No network call is made within a write transaction.
	for (let index = 0; index < rows.length; index += 5) {
		await Promise.all(rows.slice(index, index + 5).map(async row => {
			const known = previous?.proofs?.get(row.id);
			if (known?.handle === row.handle) { proofs.set(row.id, known); return; }
			if (!resolve) { unresolved = true; return; }
			try {
				const id = await resolve(row.handle);
				if (!id || id.trim() !== id) throw new Error('Invalid protected channel identity');
				proofs.set(row.id, {handle: row.handle, channelId: id});
			} catch (error) {
				if (error instanceof DeadlineExceededError) throw error;
				unresolved = true;
				console.error('protected handle resolution failed; comments will be held for review', error);
			}
		}));
	}
	const byChannelId = new Map<string, string>();
	for (const row of rows) {
		const proof = proofs.get(row.id);
		if (proof && !byChannelId.has(proof.channelId)) byChannelId.set(proof.channelId, proof.handle);
	}
	return {byChannelId, proofs, unresolved, configured: rows.length > 0};
}
