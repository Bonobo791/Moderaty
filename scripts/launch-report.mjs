#!/usr/bin/env node
// Read-only launch activity snapshot (MOD-271): a bounded aggregate report over
// whichever database TURSO_DATABASE_URL points at, for the operator answering
// three questions after the Reddit launch — surviving users and signups in the
// window, connected channels vs consumed preview attempts vs successful live
// runs, and which actual paid entitlements/credit grants exist — plus the
// persisted coarse failure states that need attention.
//
// Every number is a snapshot of surviving committed rows at observation time:
// deleted accounts are tombstones ('deleted:<id>' google_sub), preview markers
// are attempts (a failure can consume one), and last_success_at is the most
// recent live success — not first activation. Unknown history stays unknown.
//
// PRIVACY CONTRACT: aggregate counts and enum breakdowns only. No e-mails,
// names, tokens, comment text, handles, IPs, provider object ids or request
// data are ever selected. launch-report.test.mjs walks the emitted JSON and
// fails on any value that is not a count, ISO timestamp, or enum label.
//
// Usage:
//   node --env-file=.env scripts/launch-report.mjs [--since ISO] [--until ISO]
//
// Exit 0 prints the JSON snapshot; 1 = database/schema failure; 2 = bad args.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const USAGE =
	'Usage: node --env-file=.env scripts/launch-report.mjs [--since ISO-8601] [--until ISO-8601]';
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

class UsageError extends Error {}

// Every table the report reads. Checked up front against sqlite_master so a
// database that predates the schema fails loudly with the whole missing list
// instead of a bare "no such table" from whichever query ran first.
export const REQUIRED_TABLES = [
	'users',
	'organizations',
	'memberships',
	'channels',
	'comments',
	'moderation_actions',
	'audit_log',
	'feedback_digests',
	'welcome_emails',
	'contact_submissions',
	'stripe_checkout_attempts',
	'mercado_pago_checkout_attempts',
	'credit_transactions',
	'stripe_subscription_periods',
	'stripe_lifetime_slots',
	'stripe_lifetime_entitlements',
	'stripe_pending_reversals',
	'stripe_dispute_reversals',
	'stripe_auto_topup_recoveries',
	'stripe_deletion_outbox',
	'google_revocation_outbox',
	'stripe_scrub_outbox',
	'stripe_events'
];

// Full ISO-8601 only: date, or datetime with an explicit zone. A bare
// datetime ('2026-10-04T15:00') parses in local time — ambiguous, so rejected.
const ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

// Date.parse silently normalizes impossible dates ('2026-02-30' → Mar 2) and
// accepts non-ISO forms ('October 4, 2026'); report the wrong window and the
// operator reads numbers for a period they never asked for — so both the
// shape and the calendar value are validated before parsing.
function parseIsoTimestamp(flag, value) {
	const match = ISO_8601.exec(value);
	if (!match) throw new UsageError(`${flag} must be an ISO-8601 timestamp: ${value}`);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const lastDay = new Date(Date.UTC(Number(match[1]), month, 0)).getUTCDate();
	const ms = Date.parse(value);
	if (month < 1 || month > 12 || day < 1 || day > lastDay || !Number.isFinite(ms)) {
		throw new UsageError(`${flag} is not a valid timestamp: ${value}`);
	}
	return new Date(ms).toISOString();
}

export function parseArgs(argv, now = Date.now()) {
	let since;
	let until;
	const seen = new Set();
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		if (flag !== '--since' && flag !== '--until') throw new UsageError(`unknown argument: ${flag}`);
		if (seen.has(flag)) throw new UsageError(`duplicate ${flag}`);
		seen.add(flag);
		const value = argv[i + 1];
		if (value === undefined) throw new UsageError(`${flag} needs an ISO-8601 timestamp value`);
		i += 1;
		const iso = parseIsoTimestamp(flag, value);
		if (flag === '--since') since = iso;
		else until = iso;
	}
	since ??= new Date(now - DEFAULT_WINDOW_MS).toISOString();
	until ??= new Date(now).toISOString();
	// Normalized ISO-8601 UTC strings compare lexically = chronologically.
	if (!(since < until)) throw new UsageError('window is empty: --since must be before --until');
	return { since, until };
}

async function scalar(client, name, sql, args = []) {
	try {
		const result = await client.execute({ sql, args });
		return Number(result.rows[0]?.n ?? 0);
	} catch (error) {
		throw new Error(`launch-report: query ${name} failed — ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function grouped(client, name, sql, args = []) {
	try {
		const result = await client.execute({ sql, args });
		const out = {};
		for (const row of result.rows) out[String(row.k)] = Number(row.n);
		return out;
	} catch (error) {
		throw new Error(`launch-report: query ${name} failed — ${error instanceof Error ? error.message : String(error)}`);
	}
}

// One ledger row per reason needs the grouped shape plus netCredits, which the
// k→n grouped() helper cannot express.
async function ledgerGrouped(client, name, sql) {
	try {
		const result = await client.execute(sql);
		const out = {};
		for (const row of result.rows) out[String(row.k)] = { rows: Number(row.n), netCredits: Number(row.s) };
		return out;
	} catch (error) {
		throw new Error(`launch-report: query ${name} failed — ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function reportUsers(client, inWindow) {
	return {
		live: await scalar(client, 'users.live', "SELECT count(*) AS n FROM users WHERE google_sub NOT LIKE 'deleted:%'"),
		tombstoned: await scalar(client, 'users.tombstoned', "SELECT count(*) AS n FROM users WHERE google_sub LIKE 'deleted:%'"),
		signedUpInWindow: await scalar(client, 'users.signedUpInWindow', 'SELECT count(*) AS n FROM users WHERE created_at >= ? AND created_at < ?', inWindow),
		liveSignedUpInWindow: await scalar(client, 'users.liveSignedUpInWindow', "SELECT count(*) AS n FROM users WHERE google_sub NOT LIKE 'deleted:%' AND created_at >= ? AND created_at < ?", inWindow),
		inZeroCreditCountdown: await scalar(client, 'users.inZeroCreditCountdown', "SELECT count(*) AS n FROM users WHERE google_sub NOT LIKE 'deleted:%' AND zero_credits_since IS NOT NULL")
	};
}

async function reportOrganizations(client) {
	return {
		total: await scalar(client, 'organizations.total', 'SELECT count(*) AS n FROM organizations'),
		personal: await scalar(client, 'organizations.personal', 'SELECT count(*) AS n FROM organizations WHERE personal_for IS NOT NULL'),
		shared: await scalar(client, 'organizations.shared', 'SELECT count(*) AS n FROM organizations WHERE personal_for IS NULL'),
		withMeteredCredits: await scalar(client, 'organizations.withMeteredCredits', 'SELECT count(*) AS n FROM organizations WHERE credits_remaining IS NOT NULL'),
		withPositiveCredits: await scalar(client, 'organizations.withPositiveCredits', 'SELECT count(*) AS n FROM organizations WHERE credits_remaining > 0'),
		creditsRemainingTotal: await scalar(client, 'organizations.creditsRemainingTotal', 'SELECT COALESCE(SUM(credits_remaining), 0) AS n FROM organizations'),
		autoTopupPausedOrDisabled: await scalar(client, 'organizations.autoTopupPausedOrDisabled', "SELECT count(*) AS n FROM organizations WHERE auto_topup_state = 'disabled' OR auto_topup_pause_reason IS NOT NULL")
	};
}

async function reportChannels(client, inWindow) {
	return {
		total: await scalar(client, 'channels.total', 'SELECT count(*) AS n FROM channels'),
		active: await scalar(client, 'channels.active', 'SELECT count(*) AS n FROM channels WHERE active = 1'),
		inactive: await scalar(client, 'channels.inactive', 'SELECT count(*) AS n FROM channels WHERE active = 0'),
		// A deleted account leaves its team channels attached (org kept, user
		// cleared — deletion.ts): those need a reconnect, not a first-login
		// claim. Only rows with neither owner are claimable pre-account orphans.
		orphanedAwaitingClaim: await scalar(client, 'channels.orphaned', 'SELECT count(*) AS n FROM channels WHERE user_id IS NULL AND org_id IS NULL'),
		detachedAwaitingReconnect: await scalar(client, 'channels.detached', 'SELECT count(*) AS n FROM channels WHERE user_id IS NULL AND org_id IS NOT NULL'),
		// Tenant-grain distincts — never membership-joined counts.
		orgsWithChannels: await scalar(client, 'channels.orgsWithChannels', 'SELECT count(DISTINCT org_id) AS n FROM channels WHERE org_id IS NOT NULL'),
		usersWhoConnected: await scalar(client, 'channels.usersWhoConnected', 'SELECT count(DISTINCT user_id) AS n FROM channels WHERE user_id IS NOT NULL'),
		createdInWindow: await scalar(client, 'channels.createdInWindow', 'SELECT count(*) AS n FROM channels WHERE created_at >= ? AND created_at < ?', inWindow),
		moderationPreviewAttempted: await scalar(client, 'channels.moderationPreviewAttempted', 'SELECT count(*) AS n FROM channels WHERE moderation_dry_run_used_at IS NOT NULL'),
		feedbackPreviewAttempted: await scalar(client, 'channels.feedbackPreviewAttempted', 'SELECT count(*) AS n FROM channels WHERE feedback_dry_run_used_at IS NOT NULL'),
		everSuccessfulLiveRun: await scalar(client, 'channels.everSuccessfulLiveRun', 'SELECT count(*) AS n FROM channels WHERE last_success_at IS NOT NULL'),
		latestRunSucceeded: await scalar(client, 'channels.latestRunSucceeded', "SELECT count(*) AS n FROM channels WHERE last_run_status = 'success'"),
		latestRunFailed: await scalar(client, 'channels.latestRunFailed', "SELECT count(*) AS n FROM channels WHERE last_run_status = 'failed'"),
		neverRun: await scalar(client, 'channels.neverRun', 'SELECT count(*) AS n FROM channels WHERE last_run_status IS NULL'),
		lastRunFailureByCategory: await grouped(client, 'channels.lastRunFailureByCategory', "SELECT COALESCE(last_run_error, 'uncategorized') AS k, count(*) AS n FROM channels WHERE last_run_status = 'failed' GROUP BY k")
	};
}

async function reportModeration(client) {
	return {
		commentsByStatus: await grouped(client, 'comments.byStatus', 'SELECT status AS k, count(*) AS n FROM comments GROUP BY status'),
		auditActionsByType: await grouped(client, 'audit.byAction', 'SELECT action AS k, count(*) AS n FROM audit_log GROUP BY action'),
		actionsByState: await grouped(client, 'moderationActions.byState', 'SELECT state AS k, count(*) AS n FROM moderation_actions GROUP BY state'),
		feedbackDigestsByStatus: await grouped(client, 'feedbackDigests.byStatus', 'SELECT status AS k, count(*) AS n FROM feedback_digests GROUP BY status')
	};
}

async function reportLifecycle(client) {
	return {
		welcomeEmailsByState: await grouped(client, 'welcomeEmails.byState', 'SELECT state AS k, count(*) AS n FROM welcome_emails GROUP BY state'),
		contactSubmissionsByStatus: await grouped(client, 'contactSubmissions.byStatus', 'SELECT status AS k, count(*) AS n FROM contact_submissions GROUP BY status')
	};
}

async function reportBilling(client, inWindow) {
	return {
		stripeCheckoutAttemptsByStatus: await grouped(client, 'billing.stripeAttempts', 'SELECT status AS k, count(*) AS n FROM stripe_checkout_attempts GROUP BY status'),
		mercadoPagoCheckoutAttemptsByStatus: await grouped(client, 'billing.mercadoPagoAttempts', 'SELECT status AS k, count(*) AS n FROM mercado_pago_checkout_attempts GROUP BY status'),
		// 'fulfilled' is the only attempt state that drove a real grant — an
		// open/abandoned Checkout redirect is never counted as paid. The window
		// keys on updated_at, which the webhook stamps at fulfillment; Stripe
		// has no paid_at, and created_at misattributes cross-window checkouts.
		stripeCheckoutsFulfilledInWindow: await scalar(client, 'billing.stripeFulfilledInWindow', "SELECT count(*) AS n FROM stripe_checkout_attempts WHERE status = 'fulfilled' AND updated_at >= ? AND updated_at < ?", inWindow),
		// paid_at is stamped only when the grant actually completes; it survives
		// later status moves to refunded/disputed, while manual_refund_required
		// (approved but never granted) keeps paid_at NULL and stays excluded.
		mercadoPagoCheckoutsFulfilledInWindow: await scalar(client, 'billing.mercadoFulfilledInWindow', 'SELECT count(*) AS n FROM mercado_pago_checkout_attempts WHERE paid_at >= ? AND paid_at < ?', inWindow),
		creditLedgerByReason: await ledgerGrouped(client, 'billing.ledgerByReason', 'SELECT reason AS k, count(*) AS n, COALESCE(SUM(delta), 0) AS s FROM credit_transactions GROUP BY reason'),
		subscriptionPeriodsByStatus: await grouped(client, 'billing.subscriptionPeriods', 'SELECT status AS k, count(*) AS n FROM stripe_subscription_periods GROUP BY status'),
		orgsWithPaidSubscriptionPeriod: await scalar(client, 'billing.orgsWithPaidPeriod', "SELECT count(DISTINCT org_id) AS n FROM stripe_subscription_periods WHERE status = 'paid'"),
		lifetimeEntitlementsByStatus: await grouped(client, 'billing.lifetimeEntitlements', 'SELECT status AS k, count(*) AS n FROM stripe_lifetime_entitlements GROUP BY status'),
		lifetimeSlots: {
			total: await scalar(client, 'billing.lifetimeSlotsTotal', 'SELECT count(*) AS n FROM stripe_lifetime_slots'),
			held: await scalar(client, 'billing.lifetimeSlotsHeld', 'SELECT count(*) AS n FROM stripe_lifetime_slots WHERE active_org_id IS NOT NULL')
		}
	};
}

// Attention rolls up signals already grouped by other sections plus direct
// counts, so it takes their results instead of re-querying.
async function reportAttention(client, { users, organizations, channels, moderation, lifecycle, stripeAttempts, mercadoPagoAttempts }) {
	const commentsByStatus = moderation.commentsByStatus;
	const actionsByState = moderation.actionsByState;
	const digestsByStatus = moderation.feedbackDigestsByStatus;
	const welcomeByState = lifecycle.welcomeEmailsByState;
	return {
		channelsLatestRunFailed: channels.latestRunFailed,
		usersInZeroCreditCountdown: users.inZeroCreditCountdown,
		orgsAutoTopupPausedOrDisabled: organizations.autoTopupPausedOrDisabled,
		manualRefundRequiredCheckouts:
			(stripeAttempts.manual_refund_required ?? 0) + (mercadoPagoAttempts.manual_refund_required ?? 0),
		pendingReversals: await scalar(client, 'attention.pendingReversals', 'SELECT count(*) AS n FROM stripe_pending_reversals'),
		pendingDisputeReversals: await scalar(client, 'attention.pendingDisputeReversals', "SELECT count(*) AS n FROM stripe_dispute_reversals WHERE status = 'pending'"),
		unresolvedAutoTopupRecoveries: await scalar(client, 'attention.unresolvedAutoTopupRecoveries', 'SELECT count(*) AS n FROM stripe_auto_topup_recoveries WHERE resolved_at IS NULL'),
		unprocessedStripeEvents: await scalar(client, 'attention.unprocessedStripeEvents', 'SELECT count(*) AS n FROM stripe_events WHERE processed_at IS NULL'),
		pendingDeletionOutbox: await scalar(client, 'attention.pendingDeletionOutbox', 'SELECT count(*) AS n FROM stripe_deletion_outbox'),
		pendingGoogleRevocationOutbox: await scalar(client, 'attention.pendingGoogleRevocationOutbox', 'SELECT count(*) AS n FROM google_revocation_outbox'),
		pendingStripeScrubOutbox: await scalar(client, 'attention.pendingStripeScrubOutbox', 'SELECT count(*) AS n FROM stripe_scrub_outbox'),
		restoringComments: commentsByStatus.restoring ?? 0,
		queuedModerationActions: (actionsByState.pending ?? 0) + (actionsByState.dispatched ?? 0) + (actionsByState.cancelling ?? 0),
		failedFeedbackDigests: digestsByStatus.failed ?? 0,
		failedFeedbackDryRuns: digestsByStatus['dry-run-failed'] ?? 0,
		pendingFeedbackDryRuns: digestsByStatus['dry-run-pending'] ?? 0,
		failedWelcomeEmails: (welcomeByState.permanent_failure ?? 0) + (welcomeByState.ambiguous ?? 0),
		backloggedWelcomeEmails:
			(welcomeByState.queued ?? 0) + (welcomeByState.claimed ?? 0) + (welcomeByState.in_flight ?? 0) + (welcomeByState.retryable_failure ?? 0),
		pendingContactNotifications: await scalar(client, 'attention.pendingContactNotifications', 'SELECT count(*) AS n FROM contact_submissions WHERE notification_due_at IS NOT NULL AND notification_sent_at IS NULL')
	};
}

export async function buildReport(client, { since, until }) {
	// One read transaction pins every query to the same database state —
	// otherwise a signup or webhook landing mid-report would mix snapshots.
	const tx = await client.transaction('read');
	try {
		const tables = new Set(
			(await tx.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name))
		);
		const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
		if (missing.length) {
			throw new Error(`launch-report: database is missing required table(s): ${missing.join(', ')} — is this database fully migrated?`);
		}

		const inWindow = [since, until];
		const users = await reportUsers(tx, inWindow);
		const organizations = await reportOrganizations(tx);
		const channels = await reportChannels(tx, inWindow);
		const moderation = await reportModeration(tx);
		const lifecycle = await reportLifecycle(tx);
		const billing = await reportBilling(tx, inWindow);
		const attention = await reportAttention(tx, {
			users,
			organizations,
			channels,
			moderation,
			lifecycle,
			stripeAttempts: billing.stripeCheckoutAttemptsByStatus,
			mercadoPagoAttempts: billing.mercadoPagoCheckoutAttemptsByStatus
		});

		await tx.commit();
		return {
			report: 'launch-activity-snapshot',
			observedAt: new Date().toISOString(),
			window: { since, until },
			users,
			organizations,
			channels,
			moderation,
			lifecycle,
			billing,
			attention
		};
	} catch (error) {
		await tx.rollback().catch(() => {});
		throw error;
	}
}

// Exit 0 prints the snapshot; 1 = database/schema failure; 2 = bad args.
async function emitReport(url, authToken, window) {
	const client = createClient({ url, authToken });
	try {
		console.log(JSON.stringify(await buildReport(client, window), null, 2));
		return 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		client.close();
	}
}

async function runCli(argv) {
	let window;
	try {
		window = parseArgs(argv);
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		console.error(`launch-report: ${error.message}\n${USAGE}`);
		return 2;
	}
	const url = process.env.TURSO_DATABASE_URL;
	if (!url) {
		console.error('launch-report: TURSO_DATABASE_URL is not set (use --env-file=.env)');
		return 1;
	}
	return emitReport(url, process.env.TURSO_AUTH_TOKEN || undefined, window);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await runCli(process.argv.slice(2));
}
