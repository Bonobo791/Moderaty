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
	// setUTCFullYear takes the year literally; Date.UTC(0,…) maps to 1900,
	// which would wrongly reject the real leap day '0000-02-29'.
	const lastDayProbe = new Date(0);
	lastDayProbe.setUTCFullYear(Number(match[1]), month, 0);
	const lastDay = lastDayProbe.getUTCDate();
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

// An aggregate query that returns a missing/NULL/non-finite value has failed
// silently — emitting it would serialize NaN to null and lie to the operator.
function requireFinite(name, column, value) {
	if (value === null || value === undefined) {
		throw new Error(`launch-report: query ${name} returned a malformed aggregate (${column} is missing)`);
	}
	const n = Number(value);
	if (!Number.isFinite(n)) {
		throw new Error(`launch-report: query ${name} returned a malformed aggregate (${column}=${String(value)})`);
	}
	return n;
}

async function scalar(client, name, sql, args = []) {
	try {
		const result = await client.execute({ sql, args });
		if (result.rows.length === 0) throw new Error('malformed aggregate (no row)');
		return requireFinite(name, 'n', result.rows[0].n);
	} catch (error) {
		throw new Error(`launch-report: query ${name} failed — ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function grouped(client, name, sql, args = []) {
	try {
		const result = await client.execute({ sql, args });
		return Object.fromEntries(
			result.rows.map((row) => {
				if (row.k === null || row.k === undefined) throw new Error('malformed aggregate (key is missing)');
				return [String(row.k), requireFinite(name, 'n', row.n)];
			})
		);
	} catch (error) {
		throw new Error(`launch-report: query ${name} failed — ${error instanceof Error ? error.message : String(error)}`);
	}
}

// One ledger row per reason needs the grouped shape plus netCredits, which the
// k→n grouped() helper cannot express.
async function ledgerGrouped(client, name, sql) {
	try {
		const result = await client.execute(sql);
		return Object.fromEntries(
			result.rows.map((row) => {
				if (row.k === null || row.k === undefined) throw new Error('malformed aggregate (key is missing)');
				return [String(row.k), { rows: requireFinite(name, 'n', row.n), netCredits: requireFinite(name, 's', row.s) }];
			})
		);
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
		// 'disabled' is a shared terminal state: a plain owner opt-out, a refund
		// pause (pause_reason set), a card change, a dispute, or an auth/max-
		// failure disable (auto_topup_enabled stays 1 there — consent recorded
		// but the charge path failed). Report the raw states; attention weighs
		// only the operator-forced ones.
		autoTopupDisabled: await scalar(client, 'organizations.autoTopupDisabled', "SELECT count(*) AS n FROM organizations WHERE auto_topup_state = 'disabled'"),
		autoTopupPaused: await scalar(client, 'organizations.autoTopupPaused', 'SELECT count(*) AS n FROM organizations WHERE auto_topup_pause_reason IS NOT NULL')
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
		// Resuming a paused channel clears the run verdict (last_run_status →
		// NULL) but keeps last_run_at — the durable marker that a live run ever
		// happened. neverRun means "no live run yet", not "no current verdict".
		neverRun: await scalar(client, 'channels.neverRun', 'SELECT count(*) AS n FROM channels WHERE last_run_at IS NULL'),
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

// A grant is the immutable credit_transactions purchase row: applied once per
// (org_id, ref_type, ref_id) and never rewritten, while attempt timestamps
// (Stripe updated_at, MP paid_at) restamp on webhook replays. Stripe anchors
// on ref_id = stripe_session_id; Mercado Pago on 'mercadopago:<payment_id>'.
// manual_refund_required rows (approved, never granted) have no purchase row
// and stay excluded; refunds/disputes keep theirs and stay counted.
async function grantsInWindow(client, inWindow) {
	const anchor = "t.org_id = a.org_id AND t.ref_type = 'checkout_session' AND t.reason = 'purchase' AND t.delta > 0";
	return {
		stripeCheckoutsFulfilledInWindow: await scalar(
			client,
			'billing.stripeFulfilledInWindow',
			`SELECT count(*) AS n FROM stripe_checkout_attempts a JOIN credit_transactions t ON ${anchor} AND t.ref_id = a.stripe_session_id WHERE t.created_at >= ? AND t.created_at < ?`,
			inWindow
		),
		mercadoPagoCheckoutsFulfilledInWindow: await scalar(
			client,
			'billing.mercadoFulfilledInWindow',
			`SELECT count(*) AS n FROM mercado_pago_checkout_attempts a JOIN credit_transactions t ON ${anchor} AND t.ref_id = 'mercadopago:' || a.payment_id WHERE t.created_at >= ? AND t.created_at < ?`,
			inWindow
		)
	};
}

async function reportBilling(client, inWindow) {
	return {
		stripeCheckoutAttemptsByStatus: await grouped(client, 'billing.stripeAttempts', 'SELECT status AS k, count(*) AS n FROM stripe_checkout_attempts GROUP BY status'),
		mercadoPagoCheckoutAttemptsByStatus: await grouped(client, 'billing.mercadoPagoAttempts', 'SELECT status AS k, count(*) AS n FROM mercado_pago_checkout_attempts GROUP BY status'),
		...(await grantsInWindow(client, inWindow)),
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

// Persisted queue/outbox backlogs an operator needs to see draining.
async function attentionQueues(client) {
	return {
		pendingReversals: await scalar(client, 'attention.pendingReversals', 'SELECT count(*) AS n FROM stripe_pending_reversals'),
		pendingDisputeReversals: await scalar(client, 'attention.pendingDisputeReversals', "SELECT count(*) AS n FROM stripe_dispute_reversals WHERE status = 'pending'"),
		unresolvedAutoTopupRecoveries: await scalar(client, 'attention.unresolvedAutoTopupRecoveries', 'SELECT count(*) AS n FROM stripe_auto_topup_recoveries WHERE resolved_at IS NULL'),
		unprocessedStripeEvents: await scalar(client, 'attention.unprocessedStripeEvents', 'SELECT count(*) AS n FROM stripe_events WHERE processed_at IS NULL'),
		pendingDeletionOutbox: await scalar(client, 'attention.pendingDeletionOutbox', 'SELECT count(*) AS n FROM stripe_deletion_outbox'),
		pendingGoogleRevocationOutbox: await scalar(client, 'attention.pendingGoogleRevocationOutbox', 'SELECT count(*) AS n FROM google_revocation_outbox'),
		pendingStripeScrubOutbox: await scalar(client, 'attention.pendingStripeScrubOutbox', 'SELECT count(*) AS n FROM stripe_scrub_outbox'),
		pendingContactNotifications: await scalar(client, 'attention.pendingContactNotifications', 'SELECT count(*) AS n FROM contact_submissions WHERE notification_due_at IS NOT NULL AND notification_sent_at IS NULL'),
		// Forced pauses only: a refund pause (reason recorded) or a failure-
		// disabled org still holding consent (enabled=1 + disabled = auth/max-
		// failure path). A plain owner opt-out (enabled=0, no reason) is a
		// preference, not a problem.
		orgsAutoTopupNeedingAttention: await scalar(
			client,
			'attention.orgsAutoTopupNeedingAttention',
			"SELECT count(*) AS n FROM organizations WHERE auto_topup_pause_reason IS NOT NULL OR (auto_topup_enabled = 1 AND auto_topup_state = 'disabled')"
		)
	};
}

// Attention rolls up signals already grouped by other sections plus direct
// counts, so it takes their results instead of re-querying. An absent key in
// a grouped map means zero rows in that state — legitimate, not an error.
async function reportAttention(client, sections) {
	const welcome = sections.lifecycle.welcomeEmailsByState;
	return {
		...(await attentionQueues(client)),
		channelsLatestRunFailed: sections.channels.latestRunFailed,
		usersInZeroCreditCountdown: sections.users.inZeroCreditCountdown,
		manualRefundRequiredCheckouts:
			(sections.billing.stripeCheckoutAttemptsByStatus.manual_refund_required ?? 0) +
			(sections.billing.mercadoPagoCheckoutAttemptsByStatus.manual_refund_required ?? 0),
		restoringComments: sections.moderation.commentsByStatus.restoring ?? 0,
		queuedModerationActions:
			(sections.moderation.actionsByState.pending ?? 0) +
			(sections.moderation.actionsByState.dispatched ?? 0) +
			(sections.moderation.actionsByState.cancelling ?? 0),
		failedFeedbackDigests: sections.moderation.feedbackDigestsByStatus.failed ?? 0,
		failedFeedbackDryRuns: sections.moderation.feedbackDigestsByStatus['dry-run-failed'] ?? 0,
		pendingFeedbackDryRuns: sections.moderation.feedbackDigestsByStatus['dry-run-pending'] ?? 0,
		failedWelcomeEmails: (welcome.permanent_failure ?? 0) + (welcome.ambiguous ?? 0),
		backloggedWelcomeEmails:
			(welcome.queued ?? 0) + (welcome.claimed ?? 0) + (welcome.in_flight ?? 0) + (welcome.retryable_failure ?? 0)
	};
}

// The schema gate lives apart from the report body so a stale database fails
// before any section query runs.
async function requireSchema(tx) {
	const tables = new Set(
		(await tx.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name))
	);
	const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
	if (missing.length) {
		throw new Error(`launch-report: database is missing required table(s): ${missing.join(', ')} — is this database fully migrated?`);
	}
}

async function readSections(tx, { since, until }) {
	const inWindow = [since, until];
	const sections = {
		users: await reportUsers(tx, inWindow),
		organizations: await reportOrganizations(tx),
		channels: await reportChannels(tx, inWindow),
		moderation: await reportModeration(tx),
		lifecycle: await reportLifecycle(tx),
		billing: await reportBilling(tx, inWindow)
	};
	sections.attention = await reportAttention(tx, sections);
	return sections;
}

export async function buildReport(client, { since, until }) {
	// One read transaction pins every query to the same database state —
	// otherwise a signup or webhook landing mid-report would mix snapshots.
	const tx = await client.transaction('read');
	try {
		await requireSchema(tx);
		const sections = await readSections(tx, { since, until });
		await tx.commit();
		return {
			report: 'launch-activity-snapshot',
			observedAt: new Date().toISOString(),
			window: { since, until },
			...sections
		};
	} catch (error) {
		// The original failure is what the caller gets — but a cleanup failure
		// is still an operational fact, so it is logged, never swallowed.
		await tx.rollback().catch((rollbackError) => {
			console.error(`launch-report: snapshot rollback failed — ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
		});
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
