// Shared enrollment/eligibility for transactional signup and automatic discovery.
import { randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from './db';
import { users, welcomeEmails } from './db/schema';
import { isBareAddress } from './protonMail';
import { WELCOME_TEMPLATE_VERSION } from './welcomeEmailTemplate';

export const WELCOME_CAMPAIGN = 'hosted-signup-welcome';
const COHORT = 'official-hosted';
export const key = (userId: string) => and(eq(welcomeEmails.userId, userId), eq(welcomeEmails.campaign, WELCOME_CAMPAIGN));
type Handle = Pick<typeof db, 'select' | 'insert' | 'update'>;
export type WelcomeRow = typeof welcomeEmails.$inferSelect;
export type Account = Pick<typeof users.$inferSelect, 'id' | 'email' | 'googleSub' | 'displayName'>;

/** Deliberate deployment declaration; free/unsubscribed users are included. */
export function isOfficialHosted(): boolean {
	const value = env.MODERATY_DEPLOYMENT;
	if (value && value !== COHORT && value !== 'self-hosted') throw new Error('MODERATY_DEPLOYMENT must be official-hosted or self-hosted');
	return value === COHORT;
}
export function sendingEnabled(): boolean {
	if (env.WELCOME_EMAIL_ENABLED && !['true', 'false'].includes(env.WELCOME_EMAIL_ENABLED)) throw new Error('WELCOME_EMAIL_ENABLED must be true or false');
	return isOfficialHosted() && env.WELCOME_EMAIL_ENABLED !== 'false' && env.DRY_RUN === 'false';
}

function validWelcomeAddress(email: string): boolean {
	if (!isBareAddress(email)) return false;
	const domain = email.split('@')[1]?.toLowerCase();
	if (!domain || domain === 'accounts.google.com' || domain.includes('..') || domainToASCII(domain) !== domain) return false;
	const labels = domain.split('.');
	if (labels.length < 2) return false;
	if (!labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
	return /^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/.test(labels[labels.length - 1]);
}

/** Same recipient policy at enrollment, preview/backfill, and immediately before SMTP. */
export function exclusion(account: Account | undefined, row?: WelcomeRow): string | null {
	if (!account || account.googleSub.startsWith('deleted:') || account.email === '[deleted]') return 'deleted_account';
	if (row?.suppressionReason || row?.state === 'suppressed') return 'operational_suppression';
	if (row?.cohort && row.cohort !== COHORT) return 'non_hosted_cohort';
	if (!validWelcomeAddress(account.email)) return 'invalid_recipient';
	return null;
}

function enrollmentValues(userId: string, source: string, reason: string | null, existing?: WelcomeRow) {
	const now = new Date().toISOString();
	return { userId, campaign: WELCOME_CAMPAIGN, templateVersion: WELCOME_TEMPLATE_VERSION,
		state: reason ? 'suppressed' : 'queued', cohort: COHORT, source: existing?.source ?? source,
		messageId: existing?.messageId ?? ['<moderaty-welcome-', randomBytes(24).toString('hex'), '@moderaty.com>'].join(''),
		queuedAt: reason ? null : now, nextRetryAt: reason ? null : now, suppressionReason: reason };
}

export function isHistoricalCandidate(row?: WelcomeRow): boolean {
	if (!row) return true;
	if (row.acceptedAt) return false;
	return ['historical_unknown', 'never_sent'].includes(row.state);
}

/** Call inside signup's transaction ONLY for a newly inserted user. Never sends mail. */
export async function enqueueWelcome(handle: Handle, userId: string, source: 'signup' | 'historical_unknown' | 'never_sent'): Promise<boolean> {
	if (!isOfficialHosted()) return false;
	const account = await handle.select().from(users).where(eq(users.id, userId)).get();
	// Tombstoned users retain their FK identity for legal evidence only.
	// Never recreate erased delivery metadata, including a suppressed row.
	if (!account || account.googleSub.startsWith('deleted:') || account.email === '[deleted]') return false;
	const existing = await handle.select().from(welcomeEmails).where(key(userId)).get();
	if (!isHistoricalCandidate(existing)) return false;
	const reason = exclusion(account, existing);
	const values = enrollmentValues(userId, source, reason, existing);
	if (!existing) {
		const inserted = await handle.insert(welcomeEmails).values(values).onConflictDoNothing().returning({ userId: welcomeEmails.userId });
		return inserted.length === 1 && !reason;
	}
	const updated = await handle.update(welcomeEmails).set(values).where(and(key(userId), inArray(welcomeEmails.state, ['historical_unknown', 'never_sent']), isNull(welcomeEmails.acceptedAt), isNull(welcomeEmails.suppressionReason))).returning({ userId: welcomeEmails.userId });
	return updated.length === 1 && !reason;
}
