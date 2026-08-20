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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

// Account deletion (immediate) and the retention sweeps (consent-evidence
// e-mail, audit-log commenter handles).
//
// Policy: account deletion erases everything immediately EXCEPT the
// statutory-retention items — the `consents` evidentiary log, which keeps
// the e-mail, document versions, timestamps, IP, and user agent under LGPD
// Art. 16, III (regular exercise of rights in proceedings). That e-mail is
// blocked from any other use by architecture: it exists ONLY in the
// write-once consent log, and a cron sweep erases it 10 years after
// acceptance (CC Art. 205, conservative over CDC's 5-year prescription).
// The consent row itself is kept, anonymized. Commenter handles on audit
// rows and staged moderation actions get a much shorter TTL: a cron sweep
// erases them after 30 days, keeping the row (and its moderation outcome)
// as the record.

import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';
import type Stripe from 'stripe';

import { db } from '$lib/server/db';
import { auditLog, channelAllowedHandles, channels, comments, consents, creditTransactions, invites, memberships, moderationActions, organizations, rules, sessions, stripeDeletionOutbox, stripeLifetimeSlots, users } from '$lib/server/db/schema';
import { getStripe } from '$lib/server/stripe/client';

export const CONSENT_EMAIL_RETENTION_MS = 10 * 365.25 * 24 * 60 * 60 * 1000; // 10 years
export const AUDIT_HANDLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const CONSENT_SWEEP_BATCH = 50; // bounded per cron invocation (I10)
const AUDIT_HANDLE_SWEEP_BATCH = 50; // same drain-across-runs bound as the consent sweep (I10)

/** Placeholder for an erased refresh token — never valid ciphertext, so decrypt fails loudly in cron (AGENTS.md). */
export const WIPED_REFRESH_TOKEN = 'erased:account-deletion';


type StripeRequestOptionsFactory = () => Stripe.RequestOptions | undefined;

/** Cancels every live subscription before Stripe customer deletion can proceed. */
async function cancelCustomerSubscriptions(customerId: string, options?: StripeRequestOptionsFactory): Promise<void> {
	const response = await getStripe().subscriptions.list({ customer: customerId, status: 'all', limit: 100 }, options?.());
	if (!response || !Array.isArray(response.data) || typeof response.has_more !== 'boolean') {
		throw new Error(`Stripe returned a malformed subscription list for ${customerId}`);
	}
	if (response.has_more) throw new Error(`Stripe customer ${customerId} has more than 100 subscriptions; manual cancellation is required`);
	for (const subscription of response.data) {
		if (!subscription || typeof subscription.id !== 'string' || typeof subscription.status !== 'string') {
			throw new Error(`Stripe returned a malformed subscription for ${customerId}`);
		}
		if (subscription.status !== 'canceled' && subscription.status !== 'incomplete_expired') await getStripe().subscriptions.cancel(subscription.id, undefined, options?.());
	}
}

/**
 * Deletes a set of channels and every row they own, child-to-parent:
 * moderation actions, comments, audit rows, rules, then the channel rows
 * themselves. Shared by account deletion (every channel in dissolved orgs)
 * and the dashboard's per-channel disconnect. Call inside a transaction.
 *
 * With `expectedOrgId` (the disconnect path, which authorized via a SELECT
 * BEFORE this transaction), the channel rows are deleted FIRST with the org
 * as a delete predicate: if a channel was reconnected under a different org
 * in between, the predicate matches nothing and the whole transaction aborts
 * loudly instead of erasing another tenant's channel (TOCTOU). The first
 * DELETE also takes the write lock, so no reconnect can interleave before
 * the child rows go.
 */
export async function deleteChannelRecords(
	tx: Pick<typeof db, 'delete'>,
	channelIds: string[],
	options?: { expectedOrgId?: string }
): Promise<void> {
	if (!channelIds.length) return;
	// Child rows of the channels, child-to-parent, identical in both branches.
	// (Codacy duplication: the four-delete sequence was copy-pasted in each
	// branch — extracted so the child-delete list lives once.)
	const deleteChildren = async () => {
		await tx.delete(channelAllowedHandles).where(inArray(channelAllowedHandles.channelId, channelIds));
		await tx.delete(moderationActions).where(inArray(moderationActions.channelId, channelIds));
		await tx.delete(comments).where(inArray(comments.channelId, channelIds));
		await tx.delete(auditLog).where(inArray(auditLog.channelId, channelIds));
		await tx.delete(rules).where(inArray(rules.channelId, channelIds));
	};
	if (options?.expectedOrgId) {
		const removed = await tx
			.delete(channels)
			.where(and(inArray(channels.id, channelIds), eq(channels.orgId, options.expectedOrgId)))
			.returning({ id: channels.id });
		if (removed.length !== channelIds.length) {
			throw new Error('deleteChannelRecords: channel tenancy changed mid-request — aborting');
		}
		await deleteChildren();
		return;
	}
	await deleteChildren();
	await tx.delete(channels).where(inArray(channels.id, channelIds));
}

/**
 * Calculates the cutoff timestamp for consent e-mail retention.
 *
 * @param now - The reference time in milliseconds since the Unix epoch
 * @returns The ISO timestamp 10 years before `now`
 */
export function consentEmailCutoffIso(now = Date.now()): string {
	return new Date(now - CONSENT_EMAIL_RETENTION_MS).toISOString();
}

/**
 * Immediately and permanently erases a user's account data, preserving only the anonymized tombstone and the consent log.
 *
 * One transaction: for every org the user belongs to, either dissolve it
 * (sole-member orgs — always true of the personal org — go with their
 * channels, moderation actions, comments, audit rows, rules, and invites)
 * or leave it to its surviving members (shared orgs), promoting the oldest
 * admin — else the oldest member — to owner when the deleting user was the
 * last owner, so a surviving org is never left ownerless. Every session;
 * and the rest of the user's tenancy — every remaining membership and every
 * invite they created — goes too. Explicit
 * deletes in child-to-parent order rather than FK reliance: the users row is
 * only tombstoned, so ON DELETE CASCADE never fires. A channel the user
 * merely CONNECTED (channels.userId) in a surviving team org is NOT deleted —
 * it and its moderation history belong to the team; it is detached instead
 * (userId NULL, token wiped) so cron fails loudly until a teammate
 * reconnects. The users row is
 * anonymized to a tombstone (`googleSub: 'deleted:<id>'`, e-mail and
 * display name wiped) so the same Google identity can sign up again and the
 * `consents` evidentiary log survives with its foreign key intact. The
 * e-mail survives ONLY in `consents` (statutory retention, Art. 16, III) —
 * never in the live users table. OAuth token revocation happens at the
 * caller, BEFORE this erase (the encrypted tokens die here either way).
 *
 * @param userId - The ID of the user to erase
 * @throws If the user does not exist or is already tombstoned
 */

type DeletionTx = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>;

/**
 * Data-bug guard: a personal org is single-member by definition, but the schema
 * cannot enforce that. Requires exactly one membership per personal org, owned
 * by the deleting user.
 */
async function assertPersonalOrgSoleOwned(tx: DeletionTx, userId: string, personalOrgIds: string[]): Promise<void> {
	// Stryker disable next-line ConditionalExpression: true equivalent — with zero personal orgs the guard queries inArray([]), which drizzle compiles to `false`; 0 !== 0 and [].some() are both false, so the guard body can never fire either way.
	if (personalOrgIds.length) {
		// Data-bug guard: a personal org is single-member by definition, but
		// the schema cannot enforce that. Require exactly one membership per
		// personal org, owned by the deleting user — anything else (a second
		// member, or a sole member who ISN'T this user) means deleting the
		// org would destroy someone else's tenancy and channels. Fail loudly
		// and abort the whole deletion.
		const orgMembers = await tx
			.select({ userId: memberships.userId })
			.from(memberships)
			.where(inArray(memberships.orgId, personalOrgIds))
			.all();
		// Stryker disable next-line MethodExpression: every equivalent — organizations.personalFor is UNIQUE (at most one personal org per user), so a mixed-owner member list with a matching count is schema-impossible; with zero or one rows some ≡ every here.
		if (orgMembers.length !== personalOrgIds.length || orgMembers.some((m) => m.userId !== userId)) {
			console.error(`user ${userId}'s personal org membership is inconsistent (${orgMembers.length} rows) — refusing account deletion`);
			throw new Error('personal organization has other members — contact support');
		}
	}
}

/**
 * Loads the user's membership snapshot in ONE batched query (no per-org
 * roundtrips inside the transaction).
 */
async function loadMembershipSnapshot(tx: DeletionTx, userId: string): Promise<{
	userMemberships: { orgId: string; role: string }[];
	coMembersByOrg: Map<string, { orgId: string; userId: string; role: string; createdAt: string }[]>;
}> {
	// (personal or shared — the guard above already proved personal orgs are
	// sole-member) has no one to survive to, so it dissolves with its
	// channels and data. A shared org with other members survives; when the
	// deleting user was its LAST owner, ownership passes to the oldest admin,
	// else the oldest member (seniority = join order, userId breaking ties),
	// so a shared org is never left ownerless.
	const userMemberships = await tx
		.select({ orgId: memberships.orgId, role: memberships.role })
		.from(memberships)
		.where(eq(memberships.userId, userId))
		.all();
	// One batched query for every co-member across all the user's orgs —
	// no per-org roundtrips (N+1) inside the transaction.
	const memberOrgIds = userMemberships.map((m) => m.orgId);
	const coMembers = memberOrgIds.length
		? await tx
				.select({
					orgId: memberships.orgId,
					userId: memberships.userId,
					role: memberships.role,
					createdAt: memberships.createdAt
				})
				.from(memberships)
				.where(and(inArray(memberships.orgId, memberOrgIds), ne(memberships.userId, userId)))
				.all()
		: // Stryker disable next-line ArrayDeclaration: sentinel equivalent — this branch means userMemberships is empty, and the only reader of coMembersByOrg loops over userMemberships, so the injected row is never read.
			[];
	const coMembersByOrg = new Map<string, typeof coMembers>();
	for (const row of coMembers) {
		// Stryker disable next-line ArrayDeclaration: sentinel equivalent — the injected string's .createdAt is undefined, which localeCompare coerces to "undefined"; ISO dates start with digits ('2' < 'u'), so it always sorts last, find(role==='admin') skips it (role undefined), and ranked[0] is always a real row.
		const list = coMembersByOrg.get(row.orgId) ?? [];
		list.push(row);
		coMembersByOrg.set(row.orgId, list);
	}
	return { userMemberships, coMembersByOrg };
}

/**
 * Decides each org's fate: sole-member orgs dissolve; shared orgs survive, with
 * ownership passing to the oldest admin (or oldest member) when the departing
 * user was the last owner. Promotions are recorded (post-commit logging).
 */
async function planOrgFates(
	tx: DeletionTx,
	userId: string,
	userMemberships: { orgId: string; role: string }[],
	coMembersByOrg: Map<string, { orgId: string; userId: string; role: string; createdAt: string }[]>
): Promise<{ dissolveOrgIds: string[]; promotions: { orgId: string; successorId: string }[] }> {
	const dissolveOrgIds: string[] = [];
	const promotions: { orgId: string; successorId: string }[] = [];
	for (const membership of userMemberships) {
		const others = coMembersByOrg.get(membership.orgId) ?? [];
		if (!others.length) {
			dissolveOrgIds.push(membership.orgId);
			continue;
		}
		if (membership.role === 'owner' && !others.some((m) => m.role === 'owner')) {
			const ranked = [...others].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.userId.localeCompare(b.userId));
			const successor = ranked.find((m) => m.role === 'admin') ?? ranked[0];
			const promoted = await tx
				.update(memberships)
				.set({ role: 'owner' })
				.where(and(eq(memberships.orgId, membership.orgId), eq(memberships.userId, successor.userId)))
				.returning({ userId: memberships.userId });
			// The row was selected in this same transaction; an empty RETURNING
			// means the data changed underneath us — fail loudly, never log a
			// promotion that did not persist.
			if (!promoted.length) {
				console.error(`account deletion: successor ${successor.userId} vanished from org ${membership.orgId} mid-transaction`);
				throw new Error('ownership succession failed — contact support');
			}
			promotions.push({ orgId: membership.orgId, successorId: successor.userId });
		}
	}
	return { dissolveOrgIds, promotions };
}

/**
 * Captures the dissolved orgs' Stripe customers (before the rows die), records
 * the durable erasure obligation in the outbox, then deletes the org records.
 */
async function dissolveOrgs(tx: DeletionTx, dissolveOrgIds: string[]): Promise<string[]> {
	const stripeCustomerIds: string[] = [];
	// Capture the Stripe customers BEFORE the org rows die — the id is
	// needed for the post-transaction erasure.
	const dissolvedOrgs = await tx
		.select({ stripeCustomerId: organizations.stripeCustomerId })
		.from(organizations)
		.where(inArray(organizations.id, dissolveOrgIds))
		.all();
	for (const org of dissolvedOrgs) {
		if (!org.stripeCustomerId) continue;
		stripeCustomerIds.push(org.stripeCustomerId);
		// The outbox row is the durable obligation; it is deleted once
		// Stripe confirms (below or by the cron retry).
		await tx.insert(stripeDeletionOutbox).values({ customerId: org.stripeCustomerId }).onConflictDoNothing();
	}
	await tx.delete(invites).where(inArray(invites.orgId, dissolveOrgIds));
	await tx.update(stripeLifetimeSlots).set({ activeOrgId: null, activeEntitlementId: null }).where(inArray(stripeLifetimeSlots.activeOrgId, dissolveOrgIds));
	await tx.delete(memberships).where(inArray(memberships.orgId, dissolveOrgIds));
	// The credit ledger is part of the org's records: comment ids,
	// Checkout Session ids, PaymentIntent ids, and charge ids must not
	// survive an "immediate and permanent" deletion as orphans.
	await tx.delete(creditTransactions).where(inArray(creditTransactions.orgId, dissolveOrgIds));
	await tx.delete(organizations).where(inArray(organizations.id, dissolveOrgIds));
	return stripeCustomerIds;
}

export async function deleteUserRecords(userId: string): Promise<void> {
	// Promotions are logged only AFTER the transaction commits — a pre-commit
	// log would claim a succession that a rollback erased. The promoted org's
	// Stripe customer must be anonymized post-commit (the departing last owner
	// created it with their e-mail — codex 6151).
	const promotions: { orgId: string; successorId: string }[] = [];
	// Stripe customers of dissolved orgs are erased AFTER the transaction
	// (best-effort, never blocking the deletion — same pattern as
	// revokeGoogleToken). The ids are persisted to the deletion OUTBOX inside
	// the transaction: a transient Stripe outage must not lose the erasure —
	// the cron retries the outbox until Stripe confirms (coderabbit).
	const stripeCustomerIds: string[] = [];
	// Surviving orgs the departing user belonged to (shared orgs with other
	// members). Their Stripe customers stay (the team still bills), but the
	// customer may have been created by the DEPARTING user — any owner can
	// open Checkout — so the e-mail scrub below must cover them ALL, not just
	// the promoted ones: "last owner leaves" is an unreliable proxy for whose
	// PII the customer holds (codex review).
	const survivingOrgIds: string[] = [];
	await db.transaction(async (tx) => {
		const user = await tx
			.select({ googleSub: users.googleSub })
			.from(users)
			.where(eq(users.id, userId))
			.get();
		if (!user || user.googleSub.startsWith('deleted:')) {
			throw new Error(`deleteUserRecords: user ${userId} not found or already deleted`);
		}
		const personalOrgIds = (
			await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.personalFor, userId)).all()
		).map((o) => o.id);
		if (personalOrgIds.length) await assertPersonalOrgSoleOwned(tx, userId, personalOrgIds);
		const { userMemberships, coMembersByOrg } = await loadMembershipSnapshot(tx, userId);
		const { dissolveOrgIds, promotions: planned } = await planOrgFates(tx, userId, userMemberships, coMembersByOrg);
		promotions.push(...planned);
		for (const membership of userMemberships) {
			if (!dissolveOrgIds.includes(membership.orgId)) survivingOrgIds.push(membership.orgId);
		}
		const channelIds = dissolveOrgIds.length
			? (
					await tx.select({ id: channels.id }).from(channels).where(inArray(channels.orgId, dissolveOrgIds)).all()
				).map((ch) => ch.id)
			: [];
		await deleteChannelRecords(tx, channelIds);
		// Detach team channels this account connected: the row and history stay
		// with the team; the dead grant is wiped so nothing silently moderates.
		await tx
			.update(channels)
			.set({ userId: null, refreshTokenEnc: WIPED_REFRESH_TOKEN })
			.where(eq(channels.userId, userId));
		await tx.delete(sessions).where(eq(sessions.userId, userId));
		if (dissolveOrgIds.length) stripeCustomerIds.push(...(await dissolveOrgs(tx, dissolveOrgIds)));
		await tx.delete(invites).where(eq(invites.createdBy, userId));
		await tx.delete(memberships).where(eq(memberships.userId, userId));
		await tx
			.update(users)
			.set({ googleSub: `deleted:${userId}`, email: '[deleted]', displayName: '[deleted]' })
			.where(eq(users.id, userId));
	});
	for (const promotion of promotions) {
		console.info(
			`account deletion: promoted user ${promotion.successorId} to owner of org ${promotion.orgId} (last owner ${userId} was deleted)`
		);
	}
	// Surviving orgs keep their Stripe customer (the team still bills), but
	// the customer may have been created by the DEPARTING user (any owner can
	// open Checkout) with their e-mail — that PII must not outlive the
	// account. Anonymize best-effort for EVERY surviving org the user belonged
	// to (not just promoted ones — codex review): the e-mail is scrubbed, the
	// org name and saved card stay for the successor.
	for (const orgId of survivingOrgIds) {
		const org = await db
			.select({ stripeCustomerId: organizations.stripeCustomerId })
			.from(organizations)
			.where(eq(organizations.id, orgId))
			.get();
		if (!org?.stripeCustomerId) continue;
		try {
			// The typed SDK accepts `string | undefined` — an undefined value
			// would OMIT the field (a no-op), so the identifier is scrubbed
			// with an empty string instead of null.
			await getStripe().customers.update(org.stripeCustomerId, { email: '' });
		} catch (error) {
			console.error(
				`account deletion: could not anonymize Stripe customer ${org.stripeCustomerId} for surviving org ${orgId}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	// Best-effort Stripe customer erasure: the customer holds the org name and
	// the saved card used for off-session auto top-up. A failure is loud but
	// never blocks the deletion — the local records are already gone and
	// privacy must not be held hostage by Stripe availability (the same
	// contract as revokeGoogleToken on channel grants). The OUTBOX row keeps
	// the obligation durable: the cron retry erases it once Stripe confirms.
	for (const customerId of stripeCustomerIds) {
		try {
			await cancelCustomerSubscriptions(customerId);
			await getStripe().customers.del(customerId);
			await db.delete(stripeDeletionOutbox).where(eq(stripeDeletionOutbox.customerId, customerId));
		} catch (error) {
			console.error(
				`account deletion: could not delete Stripe customer ${customerId}: ${error instanceof Error ? error.message : String(error)} — queued in the deletion outbox for cron retry`
			);
		}
	}
}

/**
 * Retries the Stripe customer deletions owed by failed account teardowns.
 * Bounded per invocation (I10): oldest first, one small batch; a row is
 * removed only after Stripe confirms the deletion, so an outage never loses
 * the erasure. Failures are loud and re-queued for the next invocation.
 *
 * @returns The number of customers confirmed deleted
 */
// A failed row is retried at most once per hour — a permanently failing row
// (wrong Stripe mode, already-deleted customer) must not occupy the bounded
// batch on every invocation and starve newer obligations.
const DELETION_RETRY_BACKOFF_MS = 60 * 60 * 1000;

export async function retryStripeCustomerDeletions(limit = 10, deadline?: number): Promise<number> {
	// Fair rotation (codex): never-attempted rows first (NULL lastAttemptAt —
	// SQLite sorts NULLs first in ASC), then oldest attempt first, with a
	// backoff so a row retried within the last hour waits its turn. The
	// permanently failing batch rotates behind newer work instead of blocking
	// the whole bounded batch forever.
	const backoffCutoff = new Date(Date.now() - DELETION_RETRY_BACKOFF_MS).toISOString();
	const rows = await db
		.select()
		.from(stripeDeletionOutbox)
		.where(or(isNull(stripeDeletionOutbox.lastAttemptAt), lt(stripeDeletionOutbox.lastAttemptAt, backoffCutoff)))
		.orderBy(asc(stripeDeletionOutbox.lastAttemptAt), asc(stripeDeletionOutbox.id))
		.limit(limit)
		.all();
	let deleted = 0;
	for (const row of rows) {
		// Deadline guard (codex): the sweep shares the cron's budget with
		// moderation — each deletion may carry SDK network retries, so the
		// sweep must never consume the whole serverless window. Remaining rows
		// wait for the next invocation (bounded, I10).
		const remainingMs = deadline === undefined ? undefined : deadline - Date.now();
		if (remainingMs !== undefined && remainingMs <= 0) {
			const remaining = rows.length - rows.indexOf(row) - 1;
			console.error(`stripe deletion outbox stopped early: shared deadline expired — ${remaining} row(s) deferred to the next invocation`);
			break;
		}
		try {
			// Deadline on the REQUEST itself, not just before it (human review):
			// the shared Stripe client retries up to twice, so a hanging call
			// can blow past the cron budget and be killed before lastAttemptAt
			// is recorded — the row would then be selected again immediately
			// and starve moderation. customers.del's timeout is per ATTEMPT, so
			// disable network retries (maxNetworkRetries: 0) to keep the whole
			// operation within the remaining deadline; a timeout fails loudly
			// (and records lastAttemptAt, so the row backs off for the next hour).
			const requestOptions: StripeRequestOptionsFactory | undefined =
				deadline === undefined ? undefined : () => {
					const remaining = deadline - Date.now();
					if (remaining <= 0) throw new Error('stripe deletion shared deadline expired');
					return { timeout: remaining, maxNetworkRetries: 0 };
				};
			await cancelCustomerSubscriptions(row.customerId, requestOptions);
			if (deadline === undefined) {
				await getStripe().customers.del(row.customerId);
			} else {
				await getStripe().customers.del(row.customerId, undefined, requestOptions?.());
			}
			await db.delete(stripeDeletionOutbox).where(eq(stripeDeletionOutbox.id, row.id));
			deleted += 1;
		} catch (error) {
			const attempts = row.attempts + 1;
			await db
				.update(stripeDeletionOutbox)
				.set({ attempts, lastAttemptAt: new Date().toISOString() })
				.where(eq(stripeDeletionOutbox.id, row.id));
			console.error(
				`stripe deletion retry ${attempts} failed for customer ${row.customerId}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	return deleted;
}

/**
 * Erases the e-mail from consent records older than the 10-year retention period.
 *
 * The consent ROW is kept (document version, checkbox text, timestamps stay
 * as anonymized evidence); only the personal identifier is erased. Bounded
 * to one small batch per call (I10) — repeated cron invocations drain the
 * backlog.
 *
 * @returns The number of consent rows whose e-mail was erased
 */
export async function nullExpiredConsentEmails(): Promise<number> {
	const expired = await db
		.select({ id: consents.id })
		.from(consents)
		.where(and(isNotNull(consents.email), lt(consents.createdAt, consentEmailCutoffIso())))
		.limit(CONSENT_SWEEP_BATCH)
		.all();
	// Stryker disable next-line ConditionalExpression: false equivalent — with zero expired rows the update runs inArray([]) (drizzle compiles to `false`, no rows updated) and expired.length is 0, so the skipped early return returns the same 0.
	if (!expired.length) return 0;
	await db
		.update(consents)
		.set({ email: null })
		.where(
			inArray(
				consents.id,
				expired.map((row) => row.id)
			)
		);
	return expired.length;
}

/**
 * Calculates the cutoff timestamp for commenter-handle retention on audit rows.
 *
 * @param now - The reference time in milliseconds since the Unix epoch
 * @returns The ISO timestamp 30 days before `now`
 */
export function auditHandleCutoffIso(now = Date.now()): string {
	return new Date(now - AUDIT_HANDLE_RETENTION_MS).toISOString();
}

/**
 * One bounded handle-retention batch: select up to one batch of ids whose
 * handle is still stored and whose row predates the cutoff, null the handle,
 * return the erased count. Parameterized on the two queries and the id type
 * (audit_log's INTEGER id, moderation_actions' TEXT commentId) so each
 * handle-bearing table is a thin wrapper calling this helper.
 */
async function nullExpiredHandlesBatch<Id>(
	selectExpiredIds: (cutoffIso: string) => Promise<{ id: Id }[]>,
	nullHandlesByIds: (ids: Id[]) => Promise<unknown>
): Promise<number> {
	const expired = await selectExpiredIds(auditHandleCutoffIso());
	// Stryker disable next-line ConditionalExpression: false equivalent — with zero expired rows the update runs inArray([]) (drizzle compiles to `false`, no rows updated) and expired.length is 0, so the skipped early return returns the same 0.
	if (!expired.length) return 0;
	await nullHandlesByIds(expired.map((row) => row.id));
	return expired.length;
}

/**
 * Erases stored commenter handles from audit rows older than the 30-day
 * retention period.
 *
 * The audit ROW is kept (action, reason, text, actor, timestamps stay as the
 * moderation record); only the personal identifier is erased. Bounded to one
 * small batch per call (I10) — repeated cron invocations drain the backlog.
 *
 * @returns The number of audit rows whose handle was erased
 */
export async function nullExpiredAuditLogHandles(): Promise<number> {
	return nullExpiredHandlesBatch(
		(cutoffIso) =>
			db
				.select({ id: auditLog.id })
				.from(auditLog)
				.where(and(isNotNull(auditLog.authorHandle), lt(auditLog.createdAt, cutoffIso)))
				.limit(AUDIT_HANDLE_SWEEP_BATCH)
				.all(),
		(ids) => db.update(auditLog).set({ authorHandle: null }).where(inArray(auditLog.id, ids))
	);
}

/**
 * Erases stored commenter handles from moderation action rows older than the
 * 30-day retention period.
 *
 * Same contract as the audit-log sweep: the action ROW is kept (comment id,
 * action, reason, state stay as the enforcement record); only the personal
 * identifier is erased. Bounded to one small batch per call (I10). Keyed by
 * the TEXT commentId primary key, not an integer id.
 *
 * @returns The number of moderation action rows whose handle was erased
 */
export async function nullExpiredModerationActionHandles(): Promise<number> {
	return nullExpiredHandlesBatch(
		(cutoffIso) =>
			db
				.select({ id: moderationActions.commentId })
				.from(moderationActions)
				.where(and(isNotNull(moderationActions.authorHandle), lt(moderationActions.createdAt, cutoffIso)))
				.limit(AUDIT_HANDLE_SWEEP_BATCH)
				.all(),
		(ids) => db.update(moderationActions).set({ authorHandle: null }).where(inArray(moderationActions.commentId, ids))
	);
}

/**
 * The cron-facing commenter-handle retention sweep: one bounded batch per
 * handle-bearing table (audit_log and moderation_actions), same 30-day TTL.
 * A failure in either table's sweep throws — the cron logs it loudly and
 * retries next invocation; the unswept table simply waits.
 *
 * @returns The erased count per table
 */
export async function nullExpiredHandles(): Promise<{ auditLog: number; moderationActions: number }> {
	const auditLogCount = await nullExpiredAuditLogHandles();
	const moderationActionsCount = await nullExpiredModerationActionHandles();
	return { auditLog: auditLogCount, moderationActions: moderationActionsCount };
}
