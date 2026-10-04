// Test-only fixtures for the scheduler and its HTTP route.
import { testDb } from './testdb';
import { feedbackDigests } from './db/schema';

/** Seeds a planted preview; ages backdate the plant and first-claim timestamps. */
export async function seedPendingFeedbackPreview(channelId: string, opts: { boundary?: string; plantAge?: number; attemptedAge?: number } = {}) {
	const planted = new Date(Date.now() - (opts.plantAge ?? 0)).toISOString();
	const attemptedAt = opts.attemptedAge === undefined ? null : new Date(Date.now() - opts.attemptedAge).toISOString();
	const [row] = await testDb().db.insert(feedbackDigests).values({
		channelId,
		windowStart: opts.boundary ?? '2026-05-01T00:00:00.000Z',
		windowEnd: planted,
		attemptedAt,
		status: 'dry-run-pending'
	}).returning({ id: feedbackDigests.id });
	return row.id;
}

export async function withTestTrigger<T>(name: string, definition: string, run: () => Promise<T>): Promise<T> {
	await testDb().client.execute(`CREATE TRIGGER ${name} ${definition}`);
	try {
		return await run();
	} finally {
		await testDb().client.execute(`DROP TRIGGER ${name}`);
	}
}
