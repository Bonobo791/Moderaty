// Behavior tests for launch-report.mjs (MOD-271): the report must answer the
// three launch questions — surviving users/signups in the window, connected
// channels vs preview attempts vs successful live runs, and actual paid
// entitlements/credit grants — plus the persisted coarse failure states that
// need attention. Every test seeds real migrated state and execs the script,
// so a wrong query, a multiplied join, or a leaked raw value fails loudly.
// The report is read-only and aggregate-only by contract: the source scan and
// the sentinel-value assertions both pin that.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReport, REQUIRED_TABLES } from './launch-report.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('./launch-report.mjs', import.meta.url));
const DRIZZLE = fileURLToPath(new URL('../drizzle/', import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), 'launch-report-test-'));
const POPULATED_URL = `file:${join(tmp, 'populated.db')}`;
const EMPTY_URL = `file:${join(tmp, 'empty.db')}`;
const PREMIGRATION_URL = `file:${join(tmp, 'premigration.db')}`;

// Reporting window: the launch weekend, closed-open [since, until).
const SINCE = '2026-10-04T00:00:00.000Z';
const UNTIL = '2026-10-06T00:00:00.000Z';

// Sentinel strings live in every PII-shaped column the report could
// conceivably echo. The privacy test asserts none of them appear in stdout —
// and every emitted leaf value matches the aggregate whitelist.
const SENTINELS = [
	'sensitive-user@example.com',
	'Sentinel Name',
	'google-sub-sentinel',
	'S3NTINEL-TOKEN',
	'raw sentinel comment text',
	'@sentinelhandle',
	'contact-sentinel@example.com',
	'consent-sentinel@example.com',
	'192.0.2.77',
	'SentinelAgent/1.0',
	'cs_sentinel_session',
	'pi_sentinel',
	'ch_sentinel',
	'cus_sentinel',
	'sub_sentinel',
	'in_sentinel',
	'evt_sentinel',
	'idem-sentinel',
	'pref_sentinel',
	'du_sentinel',
	'UCsentinelchan',
	'org-sentinel',
	'WelcomeTemplateSentinel'
];

// Base tables predate migration tracking (same shape as seed-dev.test.mjs):
// channels/rules/comments/audit_log existed before drizzle/0000, so the
// journal only ALTERs them. Everything else comes from the migrations.
const BASE_DDL = `
CREATE TABLE channels (
	id text PRIMARY KEY NOT NULL,
	title text NOT NULL,
	refresh_token_enc text NOT NULL,
	cursor text,
	active integer NOT NULL DEFAULT 1,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE rules (
	id integer PRIMARY KEY AUTOINCREMENT,
	channel_id text NOT NULL,
	type text NOT NULL,
	pattern text NOT NULL,
	action text NOT NULL,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE comments (
	id text PRIMARY KEY NOT NULL,
	channel_id text NOT NULL,
	author_channel_id text,
	author_name text,
	text text NOT NULL,
	published_at text NOT NULL,
	status text NOT NULL,
	decided_by text NOT NULL,
	matched_rule_id integer,
	ai_score text,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE audit_log (
	id integer PRIMARY KEY AUTOINCREMENT,
	channel_id text NOT NULL,
	comment_id text NOT NULL,
	action text NOT NULL,
	reason text NOT NULL,
	actor text NOT NULL,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

async function applyMigrations(url, { base = true } = {}) {
	const client = createClient({ url });
	try {
		if (base) await client.executeMultiple(BASE_DDL);
		await migrate(drizzle(client), { migrationsFolder: DRIZZLE });
	} finally {
		client.close();
	}
}

// Fixture world for POPULATED_URL. Times are ISO strings straddling SINCE/UNTIL
// so the window tests exercise exact UTC boundary behavior. Every PII-shaped
// column carries a SENTINELS value.
const SEED_SQL = `
INSERT INTO users (id, google_sub, email, display_name, created_at) VALUES
	('u-in-window', 'google-sub-sentinel', 'sensitive-user@example.com', 'Sentinel Name', '2026-10-04T12:00:00.000Z'),
	('u-old', 'gsub-old', 'old@example.com', 'Old User', '2026-09-01T00:00:00.000Z'),
	('u-gone', 'deleted:u-gone', '[deleted]', '[deleted]', '2026-10-05T00:00:00.000Z'),
	('u-boundary-in', 'gsub-boundary-in', 'b-in@example.com', 'B In', '${SINCE}'),
	('u-boundary-out', 'gsub-boundary-out', 'b-out@example.com', 'B Out', '${UNTIL}'),
	('u-broke', 'gsub-broke', 'broke@example.com', 'Broke User', '2026-10-05T10:00:00.000Z');
UPDATE users SET zero_credits_since = '2026-10-05T12:00:00.000Z' WHERE id = 'u-broke';
INSERT INTO organizations (id, name, personal_for, credits_remaining, stripe_customer_id, stripe_subscription_status, auto_topup_state, auto_topup_pause_reason, created_at) VALUES
	('org-personal-1', 'Personal One', 'u-in-window', 50, 'cus_sentinel', NULL, 'disabled', 'sca_required', '2026-10-04T12:00:00.000Z'),
	('org-personal-2', 'Personal Two', 'u-old', 0, NULL, 'active', 'idle', NULL, '2026-09-01T00:00:00.000Z'),
	('org-sentinel', 'Shared Org', NULL, 130, NULL, NULL, NULL, NULL, '2026-10-05T00:00:00.000Z'),
	('org-broke', 'Broke Org', 'u-broke', 0, NULL, NULL, NULL, NULL, '2026-10-05T10:00:00.000Z');
INSERT INTO memberships (user_id, org_id, role) VALUES
	('u-in-window', 'org-personal-1', 'owner'),
	('u-in-window', 'org-sentinel', 'member'),
	('u-old', 'org-personal-2', 'owner'),
	('u-old', 'org-sentinel', 'admin'),
	('u-broke', 'org-broke', 'owner');
INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc, active, last_run_status, last_success_at, last_run_error, last_run_at, moderation_dry_run_used_at, feedback_dry_run_used_at, created_at) VALUES
	('UCsentinelchan', 'u-in-window', 'org-personal-1', 'Chan One', 'S3NTINEL-TOKEN', 1, 'success', '2026-10-05T06:00:00.000Z', NULL, '2026-10-05T06:00:00.000Z', '2026-10-04T13:00:00.000Z', NULL, '2026-10-04T12:30:00.000Z'),
	('UC-failed', 'u-in-window', 'org-personal-1', 'Chan Two', 'enc-2', 1, 'failed', NULL, 'token', '2026-10-05T07:00:00.000Z', '2026-10-04T14:00:00.000Z', '2026-10-05T01:00:00.000Z', '2026-10-04T13:00:00.000Z'),
	('UC-washealthy', 'u-old', 'org-sentinel', 'Chan Three', 'enc-3', 1, 'failed', '2026-10-04T20:00:00.000Z', 'quota', '2026-10-05T08:00:00.000Z', NULL, NULL, '2026-10-05T00:00:00.000Z'),
	('UC-idle', 'u-old', 'org-personal-2', 'Chan Four', 'enc-4', 0, NULL, NULL, NULL, NULL, NULL, NULL, '2026-09-02T00:00:00.000Z'),
	('UC-orphan', NULL, NULL, 'Orphan Chan', 'enc-5', 0, NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-05T09:00:00.000Z'),
	-- Team channel detached by an account deletion: org kept, user cleared —
	-- it needs a reconnect, not a first-login claim.
	('UC-detached', NULL, 'org-sentinel', 'Detached Chan', 'enc-6', 0, NULL, NULL, NULL, NULL, NULL, NULL, '2026-09-15T00:00:00.000Z');
INSERT INTO comments (id, channel_id, text, published_at, status, decided_by) VALUES
	('c-1', 'UCsentinelchan', 'raw sentinel comment text', '2026-10-04T12:00:00.000Z', 'approved', 'ai'),
	('c-2', 'UCsentinelchan', 'held text', '2026-10-04T12:30:00.000Z', 'held', 'rule'),
	('c-3', 'UCsentinelchan', 'restoring text', '2026-10-04T13:00:00.000Z', 'restoring', 'human'),
	('c-4', 'UC-failed', 'deleted text', '2026-10-04T14:00:00.000Z', 'deleted', 'ai');
INSERT INTO moderation_actions (comment_id, channel_id, action, reason, state, author_handle) VALUES
	('c-2', 'UCsentinelchan', 'hold', 'rule 1', 'pending', '@sentinelhandle'),
	('c-x', 'UCsentinelchan', 'reject', 'ai', 'completed', NULL),
	('c-y', 'UC-failed', 'delete', 'ai', 'dispatched', NULL);
INSERT INTO audit_log (channel_id, comment_id, action, reason, actor) VALUES
	('UCsentinelchan', 'c-1', 'approve', 'ai', 'system'),
	('UCsentinelchan', 'c-2', 'hold', 'rule', 'system'),
	('UCsentinelchan', 'dr-1', 'dry-run', 'preview', 'system'),
	('UC-failed', 'c-4', 'delete', 'ai', 'system'),
	('UCsentinelchan', 'c-3', 'restore', 'user', 'user');
INSERT INTO stripe_checkout_attempts (attempt_id, org_id, product, idempotency_key, status, created_at, updated_at) VALUES
	('sa-1', 'org-personal-1', 'credits_100', 'idem-sentinel', 'fulfilled', '2026-10-04T15:00:00.000Z', '2026-10-04T15:05:00.000Z'),
	('sa-2', 'org-personal-1', 'credits_500', 'idem-2', 'open', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z'),
	('sa-3', 'org-personal-2', 'credits_100', 'idem-3', 'expired', '2026-10-04T16:00:00.000Z', '2026-10-04T16:00:00.000Z'),
	('sa-4', 'org-sentinel', 'credits_100', 'idem-4', 'manual_refund_required', '2026-10-05T01:00:00.000Z', '2026-10-05T01:00:00.000Z'),
	('sa-5', 'org-personal-1', 'credits_100', 'idem-5', 'pending', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z'),
	-- Opened before the window, fulfilled inside it: fulfillment time counts.
	('sa-6', 'org-personal-1', 'credits_100', 'idem-6', 'fulfilled', '2026-10-03T20:00:00.000Z', '2026-10-05T05:00:00.000Z'),
	-- Opened inside the window, fulfilled a week later: outside the window.
	('sa-7', 'org-personal-2', 'credits_100', 'idem-7', 'fulfilled', '2026-10-05T06:00:00.000Z', '2026-10-07T00:00:00.000Z');
INSERT INTO mercado_pago_checkout_attempts (attempt_id, org_id, bundle_id, idempotency_key, status, amount_cents, paid_at, created_at) VALUES
	('mp-1', 'org-sentinel', 'credits_100', 'mpidem-1', 'fulfilled', 4900, '2026-10-05T02:00:00.000Z', '2026-10-05T02:00:00.000Z'),
	-- Approved but refused before granting (unmetered org): paid_at stays NULL,
	-- so it is a manual-refund alert, not a paid grant.
	('mp-2', 'org-personal-1', 'credits_100', 'mpidem-2', 'manual_refund_required', 4900, NULL, '2026-10-05T03:00:00.000Z'),
	-- Granted in-window but later refunded: still a paid grant in the period.
	('mp-3', 'org-sentinel', 'credits_100', 'mpidem-3', 'refunded', 4900, '2026-10-04T10:00:00.000Z', '2026-10-03T23:00:00.000Z'),
	-- Opened in-window, paid the week after: payment time falls outside.
	('mp-4', 'org-personal-2', 'credits_100', 'mpidem-4', 'fulfilled', 4900, '2026-10-07T01:00:00.000Z', '2026-10-05T01:00:00.000Z'),
	('mp-5', 'org-personal-1', 'credits_100', 'mpidem-5', 'open', 4900, NULL, '2026-10-05T04:00:00.000Z');
INSERT INTO credit_transactions (org_id, delta, reason, ref_type, ref_id, payment_intent_id, charge_id, balance_after, created_at) VALUES
	('org-personal-1', 100, 'purchase', 'checkout_session', 'cs_sentinel_session', 'pi_sentinel', 'ch_sentinel', 100, '2026-10-04T15:00:00.000Z'),
	('org-personal-1', -10, 'consume', 'comment', 'c-1', NULL, NULL, 90, '2026-10-05T00:00:00.000Z'),
	('org-personal-1', 100, 'auto_topup', 'payment_intent', 'pi_topup_1', 'pi_topup_1', 'ch_topup_1', 190, '2026-10-05T01:00:00.000Z'),
	('org-sentinel', 100, 'purchase', 'payment_id', 'mp-pay-1', NULL, NULL, 100, '2026-10-05T02:00:00.000Z'),
	('org-sentinel', -30, 'consume', 'comment', 'c-9', NULL, NULL, 70, '2026-10-05T03:00:00.000Z'),
	('org-sentinel', 60, 'adjust', 'admin', 'adj-1', NULL, NULL, 130, '2026-10-05T04:00:00.000Z'),
	('org-broke', -100, 'refund', 'charge', 'ch_ref', 'pi_ref', 'ch_ref', -100, '2026-10-05T05:00:00.000Z');
INSERT INTO stripe_subscription_periods (org_id, subscription_id, invoice_id, period_key, period_start, period_end, included_credits, consumed_credits, status) VALUES
	('org-personal-2', 'sub_sentinel', 'in_sentinel', '2026-10', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 100, 40, 'paid'),
	('org-sentinel', 'sub_old', 'in_old', '2026-09', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 100, 100, 'refunded');
INSERT INTO stripe_lifetime_entitlements (org_id, slot, checkout_session_id, status) VALUES
	('org-sentinel', 1, 'cs_life_1', 'active'),
	('org-personal-2', 2, 'cs_life_2', 'released');
UPDATE stripe_lifetime_slots SET active_org_id = 'org-sentinel', claimed_at = '2026-10-05T00:00:00.000Z' WHERE slot = 1;
UPDATE stripe_lifetime_slots SET claimed_at = '2026-09-15T00:00:00.000Z', released_at = '2026-10-01T00:00:00.000Z' WHERE slot = 2;
INSERT INTO stripe_pending_reversals (charge_id, reason) VALUES ('ch_pend_1', 'refund');
INSERT INTO stripe_dispute_reversals (dispute_id, charge_id, status, source) VALUES
	('du_sentinel', 'ch_dsp_1', 'pending', 'credits'),
	('du_won', 'ch_dsp_2', 'won', 'lifetime');
INSERT INTO stripe_auto_topup_recoveries (org_id, attempt_at, resolved_at) VALUES
	('org-personal-1', '2026-10-05T00:00:00.000Z', NULL),
	('org-personal-2', '2026-10-04T00:00:00.000Z', '2026-10-05T00:00:00.000Z');
INSERT INTO stripe_deletion_outbox (customer_id, attempts) VALUES ('cus_del_1', 2);
INSERT INTO google_revocation_outbox (channel_id, refresh_token_enc, attempts) VALUES ('UC-old-gone', 'enc-rev', 1);
INSERT INTO stripe_scrub_outbox (customer_id, org_id) VALUES ('cus_scrub_1', 'org-personal-2');
INSERT INTO stripe_events (event_id, event_type, object_id, object_type, processed_at) VALUES
	('evt_sentinel', 'checkout.session.completed', 'cs_sentinel_session', 'checkout_session', '2026-10-04T15:01:00.000Z'),
	('evt_unproc', 'charge.refunded', 'ch_pend_1', 'charge', NULL);
INSERT INTO welcome_emails (user_id, campaign, template_version, state, source, message_id) VALUES
	('u-in-window', 'welcome', 1, 'accepted', 'signup', 'WelcomeTemplateSentinel'),
	('u-old', 'welcome', 1, 'permanent_failure', 'backfill', 'msg-2'),
	('u-broke', 'welcome', 1, 'queued', 'signup', 'msg-3');
INSERT INTO feedback_digests (channel_id, window_start, window_end, status, comments_classified) VALUES
	('UCsentinelchan', '2026-10-04T00:00:00.000Z', '2026-10-05T00:00:00.000Z', 'complete', 12),
	('UC-failed', '2026-10-04T00:00:00.000Z', '2026-10-05T00:00:00.000Z', 'failed', 0),
	('UCsentinelchan', '2026-10-05T00:00:00.000Z', '2026-10-06T00:00:00.000Z', 'dry-run-pending', 0),
	('UC-failed', '2026-10-05T00:00:00.000Z', '2026-10-05T12:00:00.000Z', 'dry-run-failed', 0);
INSERT INTO contact_submissions (email, name, verification_token, expires_at, consent_text, ip, user_agent, status, notification_due_at, notification_sent_at) VALUES
	('contact-sentinel@example.com', 'Sentinel Name', 'tok-1', '2026-10-11T00:00:00.000Z', 'I agree', '192.0.2.77', 'SentinelAgent/1.0', 'pending', '2026-10-05T05:00:00.000Z', NULL),
	('verified@example.com', 'Ver', 'tok-2', '2026-10-11T00:00:00.000Z', 'I agree', '192.0.2.78', 'UA', 'verified', NULL, '2026-10-04T20:00:00.000Z');
INSERT INTO consents (user_id, email, doc_version, checkbox_text, ip, user_agent) VALUES
	('u-in-window', 'consent-sentinel@example.com', '1.18', 'cb', '192.0.2.77', 'SentinelAgent/1.0');
`;

async function seedPopulated() {
	const client = createClient({ url: POPULATED_URL });
	try {
		await client.executeMultiple(SEED_SQL);
	} finally {
		client.close();
	}
}

async function runReport(url, args = ['--since', SINCE, '--until', UNTIL]) {
	try {
		const { stdout } = await execFileAsync('node', [SCRIPT, ...args], {
			env: { ...process.env, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: '' }
		});
		return { code: 0, stdout, stderr: '', report: JSON.parse(stdout) };
	} catch (error) {
		return {
			code: error.code ?? 1,
			stdout: error.stdout ?? '',
			stderr: error.stderr ?? '',
			report: null
		};
	}
}

beforeAll(async () => {
	await applyMigrations(POPULATED_URL);
	await seedPopulated();
	await applyMigrations(EMPTY_URL);
	// A database the journal never ran against: only the base tables exist.
	const client = createClient({ url: PREMIGRATION_URL });
	await client.executeMultiple(BASE_DDL);
	client.close();
}, 120_000);

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe('launch-report CLI contract', () => {
	it('fails loudly when TURSO_DATABASE_URL is unset', async () => {
		const { code, stderr } = await (async () => {
			try {
				await execFileAsync('node', [SCRIPT], {
					env: { ...process.env, TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '' }
				});
				return { code: 0, stderr: '' };
			} catch (error) {
				return { code: error.code, stderr: `${error.stderr ?? ''}` };
			}
		})();
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/TURSO_DATABASE_URL/);
	});

	it('rejects unknown arguments and malformed dates with usage errors', async () => {
		for (const args of [
			['--bogus'],
			['--since', 'yesterday'],
			['--until', '2026-13-40'],
			// Date.parse silently normalizes impossible dates and accepts
			// non-ISO input — the operator must get an error, not a quiet
			// report over the wrong window.
			['--since', '2026-02-30'],
			['--until', 'October 4, 2026'],
			['--since', '2026-10-04T15:00'], // datetime without a zone is ambiguous
			['--since', SINCE, '--since', SINCE] // duplicate flag
		]) {
			const { code, stderr, report } = await runReport(POPULATED_URL, args);
			expect(code, `args ${args} must exit 2`).toBe(2);
			expect(stderr).toMatch(/usage|invalid|ISO|duplicate/i);
			expect(report).toBeNull();
		}
	});

	it('rejects an empty or inverted window', async () => {
		for (const args of [
			['--since', UNTIL, '--until', SINCE],
			['--since', SINCE, '--until', SINCE]
		]) {
			const { code } = await runReport(POPULATED_URL, args);
			expect(code, `window ${args} must exit 2`).toBe(2);
		}
	});

	it('defaults to the trailing 30 days when no window is passed', async () => {
		const { code, report } = await runReport(EMPTY_URL, []);
		expect(code).toBe(0);
		const since = Date.parse(report.window.since);
		const until = Date.parse(report.window.until);
		expect(until - since).toBe(30 * 24 * 60 * 60 * 1000);
	});

	it('fails loudly naming the missing tables on a pre-migration database', async () => {
		const { code, stderr } = await runReport(PREMIGRATION_URL);
		expect(code).toBe(1);
		expect(stderr).toMatch(/launch-report/);
		expect(stderr).toMatch(/users/);
		expect(stderr).toMatch(/stripe_lifetime_entitlements/);
	});
});

describe('launch-report content', () => {
	it('reports zero counts on an empty database and echoes the window', async () => {
		const { code, report } = await runReport(EMPTY_URL);
		expect(code).toBe(0);
		expect(report.report).toBe('launch-activity-snapshot');
		expect(report.window).toEqual({ since: SINCE, until: UNTIL });
		expect(report.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(report.users).toMatchObject({ live: 0, tombstoned: 0, signedUpInWindow: 0 });
		expect(report.channels).toMatchObject({ total: 0, moderationPreviewAttempted: 0, everSuccessfulLiveRun: 0 });
		expect(report.billing.stripeCheckoutAttemptsByStatus).toEqual({});
		// The 1,000 pre-created lifetime slots are schema state, not signups —
		// an empty DB still reports them as free, never as customers.
		expect(report.billing.lifetimeSlots).toEqual({ total: 1000, held: 0 });
	});

	it('distinguishes surviving users, tombstones, and exact window boundaries', async () => {
		const { code, report } = await runReport(POPULATED_URL);
		expect(code).toBe(0);
		// u-gone is a tombstone: counted separately, never as live. u-boundary-in
		// (created_at == since) counts; u-boundary-out (== until) does not —
		// closed-open [since, until).
		expect(report.users).toMatchObject({
			live: 5,
			tombstoned: 1,
			signedUpInWindow: 4,
			liveSignedUpInWindow: 3,
			inZeroCreditCountdown: 1
		});
	});

	it('counts orgs and channels at their own grains without join multiplication', async () => {
		const { code, report } = await runReport(POPULATED_URL);
		expect(code).toBe(0);
		expect(report.organizations.total).toBe(4);
		expect(report.organizations.personal).toBe(3);
		expect(report.organizations.shared).toBe(1);
		// org-sentinel has two members and one channel — neither join may
		// multiply it into two orgs or two users.
		expect(report.channels.total).toBe(6);
		expect(report.channels.orgsWithChannels).toBe(3);
		expect(report.channels.usersWhoConnected).toBe(2);
		// Only UC-orphan is claimable; UC-detached kept its org and needs a
		// reconnect — it is not a pre-account orphan.
		expect(report.channels.orphanedAwaitingClaim).toBe(1);
		expect(report.channels.detachedAwaitingReconnect).toBe(1);
		expect(report.channels.active).toBe(3);
		expect(report.channels.inactive).toBe(3);
		expect(report.channels.createdInWindow).toBe(4);
	});

	it('separates a preview attempt from a completed live run', async () => {
		const { code, report } = await runReport(POPULATED_URL);
		expect(code).toBe(0);
		// moderation_dry_run_used_at marks an ATTEMPT: UCsentinelchan and
		// UC-failed both consumed it, but UC-failed never succeeded live.
		expect(report.channels.moderationPreviewAttempted).toBe(2);
		expect(report.channels.feedbackPreviewAttempted).toBe(1);
		expect(report.channels.everSuccessfulLiveRun).toBe(2);
		expect(report.channels.latestRunSucceeded).toBe(1);
		expect(report.channels.latestRunFailed).toBe(2);
		expect(report.channels.neverRun).toBe(3);
		expect(report.channels.lastRunFailureByCategory).toEqual({ token: 1, quota: 1 });
	});

	it('reports moderation activity and billing truth without counting redirects as grants', async () => {
		const { code, report } = await runReport(POPULATED_URL);
		expect(code).toBe(0);
		expect(report.moderation.commentsByStatus).toEqual({ approved: 1, held: 1, restoring: 1, deleted: 1 });
		expect(report.moderation.auditActionsByType).toEqual({ approve: 1, hold: 1, 'dry-run': 1, delete: 1, restore: 1 });
		expect(report.moderation.actionsByState).toEqual({ pending: 1, completed: 1, dispatched: 1 });
		expect(report.moderation.feedbackDigestsByStatus).toEqual({ complete: 1, failed: 1, 'dry-run-pending': 1, 'dry-run-failed': 1 });
		expect(report.lifecycle.welcomeEmailsByState).toEqual({ accepted: 1, permanent_failure: 1, queued: 1 });
		expect(report.lifecycle.contactSubmissionsByStatus).toEqual({ pending: 1, verified: 1 });
		// A checkout row is not a grant: statuses are reported verbatim, and
		// only 'fulfilled' counts toward the in-window completed checkouts.
		expect(report.billing.stripeCheckoutAttemptsByStatus).toEqual({ fulfilled: 3, open: 1, expired: 1, manual_refund_required: 1, pending: 1 });
		expect(report.billing.mercadoPagoCheckoutAttemptsByStatus).toEqual({ fulfilled: 2, manual_refund_required: 1, refunded: 1, open: 1 });
		// Stripe keys on updated_at (stamped at fulfillment): sa-6 paid inside
		// the window though created before it; sa-7 paid after the window
		// though created inside it.
		expect(report.billing.stripeCheckoutsFulfilledInWindow).toBe(2);
		// MP keys on paid_at (set only when a grant actually completes): the
		// refunded row paid inside the window still counts, the in-window
		// checkout paid a week later does not, and manual_refund_required —
		// approved but never granted — is excluded via its NULL paid_at.
		expect(report.billing.mercadoPagoCheckoutsFulfilledInWindow).toBe(2);
		expect(report.billing.creditLedgerByReason).toEqual({
			purchase: { rows: 2, netCredits: 200 },
			consume: { rows: 2, netCredits: -40 },
			auto_topup: { rows: 1, netCredits: 100 },
			adjust: { rows: 1, netCredits: 60 },
			refund: { rows: 1, netCredits: -100 }
		});
		expect(report.billing.subscriptionPeriodsByStatus).toEqual({ paid: 1, refunded: 1 });
		expect(report.billing.orgsWithPaidSubscriptionPeriod).toBe(1);
		expect(report.billing.lifetimeEntitlementsByStatus).toEqual({ active: 1, released: 1 });
		expect(report.billing.lifetimeSlots).toEqual({ total: 1000, held: 1 });
		expect(report.organizations.withPositiveCredits).toBe(2);
		expect(report.organizations.creditsRemainingTotal).toBe(180);
	});

	it('surfaces the persisted failure states that need attention', async () => {
		const { code, report } = await runReport(POPULATED_URL);
		expect(code).toBe(0);
		expect(report.attention).toMatchObject({
			channelsLatestRunFailed: 2,
			usersInZeroCreditCountdown: 1,
			orgsAutoTopupPausedOrDisabled: 1,
			manualRefundRequiredCheckouts: 2,
			pendingReversals: 1,
			pendingDisputeReversals: 1,
			unresolvedAutoTopupRecoveries: 1,
			unprocessedStripeEvents: 1,
			pendingDeletionOutbox: 1,
			pendingGoogleRevocationOutbox: 1,
			pendingStripeScrubOutbox: 1,
			restoringComments: 1,
			queuedModerationActions: 2,
			failedFeedbackDigests: 1,
			failedFeedbackDryRuns: 1,
			pendingFeedbackDryRuns: 1,
			failedWelcomeEmails: 1,
			backloggedWelcomeEmails: 1,
			pendingContactNotifications: 1
		});
	});

	it('emits only aggregate-safe values — no raw user content, identifiers, or prose', async () => {
		const { code, stdout, report } = await runReport(POPULATED_URL);
		expect(code).toBe(0);
		for (const sentinel of SENTINELS) {
			expect(stdout, `output leaked ${sentinel}`).not.toContain(sentinel);
		}
		const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
		const ENUM = /^[a-z][a-z0-9_-]*$/;
		const KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;
		const walk = (node, path) => {
			for (const [key, value] of Object.entries(node)) {
				expect(KEY.test(key), `key ${path}${key} is not a safe label`).toBe(true);
				if (value !== null && typeof value === 'object') {
					walk(value, `${path}${key}.`);
				} else {
					const safe =
						typeof value === 'number' ||
						typeof value === 'boolean' ||
						value === null ||
						ISO.test(value) ||
						ENUM.test(value);
					expect(safe, `value at ${path}${key} is not aggregate-safe: ${JSON.stringify(value)}`).toBe(true);
				}
			}
		};
		walk(report, '');
	});

	it('writes nothing: schema, journal and fixture rows are untouched', async () => {
		const before = createClient({ url: POPULATED_URL });
		const count = async (client, sql) => Number((await client.execute(sql)).rows[0].n);
		const migrationsBefore = await count(before, 'SELECT count(*) AS n FROM __drizzle_migrations');
		const usersBefore = await count(before, 'SELECT count(*) AS n FROM users');
		const schemaVersion = (await before.execute('PRAGMA schema_version')).rows[0].schema_version;
		await runReport(POPULATED_URL);
		const after = createClient({ url: POPULATED_URL });
		expect(await count(after, 'SELECT count(*) AS n FROM __drizzle_migrations')).toBe(migrationsBefore);
		expect(await count(after, 'SELECT count(*) AS n FROM users')).toBe(usersBefore);
		expect((await after.execute('PRAGMA schema_version')).rows[0].schema_version).toBe(schemaVersion);
		before.close();
		after.close();
	});

	it('is idempotent: two runs differ only in observedAt', async () => {
		const first = await runReport(POPULATED_URL);
		const second = await runReport(POPULATED_URL);
		expect(first.code).toBe(0);
		expect(second.code).toBe(0);
		const { observedAt: a, ...restA } = first.report;
		const { observedAt: b, ...restB } = second.report;
		expect(restA).toEqual(restB);
	});

	it('runs every read inside one read transaction so the report is a single snapshot', async () => {
		let committed = false;
		let rolledBack = false;
		const executions = [];
		const tx = {
			execute: async (stmt) => {
				const sql = typeof stmt === 'string' ? stmt : stmt.sql;
				executions.push(sql);
				if (sql.includes('sqlite_master')) return { rows: REQUIRED_TABLES.map((name) => ({ name })) };
				return { rows: [{ n: 0, k: 'none', s: 0 }] };
			},
			commit: async () => {
				committed = true;
			},
			rollback: async () => {
				rolledBack = true;
			}
		};
		const client = {
			// Any read that escapes the transaction fails the test.
			execute: async () => {
				throw new Error('report read escaped the snapshot transaction');
			},
			transaction: async (mode) => {
				expect(mode).toBe('read');
				return tx;
			}
		};
		const report = await buildReport(client, { since: SINCE, until: UNTIL });
		expect(report.report).toBe('launch-activity-snapshot');
		expect(committed).toBe(true);
		expect(rolledBack).toBe(false);
		expect(executions.length).toBeGreaterThan(10);
	});

	it('rolls the snapshot transaction back when a read fails', async () => {
		let rolledBack = false;
		const client = {
			transaction: async () => ({
				execute: async () => {
					throw new Error('db gone');
				},
				commit: async () => {},
				rollback: async () => {
					rolledBack = true;
				}
			})
		};
		await expect(buildReport(client, { since: SINCE, until: UNTIL })).rejects.toThrow('db gone');
		expect(rolledBack).toBe(true);
	});
});
