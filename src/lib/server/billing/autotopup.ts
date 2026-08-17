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

// Auto top-up: when an org's credit balance drops below its threshold, charge
// the saved card off-session for another bundle. Guard rails (all researched
// in docs/stripe-auto-topup.md):
//  - atomic in-flight claim (UPDATE ... WHERE auto_topup_state='idle') so two
//    concurrent triggers cannot both charge;
//  - idempotency key per customer per day (`autotopup:{cus}:{date}:{attempt}`)
//    so even a lost race collapses into one charge;
//  - cooldown ≥24h and caps of 1/day, 3/month;
//  - credits are granted ONLY by the payment_intent.succeeded webhook
//    (fulfillAutoTopup), never at charge-creation time;
//  - authentication_required (SCA) can never be retried off-session — the
//    state flips to 'disabled' and the customer must re-authenticate via a
//    fresh Checkout. Other declines disable after 2 consecutive failures.

import { and, asc, count, eq, gte, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { applyLedgerDelta, drainPendingReversals } from '$lib/server/billing/ledger';
import { creditTransactions, organizations } from '$lib/server/db/schema';
import { autoTopupBundle, bundleById, priceIdFor } from '$lib/server/stripe/bundles';
import { getStripe } from '$lib/server/stripe/client';

export const AUTO_TOPUP_DEFAULT_THRESHOLD = 100;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_PER_DAY = 1;
const MAX_PER_MONTH = 3;
const MAX_CONSECUTIVE_FAILURES = 2;
// Stripe retries webhook deliveries for up to 3 days; a claim left in_flight
// past that horizon means the webhook is definitively lost, so the sweep
// unsticks it (worst case: one duplicate charge, guarded by the daily cap
// and the idempotency key).
const STALE_CLAIM_MS = 3 * 24 * 60 * 60 * 1000;
// The reconciliation window must EXCEED the stale-claim horizon: a claim
// only becomes stale at 72h, so the very PI it exists to recover was created
// BEFORE the window. 7 days keeps the list tiny (3/month cap).
const RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface AutoTopupState {
	enabled: number | null;
	threshold: number | null;
	state: string | null;
	lastAttemptAt: string | null;
	failures: number | null;
	customerId: string | null;
	defaultPmId: string | null;
	creditsRemaining: number | null;
}

/**
 * Retrieves an organization's auto-top-up configuration and billing state.
 *
 * @param orgId - The organization's identifier
 * @returns The organization's auto-top-up settings, Stripe payment details, and remaining credits
 * @throws Error if the organization does not exist
 */
export async function readAutoTopupState(orgId: string): Promise<AutoTopupState> {
	const org = await db
		.select({
			enabled: organizations.autoTopupEnabled,
			threshold: organizations.autoTopupThreshold,
			state: organizations.autoTopupState,
			lastAttemptAt: organizations.autoTopupLastAttemptAt,
			failures: organizations.autoTopupFailures,
			customerId: organizations.stripeCustomerId,
			defaultPmId: organizations.stripeDefaultPmId,
			creditsRemaining: organizations.creditsRemaining
		})
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.get();
	if (!org) throw new Error(`org not found: ${orgId}`);
	return org;
}

/**
 * Computes the UTC calendar date after applying a time offset.
 *
 * @param offsetMs - The offset from the current time, in milliseconds
 * @returns The resulting date in `YYYY-MM-DD` format
 */
function startOfUtcDayIso(offsetMs: number): string {
	return new Date(Date.now() + offsetMs).toISOString().slice(0, 10);
}

/**
 * Counts automatic top-up credit transactions recorded since a timestamp.
 *
 * @param orgId - The organization whose transactions are counted
 * @param sinceIso - The ISO timestamp from which transactions are included
 * @returns The number of matching automatic top-up transactions
 */
async function topupCountsSince(orgId: string, sinceIso: string): Promise<number> {
	// COUNT in SQL with the createdAt predicate pushed down: the cap check runs
	// twice per trigger and the ledger grows without bound, so loading every
	// auto_topup row into memory to filter in JS would be unbounded work.
	const row = await db
		.select({ n: count() })
		.from(creditTransactions)
		.where(and(eq(creditTransactions.orgId, orgId), eq(creditTransactions.reason, 'auto_topup'), gte(creditTransactions.createdAt, sinceIso)))
		.get();
	return row?.n ?? 0;
}

/**
 * Extracts a Stripe error code or a fallback representation of the error.
 *
 * @param error - The error from which to extract a code.
 * @returns The `code`, `decline_code`, error message, or string representation, in that order of precedence.
 */
export function stripeErrorCode(error: unknown): string {
	if (error && typeof error === 'object') {
		// Prefer decline_code: a card decline's generic `code` is
		// 'card_declined', while decline_code carries the SPECIFIC reason
		// (e.g. 'authentication_required') that decides the failure path.
		const declineCode = (error as { decline_code?: unknown }).decline_code;
		if (typeof declineCode === 'string') return declineCode;
		const code = (error as { code?: unknown }).code;
		if (typeof code === 'string') return code;
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * True when a paymentIntents.create failure is a CARD failure (decline,
 * expired card, SCA-required) rather than an infrastructure failure (network
 * outage, timeout, rate limit, invalid request, Stripe API error). Only card
 * failures count against the org's consecutive-failure counter — two
 * unrelated API outages must never disable auto top-up.
 */
function isCardFailure(error: unknown): boolean {
	if (error && typeof error === 'object') {
		const type = (error as { type?: unknown }).type;
		// stripe-node surfaces ordinary declines as type 'StripeCardError'
		// (the API's raw error carries type 'card_error' on error.raw); the
		// SDK's own type field never equals the raw API type. Accept both so
		// a plain card_declined is counted as a card failure, not an
		// infrastructure blip (codex 6156).
		if (type === 'card_error' || type === 'StripeCardError') return true;
		const rawType = (error as { raw?: { type?: unknown } }).raw?.type;
		if (rawType === 'card_error') return true;
		// Auth codes are card failures even when the type field is absent.
		const code = stripeErrorCode(error);
		return (
			code === 'authentication_required' ||
			code === 'authentication_not_handled' ||
			code === 'requires_action' ||
			code.includes('authentication_required') // legacy message-shaped callers
		);
	}
	return false;
}

/**
 * Attempts to initiate an off-session Stripe auto-top-up when the organization is eligible.
 *
 * Payment failures are recorded and result in `false`; setup and configuration errors may
 * propagate before a top-up is claimed.
 *
 * @param orgId - The organization to charge
 * @returns `true` if a payment was initiated, `false` if the organization was ineligible or payment initiation failed
 */
export async function maybeTriggerAutoTopUp(orgId: string): Promise<boolean> {
	const org = await readAutoTopupState(orgId);
	if (org.enabled !== 1) return false;
	const threshold = org.threshold ?? AUTO_TOPUP_DEFAULT_THRESHOLD;
	if ((org.creditsRemaining ?? 0) >= threshold) return false;
	if (org.state === 'disabled') {
		console.error(`auto top-up skipped for org ${orgId}: disabled (re-authentication or repeated failures)`);
		return false;
	}
	if (org.state === 'in_flight') return false; // a charge is already pending
	if (!org.customerId || !org.defaultPmId) return false; // no saved card
	const lastAttempt = org.lastAttemptAt ? Date.parse(org.lastAttemptAt) : 0;
	if (lastAttempt && Date.now() - lastAttempt < COOLDOWN_MS) return false;
	const dayStart = `${startOfUtcDayIso(0)}T00:00:00.000Z`;
	const monthStart = `${startOfUtcDayIso(0).slice(0, 8)}01T00:00:00.000Z`;
	const dayCount = await topupCountsSince(orgId, dayStart);
	const monthCount = await topupCountsSince(orgId, monthStart);
	if (dayCount >= MAX_PER_DAY || monthCount >= MAX_PER_MONTH) return false;

	// Resolve the bundle and price BEFORE the atomic claim: a throw here
	// (missing env config, Stripe network/API error) must never leave the org
	// wedged in in_flight. The claim is taken only once a charge is about to be
	// attempted, so a failure here leaves the org idle for the next sweep.
	const bundle = autoTopupBundle();
	const price = await getStripe().prices.retrieve(priceIdFor(bundle));
	// Validate the configured Price BEFORE claiming: manual Checkout rejects
	// archived prices at session creation, but the auto-charge path copies
	// unit_amount and charges USD unconditionally — an archived, non-USD, or
	// recurring Price must never fund a differently denominated charge.
	if (!price.active || price.currency !== 'usd' || price.type !== 'one_time') {
		console.error(
			`auto top-up skipped for org ${orgId}: bundle ${bundle.id} price ${price.id} is not an active one-time USD price (active=${price.active}, currency=${price.currency}, type=${price.type})`
		);
		return false;
	}
	const amount = price.unit_amount ?? 0;
	if (!amount) {
		console.error(`auto top-up skipped for org ${orgId}: bundle ${bundle.id} price has no unit_amount`);
		return false;
	}

	// Atomic claim: exactly one concurrent caller wins the transition.
	const claimed = await db
		.update(organizations)
		.set({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: new Date().toISOString() })
		.where(and(eq(organizations.id, orgId), eq(organizations.autoTopupState, 'idle')))
		.returning({ id: organizations.id });
	if (claimed.length === 0) return false; // lost the race

	const idempotencyKey = `autotopup:${org.customerId}:${startOfUtcDayIso(0)}:${dayCount + 1}`;
	try {
		await getStripe().paymentIntents.create(
			{
				amount,
				currency: 'usd',
				customer: org.customerId,
				payment_method: org.defaultPmId,
				off_session: true,
				confirm: true,
				metadata: { type: 'auto_topup', org_id: orgId, bundle: bundle.id }
			},
			{ idempotencyKey }
		);
		console.info(`auto top-up initiated for org ${orgId}: bundle ${bundle.id} (${idempotencyKey})`);
		return true;
	} catch (error) {
		// Classification matters: a CARD failure (decline/SCA) records against
		// the org — repeated failures disable auto top-up. An infrastructure
		// failure (timeout, outage, rate limit, invalid request) is not the
		// customer's card: release the claim back to idle WITHOUT counting it,
		// so the next sweep retries normally and auto top-up is never disabled
		// by two unrelated API outages. Either way the failure is loud.
		if (isCardFailure(error)) {
			// A create-time confirmation failure (decline, expired card...) never
			// fires payment_failed — record it here with the real Stripe error
			// CODE (never the message: SCA codes like authentication_required
			// must disable auto top-up, and messages are locale-dependent).
			await recordAutoTopupFailure(orgId, stripeErrorCode(error));
		} else {
			// The attempt timestamp clears with the claim: the failure was not
			// the customer's card, so the 24h cooldown must not stall the next
			// sweep. A declined card keeps its timestamp (don't hammer a bad
			// card for a day); an outage must be retried as soon as it clears.
			await db
				.update(organizations)
				.set({ autoTopupState: 'idle', autoTopupLastAttemptAt: null })
				.where(and(eq(organizations.id, orgId), eq(organizations.autoTopupState, 'in_flight')));
			console.error(
				`auto top-up infra failure for org ${orgId}: ${error instanceof Error ? error.message : String(error)} — claim released, no decline counted, no cooldown`
			);
		}
		return false;
	}
}

/**
 * Records a failed auto-top-up attempt and updates the organization’s auto-top-up state.
 *
 * Authentication failures or repeated consecutive failures disable auto-top-up; otherwise, the organization returns to the idle state. Stale or duplicate failures are ignored.
 *
 * @param orgId - The organization associated with the failed payment
 * @param code - The Stripe failure or decline code
 * @param piCreatedMs - The PaymentIntent creation time in milliseconds, when available
 */
export async function recordAutoTopupFailure(orgId: string, code: string, piCreatedMs?: number): Promise<void> {
	const org = await readAutoTopupState(orgId);
	// Correlation: a payment_failed webhook carries the PI it belongs to, and
	// the claim stamps last_attempt_at at charge time. A failure for an OLDER
	// PI arriving during a NEWER claim's in-flight window must not poison the
	// new attempt's counter.
	if (piCreatedMs && org.lastAttemptAt) {
		const drift = Math.abs(piCreatedMs - Date.parse(org.lastAttemptAt));
		if (drift > 60_000) {
			console.error(
				`auto top-up failure for a STALE attempt (PI created ${new Date(piCreatedMs).toISOString()}, claim at ${org.lastAttemptAt}) — ignored for org ${orgId}`
			);
			return;
		}
	}
	const isAuth =
		code === 'authentication_required' ||
		code === 'authentication_not_handled' ||
		code === 'requires_action' ||
		code.includes('authentication_required'); // legacy message-shaped callers
	const nextFailures = (org.failures ?? 0) + 1;
	const nextState = isAuth || nextFailures >= MAX_CONSECUTIVE_FAILURES ? 'disabled' : 'idle';
	// ONE conditional UPDATE: the atomic claim-to-failure transition. A
	// duplicate delivery (state already left in_flight) matches 0 rows and is
	// a no-op — the counter can never double-count, even with read-then-write
	// races between two concurrent deliveries.
	const updated = await db
		.update(organizations)
		.set({ autoTopupState: nextState, autoTopupFailures: nextFailures, autoTopupLastAttemptAt: new Date().toISOString() })
		.where(and(eq(organizations.id, orgId), eq(organizations.autoTopupState, 'in_flight')))
		.returning({ id: organizations.id });
	if (updated.length === 0) {
		console.error(`auto top-up failure for org ${orgId} arrived without an in-flight claim — ignored (duplicate or stale delivery)`);
		return;
	}
	console.error(
		`auto top-up ${nextState === 'disabled' ? 'DISABLED' : 'failed'} for org ${orgId}: ${code} (failure #${nextFailures}${isAuth ? ', SCA re-authentication required' : ''})`
	);
}

/**
 * Handles payment_intent.payment_failed for an auto-top-up PI. Never retries
 * off-session — the customer must re-authenticate (fresh Checkout) or update
 * their card.
 */
export async function handleAutoTopupFailure(paymentIntentId: string): Promise<void> {
	const pi = await getStripe().paymentIntents.retrieve(paymentIntentId);
	if (pi.metadata?.type !== 'auto_topup') return; // not ours — ignore
	const orgId = pi.metadata?.org_id;
	if (!orgId) {
		console.error(`auto top-up PI ${paymentIntentId} has no org_id metadata`);
		return;
	}
	// decline_code first: it carries the SPECIFIC reason (authentication_required),
	// while `code` on a card decline is the generic 'card_declined'.
	const code = pi.last_payment_error?.decline_code ?? pi.last_payment_error?.code ?? 'payment_failed';
	// The PI's creation time correlates the failure to the claim it belongs to.
	await recordAutoTopupFailure(orgId, code, pi.created ? pi.created * 1000 : undefined);
}

/**
 * Applies credits for a valid succeeded auto-top-up PaymentIntent and releases the organization claim.
 *
 * @param orgId - The organization receiving the credits
 * @param pi - The PaymentIntent to validate and fulfill
 * @returns `true` if credits were applied, `false` if the PaymentIntent is invalid or was already fulfilled
 */
export async function grantAutoTopupCredits(
	orgId: string,
	pi: { id: string; status?: string | null; latest_charge?: string | { id: string } | null; metadata: Record<string, string> | null }
): Promise<boolean> {
	// The contract lives HERE, not with the callers: only a succeeded charge
	// of ours can be granted.
	if (pi.status !== 'succeeded') return false;
	if (pi.metadata?.type !== 'auto_topup') return false;
	if (pi.metadata?.org_id !== orgId) return false;
	const bundleId = pi.metadata?.bundle;
	if (!bundleId) {
		console.error(`stripe: auto-topup PI ${pi.id} has no bundle metadata`);
		return false;
	}
	const bundle = bundleById(bundleId);
	const applied = await applyLedgerDelta(db, {
		orgId,
		delta: bundle.credits,
		reason: 'auto_topup',
		refType: 'payment_intent',
		refId: pi.id,
		paymentIntentId: pi.id,
		chargeId: typeof pi.latest_charge === 'string' ? pi.latest_charge : undefined
	});
	if (!applied) return false; // duplicate delivery — already granted
	// A refund/dispute may have beaten this grant's delivery: drain the
	// queued reversal in the same breath as the grant (codex 6153).
	const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : undefined;
	if (chargeId) {
		const drained = await drainPendingReversals(chargeId);
		if (drained > 0) console.error(`stripe: auto-topup grant ${pi.id} immediately drained ${drained} pending reversal(s) for ${chargeId}`);
	}
	// The charge succeeded: release the in-flight claim, reset the failure
	// counter (last_attempt_at stays — it is the cooldown anchor).
	await db
		.update(organizations)
		.set({ autoTopupState: 'idle', autoTopupFailures: 0 })
		.where(eq(organizations.id, orgId));
	return true;
}

/**
 * Recovers credits for recent successful auto-top-up payments whose webhook processing may have been missed.
 *
 * @returns The number of recovered payments
 */
export async function reconcileAutoTopup(orgId: string): Promise<number> {
	const org = await readAutoTopupState(orgId);
	if (!org.customerId) return 0;
	const sinceSeconds = Math.floor((Date.now() - RECONCILE_WINDOW_MS) / 1000);
	const list = await getStripe().paymentIntents.list({
		customer: org.customerId,
		created: { gte: sinceSeconds },
		limit: 100
	});
	let granted = 0;
	for (const pi of list.data) {
		if (pi.status !== 'succeeded') continue;
		if (await grantAutoTopupCredits(orgId, pi)) granted += 1;
	}
	if (granted > 0) {
		console.info(`auto top-up reconciliation granted ${granted} recovered charge(s) for org ${orgId}`);
	}
	return granted;
}

/**
 * Processes a bounded batch of organizations eligible for automatic credit top-up.
 *
 * @param limit - Maximum number of organizations to process in this invocation
 * @param deadline - Optional epoch-ms deadline shared with the caller (the cron
 *   budget): checked before every org — each one may perform Stripe list/price/
 *   create calls with SDK retries, and the sweep must never eat the whole
 *   serverless window; an expired deadline stops the sweep early (the next
 *   cron invocation continues).
 * @returns The number of newly initiated top-ups
 */
export async function sweepAutoTopUp(limit = 5, deadline?: number): Promise<number> {
	// Unstick stale in-flight claims first: a webhook delivery lost past
	// Stripe's 3-day retry horizon would otherwise wedge auto top-up forever.
	await db
		.update(organizations)
		.set({ autoTopupState: 'idle' })
		.where(
			and(
				eq(organizations.autoTopupState, 'in_flight'),
				or(
					isNull(organizations.autoTopupLastAttemptAt),
					sql`${organizations.autoTopupLastAttemptAt} < ${new Date(Date.now() - STALE_CLAIM_MS).toISOString()}`
				)
			)
		);
	const rows = await db
		.select({ id: organizations.id })
		.from(organizations)
		.where(
			and(
				eq(organizations.autoTopupEnabled, 1),
				eq(organizations.autoTopupState, 'idle'),
				// COALESCE both sides: a NULL balance (pre-billing org) must read
				// as 0 here, or SQL NULL comparison silently drops the org.
				sql`COALESCE(${organizations.creditsRemaining}, 0) < COALESCE(${organizations.autoTopupThreshold}, ${AUTO_TOPUP_DEFAULT_THRESHOLD})`,
				// A cardless org can never be charged (maybeTriggerAutoTopUp
				// returns false) — excluding it here keeps the bounded batch
				// full of chargeable orgs: otherwise N ineligible rows could
				// occupy the whole limit every invocation and starve everyone
				// else (I10 fairness). Never-attempted orgs sort first (SQLite
				// NULLs first in ASC), a natural fair rotation.
				isNotNull(organizations.stripeCustomerId),
				isNotNull(organizations.stripeDefaultPmId)
			)
		)
		.orderBy(asc(organizations.autoTopupLastAttemptAt), asc(organizations.id))
		.limit(limit)
		.all();
	let triggered = 0;
	for (const row of rows) {
		// Deadline guard: the sweep shares the cron's budget with moderation —
		// Stripe calls with SDK retries must never consume the whole window.
		// The remaining orgs wait for the next invocation (bounded, I10).
		if (deadline !== undefined && Date.now() >= deadline) {
			console.error(`auto top-up sweep stopped early for org ${row.id}: shared deadline expired — remaining orgs deferred to the next invocation`);
			break;
		}
		try {
			// Reconcile first: a lost webhook for a SUCCEEDED charge must grant
			// its credits before any new charge is considered (no double charge,
			// no lost money). Idempotent and cheap — one list call per org.
			await reconcileAutoTopup(row.id);
			if (await maybeTriggerAutoTopUp(row.id)) triggered += 1;
		} catch (error) {
			console.error(`auto top-up sweep failed for org ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return triggered;
}
