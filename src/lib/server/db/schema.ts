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

import { sqliteTable, text, integer, index, primaryKey, check, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Stryker note: StringLiteral "" mutants on a column db name that equals the
// property key are equivalent — drizzle treats an empty name as falsy and
// falls back to the property key (verified against drizzle-orm 0.45.2;
// getTableConfig reports the property name either way). Those lines carry a
// `Stryker disable next-line StringLiteral` directive. On lines with a second
// string literal (`.default('free')`) the directive also ignores that mutant;
// the default value itself is still pinned by schema.test.ts.

export const users = sqliteTable('users', {
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	id: text('id').primaryKey(), // random hex
	googleSub: text('google_sub').notNull().unique(), // Google's stable `sub` claim
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	email: text('email').notNull(),
	displayName: text('display_name').notNull(),
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	plan: text('plan').notNull().default('free'), // LEGACY — billing hooks live on organizations.plan; read nowhere
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
});

export const sessions = sqliteTable('sessions', {
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	id: text('id').primaryKey(), // random 32-byte hex token; also the cookie value
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	activeOrgId: text('active_org_id'), // tenant the session is acting in; null = resolve to oldest membership
	expiresAt: text('expires_at').notNull(), // ISO timestamp; sliding 30-day expiry
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
}, (table) => [
	index('sessions_user_id_idx').on(table.userId)
]);

// Tenant. Every user owns a personal org (personal_for set, UNIQUE), created
// in the signup transaction; shared orgs (personal_for NULL) are created from
// the Team settings page. `plan` is the Stripe gating hook — billing is
// per-ORGANIZATION (users.plan is legacy and read nowhere).
export const organizations = sqliteTable('organizations', {
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	id: text('id').primaryKey(), // random hex
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	name: text('name').notNull(),
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	plan: text('plan').notNull().default('free'), // future Stripe gating hook (hosted plans)
	personalFor: text('personal_for').unique(), // users.id of the user this is the personal org for; null = shared org
	// Per-org BYOK OpenAI key (hosted plans), AES-256-GCM via crypto.ts —
	// owner-managed from the Team page; never serialized to the client.
	openaiKeyEnc: text('openai_key_enc'),
	// Billing — prepaid comment credits, per-ORGANIZATION (the tenant grain).
	// credits_remaining is authoritative: every consume/grant/reverse mutates
	// it transactionally with a credit_transactions row. Stripe is the payment
	// rail; the ledger itself is provider-agnostic (a future MercadoPago
	// provider reuses it). Columns are nullable until the contract migration.
	creditsRemaining: integer('credits_remaining'),
	stripeCustomerId: text('stripe_customer_id'), // Stripe Customer for this org
	stripeDefaultPmId: text('stripe_default_pm_id'), // card saved for off-session auto top-up
	autoTopupEnabled: integer('auto_topup_enabled'),
	autoTopupThreshold: integer('auto_topup_threshold'), // top up when credits < threshold
	// 'idle' | 'in_flight' | 'disabled' — in_flight is the atomic claim against
	// concurrent triggers; disabled after SCA/decline failures until the
	// customer re-authenticates (never blind-retried off-session).
	autoTopupState: text('auto_topup_state'),
	autoTopupLastAttemptAt: text('auto_topup_last_attempt_at'),
	autoTopupFailures: integer('auto_topup_failures'),
	// Auto top-up authorization evidence (Stripe save-and-reuse compliance:
	// keep a record of the written agreement). Written once on the
	// disabled→enabled transition and NEVER cleared by disabling — the record
	// that authorization was given must survive for dispute defense.
	autoTopupConsentText: text('auto_topup_consent_text'), // exact checkbox sentence
	autoTopupConsentVersion: text('auto_topup_consent_version'), // LEGAL_VERSION at consent
	autoTopupConsentedBy: text('auto_topup_consented_by'), // users.id who ticked the box
	autoTopupConsentedAt: text('auto_topup_consented_at'),
	// Hosted subscription entitlement cache. The period table below is the
	// source of truth for the 100-comment allowance; these fields make
	// organization lookup and access checks bounded.
	stripeSubscriptionId: text('stripe_subscription_id'),
	stripeSubscriptionStatus: text('stripe_subscription_status'),
	stripeSubscriptionPeriodStart: text('stripe_subscription_period_start'),
	stripeSubscriptionPeriodEnd: text('stripe_subscription_period_end'),
	stripeSubscriptionCancelAtPeriodEnd: integer('stripe_subscription_cancel_at_period_end'),
	stripeSubscriptionLastEventCreated: integer('stripe_subscription_last_event_created'),
	stripeSubscriptionLastEventId: text('stripe_subscription_last_event_id'),
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
}, (table) => [
	uniqueIndex('organizations_stripe_customer_id_unique').on(table.stripeCustomerId).where(sql`${table.stripeCustomerId} IS NOT NULL`),
	uniqueIndex('organizations_stripe_subscription_id_unique').on(table.stripeSubscriptionId).where(sql`${table.stripeSubscriptionId} IS NOT NULL`)
]);

export const stripeSubscriptionPeriods = sqliteTable('stripe_subscription_periods', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
	subscriptionId: text('subscription_id').notNull(),
	invoiceId: text('invoice_id').notNull().unique(),
	paymentIntentId: text('payment_intent_id'),
	chargeId: text('charge_id'),
	periodKey: text('period_key').notNull(),
	periodStart: text('period_start').notNull(),
	periodEnd: text('period_end').notNull(),
	includedCredits: integer('included_credits').notNull().default(100),
	consumedCredits: integer('consumed_credits').notNull().default(0),
	status: text('status').notNull().default('paid'), // paid | disputed | refunded | void
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
}, (table) => [
	uniqueIndex('stripe_subscription_periods_subscription_period_unique').on(table.subscriptionId, table.periodKey),
	index('stripe_subscription_periods_org_period_idx').on(table.orgId, table.periodStart),
	index('stripe_subscription_periods_payment_intent_idx').on(table.paymentIntentId),
	index('stripe_subscription_periods_charge_idx').on(table.chargeId)
]);

/** Pre-created slots make the first-1,000 lifetime cap transactional. */
export const stripeLifetimeSlots = sqliteTable('stripe_lifetime_slots', {
	slot: integer('slot').primaryKey(),
	activeOrgId: text('active_org_id').references(() => organizations.id, { onDelete: 'set null' }),
	activeEntitlementId: integer('active_entitlement_id'),
	claimedAt: text('claimed_at'),
	releasedAt: text('released_at')
}, (table) => [index('stripe_lifetime_slots_active_org_idx').on(table.activeOrgId)]);

export const stripeLifetimeEntitlements = sqliteTable('stripe_lifetime_entitlements', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
	slot: integer('slot').notNull().references(() => stripeLifetimeSlots.slot),
	checkoutSessionId: text('checkout_session_id').notNull().unique(),
	paymentIntentId: text('payment_intent_id'),
	chargeId: text('charge_id'),
	status: text('status').notNull().default('active'), // active | disputed | released
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
	releasedAt: text('released_at')
}, (table) => [
	uniqueIndex('stripe_lifetime_entitlements_active_org_idx').on(table.orgId).where(sql`${table.status} = 'active'`),
	uniqueIndex('stripe_lifetime_entitlements_active_slot_idx').on(table.slot).where(sql`${table.status} = 'active'`),
	index('stripe_lifetime_entitlements_payment_intent_idx').on(table.paymentIntentId),
	index('stripe_lifetime_entitlements_charge_idx').on(table.chargeId)
]);

/** Durable local state for a Checkout request, including a retry-safe Stripe key. */
export const stripeCheckoutAttempts = sqliteTable('stripe_checkout_attempts', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	attemptId: text('attempt_id').notNull().unique(),
	orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
	product: text('product').notNull(),
	idempotencyKey: text('idempotency_key').notNull().unique(),
	stripeSessionId: text('stripe_session_id').unique(),
	status: text('status').notNull().default('pending'), // pending | open | fulfilled | expired
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
	updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
}, (table) => [
	index('stripe_checkout_attempts_org_status_idx').on(table.orgId, table.status)
]);

export const memberships = sqliteTable('memberships', {
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id, { onDelete: 'cascade' }),
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	role: text('role').notNull(), // 'owner' | 'admin' | 'member'
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
}, (table) => [
	primaryKey({ columns: [table.userId, table.orgId] }),
	index('memberships_org_id_idx').on(table.orgId)
]);

// Single-use invite link: /invite/<token>. Role is fixed at creation and is
// never 'owner' — ownership changes hands only via role change or deletion
// succession. acceptedBy null = still open; expired or accepted links are
// dead. "Anyone signed in with the link joins" is the intended semantic.
export const invites = sqliteTable('invites', {
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	token: text('token').primaryKey(), // random 32-byte hex; also the URL path segment
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id, { onDelete: 'cascade' }),
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	role: text('role').notNull(), // 'admin' | 'member'
	createdBy: text('created_by')
		.notNull()
		.references(() => users.id),
	expiresAt: text('expires_at').notNull(), // ISO timestamp; 7 days from creation
	acceptedBy: text('accepted_by'), // users.id of the accepter; null = open
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
}, (table) => [
	index('invites_org_id_idx').on(table.orgId)
]);

export const channels = sqliteTable('channels', {
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	id: text('id').primaryKey(), // YouTube channel ID (UC...)
	userId: text('user_id'), // connected-by user (whose Google grant this channel uses); null = pre-accounts orphan, claimed on first login
	orgId: text('org_id'), // owning TENANT; null only for pre-accounts orphans (user_id IS NULL) awaiting first-login claim
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	title: text('title').notNull(),
	refreshTokenEnc: text('refresh_token_enc').notNull(),
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	cursor: text('cursor'), // scan boundary (ISO): comments older than this are never fetched. New connects start at connection time (no history analyzed); "analyze history" moves it back; null = legacy pre-window row (unbounded first scan)
	nextPageToken: text('next_page_token'), // YouTube continuation token for an incomplete scan
	scanCursor: text('scan_cursor'), // high-water timestamp to commit once an incomplete scan ends
	historyNextPageToken: text('history_next_page_token'), // history-drain continuation token (issue #70): the drain walks history independently so the live cursor keeps advancing on newest comments every run; null = no drain in flight
	historyBoundary: text('history_boundary'), // ISO timestamp the history drain started walking back from (its eventual end state: cursor = boundary)
	dryRunBoundary: text('dry_run_boundary'), // on-demand dry-run window (ISO): the drain rescores comments down to this timestamp; null = no dry-run drain in flight
	dryRunPageToken: text('dry_run_page_token'), // YouTube continuation token for the dry-run drain's next page
	lastRunAt: text('last_run_at'), // ISO timestamp of last cron run; rotation orders by it ASC (NULLs first)
	leaseExpiresAt: text('lease_expires_at'), // expiring cron claim; null or past = claimable
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	active: integer('active').notNull().default(1),
	toneLevel: integer('tone_level'), // moderation sensitivity: null or 1 = omni only, 2 = omni + tone pass
	protectLgbtqia: integer('protect_lgbtqia').notNull().default(0), // protection setting: 1 = heightened protection for comments targeting LGBTQIA+ people
	protectWomen: integer('protect_women').notNull().default(0), // protection setting: 1 = heightened protection for comments targeting women
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
}, (table) => [
	index('channels_user_id_idx').on(table.userId),
	index('channels_org_id_idx').on(table.orgId),
	check('channels_org_requires_owner', sql`${table.orgId} IS NOT NULL OR ${table.userId} IS NULL`)
]);

export const rules = sqliteTable('rules', {
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	id: integer('id').primaryKey({ autoIncrement: true }),
	channelId: text('channel_id').notNull(),
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	type: text('type').notNull(), // 'keyword' | 'regex' | 'user'
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	pattern: text('pattern').notNull(), // keyword string | regex source | authorChannelId
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	action: text('action').notNull(), // 'hold' | 'reject' | 'delete' | 'ban'
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
});

// Per-channel allowlist of protected commenter handles. Plain-text channelId
// like every channel-child table (no FKs — orphan protection is deletion.ts +
// the verify-tenancy probe). `handle` stores the normalized lowercase form.
export const channelAllowedHandles = sqliteTable('channel_allowed_handles', {
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	id: integer('id').primaryKey({ autoIncrement: true }),
	channelId: text('channel_id').notNull(),
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	handle: text('handle').notNull(), // normalized lowercase commenter handle
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
}, (table) => [
	index('channel_allowed_handles_channel_idx').on(table.channelId)
]);

export const comments = sqliteTable('comments', {
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	id: text('id').primaryKey(), // YouTube comment ID
	channelId: text('channel_id').notNull(),
	// DEPRECATED (author PII): never written since the author-identifier
	// change — they are processed in memory at decision time only. Relaxed
	// to nullable + wiped by migration 0008 so old and new code coexist
	// during rollout; DROPPED by the follow-up contract migration.
	// Exception: user rules (rules.pattern with type 'user') store an
	// authorChannelId the channel owner enters as their own configuration;
	// no identifier is ever taken from a fetched comment and stored.
	authorChannelId: text('author_channel_id'),
	authorName: text('author_name'),
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	text: text('text').notNull(), // truncated to 500 chars on insert
	publishedAt: text('published_at').notNull(),
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	status: text('status').notNull(), // 'pending' | 'approved' | 'held' | 'rejected' | 'deleted' | 'restoring' (in-flight undo)
	decidedBy: text('decided_by').notNull(), // 'rule' | 'ai' | 'human' | 'none' | 'allowlist'
	matchedRuleId: integer('matched_rule_id'),
	aiScore: text('ai_score'), // JSON string of the six category scores, or null
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
});

export const moderationActions = sqliteTable('moderation_actions', {
	commentId: text('comment_id').primaryKey(),
	channelId: text('channel_id').notNull(),
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	action: text('action').notNull(), // 'hold' | 'reject' | 'delete' | 'ban'
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	reason: text('reason').notNull(),
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	state: text('state').notNull(), // 'pending' | 'dispatched' | 'completed' ('manual_review' legacy)
	lastAttemptAt: text('last_attempt_at'),
	lastManualRetryAt: text('last_manual_retry_at'),
	// Normalized commenter handle, 30-day TTL (same retention as audit_log):
	// staged with the decision and carried to the completion audit row.
	authorHandle: text('author_handle'),
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
}, (table) => [
	index('moderation_actions_channel_state_idx').on(table.channelId, table.state)
]);

export const auditLog = sqliteTable('audit_log', {
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	id: integer('id').primaryKey({ autoIncrement: true }),
	channelId: text('channel_id').notNull(),
	commentId: text('comment_id').notNull(),
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	action: text('action').notNull(), // 'hold' | 'reject' | 'delete' | 'ban' | 'approve' | 'restore' | 'queue' | 'dry-run'
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	reason: text('reason').notNull(), // human-readable, e.g. "rule #4 (keyword)" or "ai score 0.91"
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	actor: text('actor').notNull(), // 'system' | 'user'
	// Comment text (≤500 chars) on dry-run rows only: a dry run never inserts
	// into comments (I8), so the audit row is the only place its text survives.
	// Null for every real-run action — that text lives in comments.text.
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	text: text('text'),
	// Normalized commenter handle (lowercase @handle), 30-day TTL, null on
	// manual rows (actor 'user' actions taken from the dashboard).
	authorHandle: text('author_handle'),
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
}, (table) => [
	// Dashboard ban counts (action='ban' + channel_id IN, issue #77) and the
	// per-channel log page both filter by channel_id; the composite serves
	// the ban query and its leftmost column serves channel-only reads.
	index('audit_log_channel_action_idx').on(table.channelId, table.action),
	// The log page's latest-per-comment query filters
	// channel_id = ? AND comment_id IN (page ids) (qodo review on PR #125);
	// without this, the page load would scan every audit row of the channel.
	index('audit_log_channel_comment_idx').on(table.channelId, table.commentId)
]);

// Evidentiary consent log (CDC Art. 6º, VIII; LGPD). One row per acceptance
// event — initial signup and every re-acceptance after a LEGAL_VERSION bump.
// Records exactly what was agreed to, when, and from where; never updated
// (except the cron sweep nulling `email` 10 years after acceptance). The
// e-mail lives HERE, not in the users row, because this log is the only
// place its retention is justified (Art. 16, III — blocked from any other
// use by architecture); account deletion wipes users.email entirely.
export const consents = sqliteTable('consents', {
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	email: text('email'), // retained consent evidence; nulled by the 10-year sweep
	docVersion: text('doc_version').notNull(), // LEGAL_VERSION accepted, e.g. 'v1.0'
	checkboxText: text('checkbox_text').notNull(), // exact text shown at acceptance
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	ip: text('ip').notNull(), // event.getClientAddress() at acceptance
	userAgent: text('user_agent').notNull(),
	marketingOptIn: integer('marketing_opt_in').notNull().default(0), // separate, unbundled LGPD consent
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
}, (table) => [
	index('consents_user_id_idx').on(table.userId),
	// Serves the 10-year retention sweep (email IS NOT NULL AND created_at <
	// cutoff): partial, so it indexes only rows that still hold an e-mail.
	index('consents_email_retention_idx').on(table.createdAt).where(sql`${table.email} is not null`)
]);

// Immutable credit ledger — the usage tab's source of truth. One row per
// credit event; `organizations.credits_remaining` is the authoritative
// balance and every row here is written in the same transaction as its
// balance mutation. UNIQUE(org_id, ref_type, ref_id) is the idempotency
// anchor (a comment is consumed once, a checkout session granted once).
export const creditTransactions = sqliteTable('credit_transactions', {
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	id: integer('id').primaryKey({ autoIncrement: true }),
	// Org FK with cascade (coderabbit): account deletion already deletes the
	// ledger rows explicitly, but the constraint makes an orphaned financial
	// row impossible even for a direct write. SQLite requires the table
	// rebuild migration (0025).
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id, { onDelete: 'cascade' }),
	// +N grant, -N consume/reverse
	delta: integer('delta').notNull(),
	// 'consume' | 'purchase' | 'auto_topup' | 'refund' | 'dispute' | 'adjust'
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	reason: text('reason').notNull(),
	// 'comment' | 'checkout_session' | 'payment_intent' | 'charge' | 'dispute' | 'admin'
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	refType: text('ref_type').notNull(),
	refId: text('ref_id').notNull(),
	// Stripe reconciliation anchors — a refund/dispute arrives with a charge
	// or payment-intent id and must find the grant(s) it reverses.
	paymentIntentId: text('payment_intent_id'),
	chargeId: text('charge_id'),
	// Balance after this row applied; null for legacy/edge rows.
	balanceAfter: integer('balance_after'),
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
}, (table) => [
	uniqueIndex('credit_transactions_org_ref_idx').on(table.orgId, table.refType, table.refId),
	index('credit_transactions_org_created_idx').on(table.orgId, table.createdAt),
	index('credit_transactions_pi_idx').on(table.paymentIntentId),
	index('credit_transactions_charge_idx').on(table.chargeId)
]);

// Stripe webhook event receipt — the webhook dedupe anchor. Dedupe is by
// EVENT ID only: a later event for the same object (e.g. a charge.refunded
// that first arrives partial and then full) must be processed, and repeated
// processing is made idempotent by the ledger's own anchors. The
// (event_type, object_id) index is audit-only, NOT unique (codex review).
// Rows land in the same transaction as the ledger mutation they drive.
// Stripe reversal obligations whose grant had NOT yet arrived when the
// refund/dispute event was delivered (Stripe webhook order is not
// guaranteed — a charge.refunded can precede the checkout.session.completed
// that granted it). charge_id UNIQUE: one reversal per charge, first event
// wins. A grant that lands later drains the row (drainPendingReversals);
// the cron sweep drops rows whose grant never arrived.
export const stripePendingReversals = sqliteTable(
	'stripe_pending_reversals',
	{
		// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
		id: integer('id').primaryKey({ autoIncrement: true }),
		chargeId: text('charge_id').notNull(), // ch_...
		// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
		reason: text('reason').notNull(), // 'refund' | 'dispute'
		disputeId: text('dispute_id'),
		createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
	},
	// UNIQUE(charge_id, reason), NOT charge_id alone: a dispute AND a later
	// full refund can both queue before the delayed grant lands, and each
	// obligation must survive to drain on its own ledger anchor — the
	// charge-only key silently dropped whichever reason arrived second
	// (codex review).
	(table) => [uniqueIndex('stripe_pending_reversals_charge_reason_idx').on(table.chargeId, table.reason)]
);


// One durable row per dispute lets a won-dispute event restore only the
// entitlement that this exact dispute revoked. A pending row is resolved when
// the payment grant arrives after the dispute event.
export const stripeDisputeReversals = sqliteTable('stripe_dispute_reversals', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	disputeId: text('dispute_id').notNull().unique(),
	chargeId: text('charge_id').notNull(),
	paymentIntentId: text('payment_intent_id'),
	status: text('status').notNull().default('pending'), // pending | reversed | ignored | won | restored
	source: text('source').notNull().default('unknown'), // credits | lifetime | subscription | unknown
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
	restoredAt: text('restored_at')
}, (table) => [index('stripe_dispute_reversals_charge_idx').on(table.chargeId)]);

// Stripe customers still owed deletion after account teardown (the Stripe
// erase is best-effort post-commit; a transient Stripe outage must not lose
// the erasure). The cron retries the batch until Stripe confirms.
export const stripeDeletionOutbox = sqliteTable('stripe_deletion_outbox', {
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	id: integer('id').primaryKey({ autoIncrement: true }),
	customerId: text('customer_id').notNull().unique(), // cus_...
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	attempts: integer('attempts').notNull().default(0),
	lastAttemptAt: text('last_attempt_at'),
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
});

export const stripeEvents = sqliteTable('stripe_events', {
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	id: integer('id').primaryKey({ autoIncrement: true }),
	eventId: text('event_id').notNull().unique(), // evt_...
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	eventType: text('event_type').notNull(),
	objectId: text('object_id').notNull(), // cs_... | pi_... | ch_... | du_...
	objectType: text('object_type').notNull(),
	receivedAt: text('received_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
	processedAt: text('processed_at'),
	processingStartedAt: text('processing_started_at'),
	processingLeaseToken: text('processing_lease_token'),
	processingAttempts: integer('processing_attempts').notNull().default(0)
}, (table) => [
	index('stripe_events_type_object_idx').on(table.eventType, table.objectId)
]);

// Opt-in contact requests from the public /contact form. A row is created
// PENDING when the form is submitted (name + e-mail + the explicit opt-in
// checkbox, whose exact sentence is stored verbatim on the row so the form
// can never drift from what the visitor agreed to), the verification e-mail
// is sent to the address, and the row flips to VERIFIED when the link in
// that e-mail is opened. No user account is involved. The e-mail is stored
// ONLY after the opt-in box was ticked — the whole point of the flow.
export const contactSubmissions = sqliteTable('contact_submissions', {
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	id: integer('id').primaryKey({ autoIncrement: true }),
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	email: text('email').notNull(), // submitted address, normalized to lowercase
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	name: text('name').notNull(), // submitted display name
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	status: text('status').notNull().default('pending'), // 'pending' | 'verified'
	verificationToken: text('verification_token').notNull().unique(), // random 32-byte hex; the URL token
	expiresAt: text('expires_at').notNull(), // ISO timestamp; verification link TTL (7 days, like invites)
	verifiedAt: text('verified_at'), // ISO timestamp of successful verification; null = not yet verified
	consentText: text('consent_text').notNull(), // exact opt-in checkbox sentence at submission
	// Stryker disable next-line StringLiteral: "" equivalent (drizzle falls back to property key)
	ip: text('ip').notNull(), // event.getClientAddress() at submission
	userAgent: text('user_agent').notNull(),
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
}, (table) => [
	// Resubmission dedupe (unexpired pending per e-mail) filters
	// status='pending' AND email=?; the status leftmost serves it.
	index('contact_submissions_status_email_idx').on(table.status, table.email),
	// Idempotency backstop (human review): at most ONE pending submission per
	// e-mail. createOrReusePendingSubmission is check-then-act — two
	// concurrent submissions can both miss the lookup and insert two rows with
	// different tokens (two verification e-mails). The partial unique index
	// makes the second insert conflict, so the function's conflict path can
	// converge on the winner's row. status='pending' ONLY: a verified row
	// frees the slot for a fresh submission.
	uniqueIndex('contact_submissions_pending_email_unique').on(table.email).where(sql`${table.status} = 'pending'`)
]);
