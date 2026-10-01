import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export interface TopupPayment {
	id: string;
	status?: string | null;
	created?: number | null;
	metadata: Record<string, string> | null;
}

export class InvalidTopupPayment extends Error {}

/** Round-trip validation rejects noncanonical or impossible provider dates. */
function validatedAttemptTime(value: unknown, dayOnly = false): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new InvalidTopupPayment('Auto top-up payment has an invalid attempt date');
	const iso = new Date(value).toISOString();
	if ((dayOnly ? iso.slice(0, 10) : iso) !== value) throw new InvalidTopupPayment('Auto top-up payment has an invalid attempt date');
	return value;
}

/** Exact identity for new attempts; daily/time correlation only for older payments. */
export function topupAttemptCorrelation(pi: TopupPayment, column: AnySQLiteColumn) {
	const attemptAt = validatedAttemptTime(pi.metadata?.auto_topup_attempt_at);
	const attemptDay = validatedAttemptTime(pi.metadata?.auto_topup_attempt_day, true);
	if (attemptAt) return eq(column, attemptAt);
	if (pi.created == null) {
		if (attemptDay) throw new InvalidTopupPayment('Legacy auto top-up payment has no creation timestamp');
		return undefined;
	}
	if (!Number.isSafeInteger(pi.created) || pi.created <= 0 || !Number.isFinite(new Date(pi.created * 1000).getTime())) throw new InvalidTopupPayment('Auto top-up payment has an invalid creation timestamp');
	return and(gte(column, new Date(pi.created * 1000 - 60_000).toISOString()), lte(column, new Date(pi.created * 1000 + 60_000).toISOString()), attemptDay ? sql`substr(${column}, 1, 10) = ${attemptDay}` : undefined);
}

