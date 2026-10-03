// Durable outcome recording, separate from claiming and SMTP submission.
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db, withBusyRetry } from './db';
import { welcomeCampaigns, welcomeEmails } from './db/schema';
import { ProtonMailConfigurationError, ProtonMailPreSubmissionDeadlineError, ProtonMailSubmissionError } from './protonMail';
import { WELCOME_CAMPAIGN, type WelcomeRow } from './welcomeEnrollment';

export type WelcomeDelivery = 'accepted' | 'deferred' | 'suppressed' | 'failed' | 'ambiguous';
const MAX_ATTEMPTS = 5;
const OUTAGE_BACKOFF_MS = 15 * 60_000;
export const WELCOME_TRANSPORT_OUTAGES: readonly string[] = ['configuration', 'authentication', 'tls', 'dns', 'sender_rejected'];
const SUBMISSION_DIAGNOSTIC = '[welcome] submission not accepted';

function deploymentFailure(cause: unknown): string | null {
	if (cause instanceof ProtonMailConfigurationError) return 'configuration';
	if (cause instanceof ProtonMailSubmissionError && cause.outcome === 'retryable' && WELCOME_TRANSPORT_OUTAGES.includes(cause.category)) return cause.category;
	return null;
}

async function deferSubmission(owned: SQL | undefined, fresh: WelcomeRow, { category, delay }: { category: string; delay: number }, handle: Pick<typeof db, 'update'> = db) {
	const updated = await handle.update(welcomeEmails).set({ state: 'queued', attempts: fresh.attempts,
		lastAttemptAt: fresh.lastAttemptAt, lastError: category,
		nextRetryAt: new Date(Date.now() + delay).toISOString(), claimToken: null, leaseExpiresAt: null })
		.where(and(owned, eq(welcomeEmails.state, 'in_flight'))).returning({ userId: welcomeEmails.userId });
	return updated.length === 1;
}

function failedSubmission(cause: unknown, attempts: number) {
	if (!(cause instanceof ProtonMailSubmissionError)) return { state: 'ambiguous', category: 'unconfirmed_submission' };
	if (cause.outcome === 'unknown') return { state: 'ambiguous', category: cause.category };
	if (cause.outcome === 'permanent') return { state: 'permanent_failure', category: cause.category };
	if (attempts >= MAX_ATTEMPTS) return { state: 'permanent_failure', category: 'retry_exhausted' };
	return { state: 'retryable_failure', category: cause.category };
}

/** Deployment-wide faults pause the campaign; they cannot spend recipient retries. */
export async function recordWelcomeFailure(owned: SQL | undefined, fresh: WelcomeRow, cause: unknown): Promise<WelcomeDelivery> {
	if (cause instanceof ProtonMailPreSubmissionDeadlineError) {
		await deferSubmission(owned, fresh, { category: cause.category, delay: 60_000 });
		return 'deferred';
	}
	const outage = deploymentFailure(cause);
	if (outage) {
		const updated = await withBusyRetry(() => db.transaction(async tx => {
			const until = new Date(Date.now() + OUTAGE_BACKOFF_MS).toISOString();
			await tx.update(welcomeCampaigns).set({ nextAttemptAt: sql`max(${welcomeCampaigns.nextAttemptAt}, ${until})` }).where(eq(welcomeCampaigns.campaign, WELCOME_CAMPAIGN));
			return deferSubmission(owned, fresh, { category: outage, delay: OUTAGE_BACKOFF_MS }, tx);
		}));
		if (!updated) return 'deferred';
		console.error(SUBMISSION_DIAGNOSTIC, { category: outage, state: 'queued' });
		return 'failed';
	}
	const { state, category } = failedSubmission(cause, fresh.attempts + 1);
	const nextRetryAt = state === 'retryable_failure' ? new Date(Date.now() + Math.min(60_000 * 2 ** fresh.attempts, 3_600_000)).toISOString() : null;
	const updated = await db.update(welcomeEmails).set({ state, lastError: category, nextRetryAt, claimToken: null, leaseExpiresAt: null })
		.where(and(owned, eq(welcomeEmails.state, 'in_flight'))).returning({ userId: welcomeEmails.userId });
	if (updated.length !== 1) return 'deferred';
	console.error(SUBMISSION_DIAGNOSTIC, { category, state });
	return state === 'ambiguous' ? 'ambiguous' : 'failed';
}

/** Outside the send catch: persistence failure after acceptance must not resend. */
export async function recordWelcomeAcceptance(owned: SQL | undefined, messageId: string): Promise<WelcomeDelivery> {
	const accepted = await db.update(welcomeEmails).set({ state: 'accepted', acceptedAt: new Date().toISOString(),
		providerMessageId: messageId, nextRetryAt: null, claimToken: null, leaseExpiresAt: null })
		.where(and(owned, eq(welcomeEmails.state, 'in_flight'))).returning({ userId: welcomeEmails.userId });
	if (accepted.length !== 1) throw new Error('Welcome acceptance could not be persisted; reconcile before retry');
	return 'accepted';
}
