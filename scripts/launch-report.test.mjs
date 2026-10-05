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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

// Non-sentinel identifiers also planted in the fixture. The ENUM/KEY shape
// checks below would happily pass 'org-personal-1' as an enum label, so every
// identifying fixture literal — row ids, google subs, emails, names, tokens,
// provider refs — is asserted absent from raw stdout regardless of shape.
// (Enum values like 'fulfilled'/'token'/'quota' are legitimately emitted and
// are deliberately not listed.)
const FIXTURE_IDENTIFIERS = [
	'u-in-window', 'u-old', 'u-gone', 'u-boundary-in', 'u-boundary-out', 'u-broke',
	'gsub-old', 'gsub-broke', 'gsub-boundary-in', 'gsub-boundary-out',
	'old@example.com', 'b-in@example.com', 'b-out@example.com', 'broke@example.com',
	'Old User', 'B In', 'B Out', 'Broke User',
	'org-personal-1', 'org-personal-2', 'org-broke',
	'Personal One', 'Personal Two', 'Shared Org', 'Broke Org',
	'UC-failed', 'UC-washealthy', 'UC-idle', 'UC-orphan', 'UC-detached',
	'Chan One', 'Chan Two', 'Chan Three', 'Chan Four', 'Orphan Chan', 'Detached Chan',
	'enc-2', 'enc-3', 'enc-4', 'enc-5', 'enc-6',
	'c-1', 'c-2', 'c-3', 'c-4', 'c-x', 'c-y', 'dr-1',
	'held text', 'restoring text', 'deleted text',
	'sa-1', 'sa-2', 'sa-3', 'sa-4', 'sa-5', 'sa-6', 'sa-7', 'sa-8', 'sa-9', 'sa-10',
	'idem-2', 'idem-3', 'idem-4', 'idem-5', 'idem-6', 'idem-7', 'idem-8', 'idem-9', 'idem-10',
	'mp-1', 'mp-2', 'mp-3', 'mp-4', 'mp-5',
	'mpidem-1', 'mpidem-2', 'mpidem-3', 'mpidem-4', 'mpidem-5',
	'mp-pay-1', 'mp-pay-2', 'mp-pay-3', 'mp-pay-4',
	'mercadopago:mp-pay-1', 'mercadopago:mp-pay-3', 'mercadopago:mp-pay-4',
	'cs_sa2', 'cs_sa3', 'cs_sa4', 'cs_sa5', 'cs_sa6', 'cs_sa7', 'cs_sa8', 'cs_test_1',
	'UC-dryrun', 'UC-pausedfailed', 'UC-resumedfailed', 'Dryrun Chan', 'Pausedfailed Chan', 'Resumedfailed Chan', 'enc-7', 'enc-8', 'enc-9', 'c-5',
	'pi_topup_1', 'ch_topup_1', 'ch_ref', 'adj-1',
	'sub_old', 'in_old', 'cs_life_1', 'cs_life_2',
	'du_won', 'ch_dsp_1', 'ch_dsp_2', 'ch_pend_1'
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
	('u-broke', 'gsub-broke', 'broke@example.com', 'Broke User', '2026-10-05T10:00:00.000Z');
UPDATE users SET zero_credits_since = '2026-10-05T12:00:00.000Z' WHERE id = 'u-broke';
-- auto_topup_state='disabled' conflates intent: org-personal-1 was forced off
-- by a refund pause (pause_reason set), org-personal-2 failed off with consent
-- still recorded (enabled=1 — auth/max-failure path, autotopup.ts), and a plain
-- owner opt-out would read enabled=0/disabled/no reason. Each needs its own
-- report bucket.
INSERT INTO organizations (id, name, personal_for, credits_remaining, stripe_customer_id, stripe_subscription_status, auto_topup_enabled, auto_topup_state, auto_topup_pause_reason, created_at) VALUES
	('org-personal-1', 'Personal One', 'u-in-window', 50, 'cus_sentinel', NULL, 0, 'disabled', 'refund', '2026-10-04T12:00:00.000Z'),
	('org-personal-2', 'Personal Two', 'u-old', 0, NULL, 'active', 1, 'disabled', NULL, '2026-09-01T00:00:00.000Z'),
	('org-sentinel', 'Shared Org', NULL, 130, NULL, NULL, NULL, NULL, NULL, '2026-10-05T00:00:00.000Z'),
	('org-broke', 'Broke Org', 'u-broke', 0, NULL, NULL, NULL, NULL, NULL, '2026-10-05T10:00:00.000Z');
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
	-- Paused then resumed: the resume cleared the run verdict (last_run_status
	-- NULL) but the channel DID run once — last_run_at/last_success_at survive.
	-- It must not count as neverRun while also counting as ever successful.
	('UC-idle', 'u-old', 'org-personal-2', 'Chan Four', 'enc-4', 0, NULL, '2026-08-01T00:00:00.000Z', NULL, '2026-08-01T00:00:00.000Z', NULL, NULL, '2026-09-02T00:00:00.000Z'),
	('UC-orphan', NULL, NULL, 'Orphan Chan', 'enc-5', 0, NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-05T09:00:00.000Z'),
	-- Team channel detached by an account deletion: org kept, user cleared —
	-- it needs a reconnect, not a first-login claim.
	('UC-detached', NULL, 'org-sentinel', 'Detached Chan', 'enc-6', 0, NULL, NULL, NULL, NULL, NULL, NULL, '2026-09-15T00:00:00.000Z'),
	-- Cron's bookkeeping writes last_run_at on EVERY rotation — including a
	-- DRY_RUN run, which records no verdict (runHealth 'none' spreads nothing).
	-- A dry-run-only channel has run_at set but status/success NULL: it has
	-- never completed a LIVE run and must stay in neverRun.
	('UC-dryrun', 'u-old', 'org-personal-2', 'Dryrun Chan', 'enc-7', 1, NULL, NULL, NULL, '2026-10-05T10:00:00.000Z', NULL, NULL, '2026-10-05T09:30:00.000Z'),
	-- Pausing keeps the run verdict (only active flips to 0): a channel paused
	-- while holding 'failed' carries a stale failure forever. It belongs to the
	-- all-channel breakdown but not to live attention.
	('UC-pausedfailed', 'u-old', 'org-personal-2', 'Pausedfailed Chan', 'enc-8', 0, 'failed', NULL, 'timeout', '2026-10-05T11:00:00.000Z', NULL, NULL, '2026-10-05T08:00:00.000Z'),
	-- Ran live, produced output (c-5 below), failed, then was paused and
	-- resumed: the verdict is cleared but the moderation output proves a live
	-- run — it must NOT read as neverRun.
	('UC-resumedfailed', 'u-old', 'org-personal-2', 'Resumedfailed Chan', 'enc-9', 1, NULL, NULL, NULL, '2026-10-05T12:00:00.000Z', NULL, NULL, '2026-10-05T07:00:00.000Z');
INSERT INTO comments (id, channel_id, text, published_at, status, decided_by, human_dispatch_state) VALUES
	('c-1', 'UCsentinelchan', 'raw sentinel comment text', '2026-10-04T12:00:00.000Z', 'approved', 'ai', 'in_flight'),
	('c-2', 'UCsentinelchan', 'held text', '2026-10-04T12:30:00.000Z', 'held', 'rule', NULL),
	-- A remote human action that may or may not have landed: the verdict is
	-- recorded on the comment, independent of its moderation status.
	('c-3', 'UCsentinelchan', 'restoring text', '2026-10-04T13:00:00.000Z', 'restoring', 'human', 'uncertain'),
	('c-4', 'UC-failed', 'deleted text', '2026-10-04T14:00:00.000Z', 'deleted', 'ai', NULL),
	-- Durable live-run output for UC-resumedfailed: a dry run never writes
	-- comments rows, so this is what separates it from a dry-run-only channel.
	('c-5', 'UC-resumedfailed', 'resumed run text', '2026-10-05T11:30:00.000Z', 'approved', 'ai', NULL);
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
-- updated_at is NOT the grant time: webhooks restamp it on replay (sa-1's
	-- replay moved it past the window; sa-7's row was touched in-window though
	-- its durable grant landed days later). The immutable credit_transactions
	-- purchase row — inserted once per (org_id, ref_type, ref_id) — is the only
	-- honest window anchor.
INSERT INTO stripe_checkout_attempts (attempt_id, org_id, product, idempotency_key, stripe_session_id, status, created_at, updated_at) VALUES
	('sa-1', 'org-personal-1', 'credits_100', 'idem-sentinel', 'cs_sentinel_session', 'fulfilled', '2026-10-04T15:00:00.000Z', '2026-10-08T00:00:00.000Z'),
	('sa-2', 'org-personal-1', 'credits_500', 'idem-2', 'cs_sa2', 'open', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z'),
	('sa-3', 'org-personal-2', 'credits_100', 'idem-3', 'cs_sa3', 'expired', '2026-10-04T16:00:00.000Z', '2026-10-04T16:00:00.000Z'),
	('sa-4', 'org-sentinel', 'credits_100', 'idem-4', 'cs_sa4', 'manual_refund_required', '2026-10-05T01:00:00.000Z', '2026-10-05T01:00:00.000Z'),
	('sa-5', 'org-personal-1', 'credits_100', 'idem-5', 'cs_sa5', 'pending', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z'),
	-- Opened before the window, granted inside it: the ledger row counts.
	('sa-6', 'org-personal-1', 'credits_100', 'idem-6', 'cs_sa6', 'fulfilled', '2026-10-03T20:00:00.000Z', '2026-10-05T05:00:00.000Z'),
	-- Opened inside the window, granted a week later; an in-window webhook
	-- replay restamped updated_at — still outside the grant window.
	('sa-7', 'org-personal-2', 'credits_100', 'idem-7', 'cs_sa7', 'fulfilled', '2026-10-05T06:00:00.000Z', '2026-10-05T06:00:00.000Z'),
	-- A hosted-plan checkout grants no credits: its durable outcome is the
	-- subscription it starts, recorded by the first paid period below.
	('sa-8', 'org-personal-2', 'hosted', 'idem-8', 'cs_sa8', 'fulfilled', '2026-10-05T02:00:00.000Z', '2026-10-05T02:00:00.000Z'),
	-- A lifetime checkout grants no credits either: its durable outcome is the
	-- entitlement row (cs_life_1), whose created_at is immutable.
	('sa-9', 'org-sentinel', 'lifetime', 'idem-9', 'cs_life_1', 'fulfilled', '2026-10-05T03:00:00.000Z', '2026-10-05T03:00:00.000Z'),
	-- The operator's smoke test purchases through the same ledger path with
	-- product='test': real grant, but not a customer conversion.
	('sa-10', 'org-personal-1', 'test', 'idem-10', 'cs_test_1', 'fulfilled', '2026-10-05T04:00:00.000Z', '2026-10-05T04:00:00.000Z');
INSERT INTO mercado_pago_checkout_attempts (attempt_id, org_id, bundle_id, idempotency_key, payment_id, status, amount_cents, paid_at, created_at) VALUES
	-- A fulfillment replay restamped paid_at past the window; the immutable
	-- purchase ledger row still anchors the grant to 2026-10-05.
	('mp-1', 'org-sentinel', 'credits_100', 'mpidem-1', 'mp-pay-1', 'fulfilled', 4900, '2026-10-08T02:00:00.000Z', '2026-10-05T02:00:00.000Z'),
	-- Approved but refused before granting (unmetered org): payment_id exists
	-- but no purchase row was ever written — an alert, not a paid grant.
	('mp-2', 'org-personal-1', 'credits_100', 'mpidem-2', 'mp-pay-2', 'manual_refund_required', 4900, NULL, '2026-10-05T03:00:00.000Z'),
	-- Granted in-window but later refunded: the purchase row still counts.
	('mp-3', 'org-sentinel', 'credits_100', 'mpidem-3', 'mp-pay-3', 'refunded', 4900, '2026-10-04T10:00:00.000Z', '2026-10-03T23:00:00.000Z'),
	-- Opened in-window, paid the week after: paid_at lies in-window (a replay
	-- artifact) but the durable grant was on 2026-10-07 — outside.
	('mp-4', 'org-personal-2', 'credits_100', 'mpidem-4', 'mp-pay-4', 'fulfilled', 4900, '2026-10-05T12:00:00.000Z', '2026-10-05T01:00:00.000Z'),
	('mp-5', 'org-personal-1', 'credits_100', 'mpidem-5', NULL, 'open', 4900, NULL, '2026-10-05T04:00:00.000Z');
INSERT INTO credit_transactions (org_id, delta, reason, ref_type, ref_id, payment_intent_id, charge_id, balance_after, created_at) VALUES
	('org-personal-1', 100, 'purchase', 'checkout_session', 'cs_sentinel_session', 'pi_sentinel', 'ch_sentinel', 100, '2026-10-04T15:00:00.000Z'),
	('org-personal-1', -10, 'consume', 'comment', 'c-1', NULL, NULL, 90, '2026-10-05T00:00:00.000Z'),
	('org-personal-1', 100, 'auto_topup', 'payment_intent', 'pi_topup_1', 'pi_topup_1', 'ch_topup_1', 190, '2026-10-05T01:00:00.000Z'),
	('org-personal-1', 100, 'purchase', 'checkout_session', 'cs_sa6', NULL, NULL, 390, '2026-10-05T05:00:00.000Z'),
	('org-personal-2', 100, 'purchase', 'checkout_session', 'cs_sa7', NULL, NULL, 100, '2026-10-07T00:00:00.000Z'),
	('org-sentinel', 100, 'purchase', 'checkout_session', 'mercadopago:mp-pay-1', NULL, NULL, 100, '2026-10-05T02:00:00.000Z'),
	('org-sentinel', 100, 'purchase', 'checkout_session', 'mercadopago:mp-pay-3', NULL, NULL, 200, '2026-10-04T10:00:00.000Z'),
	('org-personal-2', 100, 'purchase', 'checkout_session', 'mercadopago:mp-pay-4', NULL, NULL, 200, '2026-10-07T01:00:00.000Z'),
	('org-sentinel', -30, 'consume', 'comment', 'c-9', NULL, NULL, 70, '2026-10-05T03:00:00.000Z'),
	('org-sentinel', 60, 'adjust', 'admin', 'adj-1', NULL, NULL, 130, '2026-10-05T04:00:00.000Z'),
	('org-broke', -100, 'refund', 'charge', 'ch_ref', 'pi_ref', 'ch_ref', -100, '2026-10-05T05:00:00.000Z'),
	-- The smoke-test checkout's real (1-credit) purchase row.
	('org-personal-1', 1, 'purchase', 'checkout_session', 'cs_test_1', NULL, NULL, 391, '2026-10-05T06:00:00.000Z');
-- created_at is set explicitly: the default is NOW, which would drift the
-- subscription-start metric relative to the fixed reporting window.
INSERT INTO stripe_subscription_periods (org_id, subscription_id, invoice_id, period_key, period_start, period_end, included_credits, consumed_credits, status, created_at) VALUES
	('org-personal-2', 'sub_sentinel', 'in_sentinel', '2026-10', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 100, 40, 'paid', '2026-10-05T00:00:00.000Z'),
	('org-sentinel', 'sub_old', 'in_old', '2026-09', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 100, 100, 'refunded', '2026-09-01T00:00:00.000Z');
INSERT INTO stripe_lifetime_entitlements (org_id, slot, checkout_session_id, status, created_at) VALUES
	('org-sentinel', 1, 'cs_life_1', 'active', '2026-10-05T00:00:00.000Z'),
	('org-personal-2', 2, 'cs_life_2', 'released', '2026-09-01T00:00:00.000Z');
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
	('UC-failed', '2026-10-05T00:00:00.000Z', '2026-10-05T12:00:00.000Z', 'dry-run-failed', 0),
	-- A deadline-deferred digest is unresolved work awaiting retry — the
	-- feedback page lists it beside failures, so attention must surface it.
	('UC-washealthy', '2026-10-04T00:00:00.000Z', '2026-10-05T00:00:00.000Z', 'deferred', 0);
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
		// Exact-boundary rows are parameterized: an interpolation literal inside
		// the SQL template trips static analysis, and the bound value lands
		// verbatim either way.
		await client.execute({ sql: "INSERT INTO users (id, google_sub, email, display_name, created_at) VALUES ('u-boundary-in', 'gsub-boundary-in', 'b-in@example.com', 'B In', ?)", args: [SINCE] });
		await client.execute({ sql: "INSERT INTO users (id, google_sub, email, display_name, created_at) VALUES ('u-boundary-out', 'gsub-boundary-out', 'b-out@example.com', 'B Out', ?)", args: [UNTIL] });
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

	it('honors year-0 leap days (Date.UTC would map 0000 to 1900)', async () => {
		// Year 0 is a leap year: '0000-02-29' is a real calendar day and must
		// parse, while '1900-02-29' (non-leap) must still be rejected.
		const { code, report } = await runReport(EMPTY_URL, ['--since', '0000-02-29', '--until', '0001-01-01']);
		expect(code).toBe(0);
		expect(report.window.since).toBe('0000-02-29T00:00:00.000Z');
		const bad = await runReport(EMPTY_URL, ['--since', '1900-02-29', '--until', UNTIL]);
		expect(bad.code).toBe(2);
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

	it('anchors a missing --since to the explicit --until, not to now', async () => {
		// With only --until given the window must END there: anchoring the
		// start to the current clock would produce a wrong or inverted window.
		const { code, report } = await runReport(EMPTY_URL, ['--until', UNTIL]);
		expect(code).toBe(0);
		expect(report.window.until).toBe(UNTIL);
		const since = Date.parse(report.window.since);
		const until = Date.parse(report.window.until);
		expect(until - since).toBe(30 * 24 * 60 * 60 * 1000);
		expect(report.window.since).toBe('2026-09-06T00:00:00.000Z');
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
		expect(report.channels.total).toBe(9);
		expect(report.channels.orgsWithChannels).toBe(3);
		expect(report.channels.usersWhoConnected).toBe(2);
		// Only UC-orphan is claimable; UC-detached kept its org and needs a
		// reconnect — it is not a pre-account orphan.
		expect(report.channels.orphanedAwaitingClaim).toBe(1);
		expect(report.channels.detachedAwaitingReconnect).toBe(1);
		expect(report.channels.active).toBe(5);
		expect(report.channels.inactive).toBe(4);
		expect(report.channels.createdInWindow).toBe(7);
	});

	it('separates a preview attempt from a completed live run', async () => {
		const { code, report } = await runReport(POPULATED_URL);
		expect(code).toBe(0);
		// moderation_dry_run_used_at marks an ATTEMPT: UCsentinelchan and
		// UC-failed both consumed it, but UC-failed never succeeded live.
		expect(report.channels.moderationPreviewAttempted).toBe(2);
		expect(report.channels.feedbackPreviewAttempted).toBe(1);
		// UC-idle paused and resumed: its verdict was cleared but its run and
		// success history are durable — it counts as ever-successful, never as
		// neverRun. UC-dryrun rotated under DRY_RUN (last_run_at written, no
		// verdict, no output) — a rotation is not a live run, so it joins
		// UC-orphan and UC-detached in neverRun. UC-resumedfailed's cleared
		// verdict looks identical but c-5's live output keeps it out.
		expect(report.channels.everSuccessfulLiveRun).toBe(3);
		expect(report.channels.latestRunSucceeded).toBe(1);
		// UC-pausedfailed carries a stale 'failed' verdict while paused — it is
		// part of the raw state breakdown but not live attention.
		expect(report.channels.latestRunFailed).toBe(3);
		expect(report.channels.neverRun).toBe(3);
		expect(report.channels.lastRunFailureByCategory).toEqual({ token: 1, quota: 1, timeout: 1 });
	});

	it('reports moderation activity and billing truth without counting redirects as grants', async () => {
		const { code, report } = await runReport(POPULATED_URL);
		expect(code).toBe(0);
		expect(report.moderation.commentsByStatus).toEqual({ approved: 2, held: 1, restoring: 1, deleted: 1 });
		expect(report.moderation.auditActionsByType).toEqual({ approve: 1, hold: 1, 'dry-run': 1, delete: 1, restore: 1 });
		expect(report.moderation.actionsByState).toEqual({ pending: 1, completed: 1, dispatched: 1 });
		expect(report.moderation.feedbackDigestsByStatus).toEqual({ complete: 1, failed: 1, 'dry-run-pending': 1, 'dry-run-failed': 1, deferred: 1 });
		// Remote human dispatches tracked per comment, independent of status:
		// c-1 is in flight, c-3's write may or may not have landed remotely.
		expect(report.moderation.humanDispatchesByState).toEqual({ in_flight: 1, uncertain: 1 });
		expect(report.lifecycle.welcomeEmailsByState).toEqual({ accepted: 1, permanent_failure: 1, queued: 1 });
		expect(report.lifecycle.contactSubmissionsByStatus).toEqual({ pending: 1, verified: 1 });
		// A checkout row is not a grant: statuses and products are reported
		// verbatim; only a durable grant record counts toward conversions.
		expect(report.billing.stripeCheckoutAttemptsByStatus).toEqual({ fulfilled: 6, open: 1, expired: 1, manual_refund_required: 1, pending: 1 });
		expect(report.billing.stripeCheckoutAttemptsByProduct).toEqual({ credits_100: 6, credits_500: 1, hosted: 1, lifetime: 1, test: 1 });
		expect(report.billing.mercadoPagoCheckoutAttemptsByStatus).toEqual({ fulfilled: 2, manual_refund_required: 1, refunded: 1, open: 1 });
		// Grant windows anchor on the immutable credit_transactions purchase row
		// (inserted once per org/ref anchor), never on restampable attempt
		// timestamps: sa-1's replayed updated_at moved past the window but its
		// grant row still counts; sa-7's in-window restamp does not move its
		// post-window grant forward. The operator's product='test' smoke
		// purchase is bucketed separately, never as a customer conversion.
		expect(report.billing.stripeCreditGrantsInWindow).toBe(2);
		expect(report.billing.stripeTestCreditGrantsInWindow).toBe(1);
		// Plan checkouts grant no credits — their durable outcomes anchor the
		// window instead: sa-9's lifetime entitlement and sa-8's subscription
		// first paid period (sub_sentinel) both landed in-window.
		expect(report.billing.stripeLifetimeGrantsInWindow).toBe(1);
		expect(report.billing.stripeHostedSubscriptionsStartedInWindow).toBe(1);
		// Same on MP: mp-1's replayed paid_at is ignored (ledger says in-window),
		// mp-3's refund doesn't erase the grant, mp-4's in-window paid_at replay
		// can't move its post-window ledger row, and mp-2 was approved but never
		// granted — no purchase row, no count.
		expect(report.billing.mercadoPagoCreditGrantsInWindow).toBe(2);
		// Stripe's manual_refund_required is terminal — nothing transitions it
		// after a human refunds — so it is a historical flag, not live
		// attention. MP's resolves to 'refunded' via the reversal webhook.
		expect(report.billing.stripeCheckoutsFlaggedManualRefund).toBe(1);
		expect(report.billing.creditLedgerByReason).toEqual({
			purchase: { rows: 7, netCredits: 601 },
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
		// 'disabled' is reported as a raw state, not as attention: org-personal-1
		// was refund-paused (pause_reason set) and org-personal-2 was
		// failure-disabled with consent still recorded (enabled=1).
		expect(report.organizations.autoTopupDisabled).toBe(2);
		expect(report.organizations.autoTopupPaused).toBe(1);
	});

	it('surfaces the persisted failure states that need attention', async () => {
		const { code, report } = await runReport(POPULATED_URL);
		expect(code).toBe(0);
		expect(report.attention).toMatchObject({
			// UC-pausedfailed is paused with a stale verdict — only active
			// channels can need attention now (UC-failed + UC-washealthy).
			activeChannelsLatestRunFailed: 2,
			usersInZeroCreditCountdown: 1,
			// Refund-paused (org-personal-1) and failure-disabled with consent
			// still recorded (org-personal-2) both need operator follow-up; a
			// plain owner opt-out would not.
			orgsAutoTopupNeedingAttention: 2,
			// MP's flag resolves to 'refunded' when the operator's manual refund
			// webhook lands; Stripe's terminal flag lives in billing instead.
			mercadoPagoManualRefundsOutstanding: 1,
			// c-3's remote human action may or may not have landed.
			uncertainHumanDispatches: 1,
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
			deferredFeedbackDigests: 1,
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
		for (const sentinel of [...SENTINELS, ...FIXTURE_IDENTIFIERS]) {
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
		// Snapshot every table's full contents — a field-level write inside any
		// fixture row must fail this test, not just a changed row count.
		const dump = async (client) => {
			const names = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows.map((r) => r.name);
			const tables = {};
			for (const name of names) {
				tables[name] = (await client.execute(`SELECT * FROM "${name}" ORDER BY rowid`)).rows;
			}
			return { tables, schemaVersion: (await client.execute('PRAGMA schema_version')).rows[0].schema_version };
		};
		const before = createClient({ url: POPULATED_URL });
		const prior = await dump(before);
		await runReport(POPULATED_URL);
		const after = createClient({ url: POPULATED_URL });
		expect(await dump(after)).toEqual(prior);
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
		let firstReadAt = Number.POSITIVE_INFINITY;
		const executions = [];
		const tx = {
			execute: async (stmt) => {
				firstReadAt = Math.min(firstReadAt, Date.now());
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
		// observedAt is the snapshot-establishment time, not the time all
		// queries finished — it must not postdate the first pinned read.
		expect(Date.parse(report.observedAt)).toBeLessThanOrEqual(firstReadAt);
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

	it('reports a failed rollback loudly while rethrowing the original error', async () => {
		const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const client = {
				transaction: async () => ({
					execute: async () => {
						throw new Error('db gone');
					},
					commit: async () => {},
					rollback: async () => {
						throw new Error('rollback failed');
					}
				})
			};
			// The original read failure is the error the caller sees; the
			// rollback failure is a stderr line, never a swallowed secret.
			await expect(buildReport(client, { since: SINCE, until: UNTIL })).rejects.toThrow('db gone');
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining('rollback failed'));
		} finally {
			stderr.mockRestore();
		}
	});

	it('rejects a malformed aggregate row instead of emitting NaN or a silent zero', async () => {
		for (const rows of [
			[], // count(*) driver bug: no row at all
			[{ n: null }], // SUM over an empty set without COALESCE
			[{ n: 'not-a-number' }]
		]) {
			const client = {
				transaction: async () => ({
					execute: async (stmt) => {
						const sql = typeof stmt === 'string' ? stmt : stmt.sql;
						if (sql.includes('sqlite_master')) return { rows: REQUIRED_TABLES.map((name) => ({ name })) };
						return { rows };
					},
					commit: async () => {},
					rollback: async () => {}
				})
			};
			await expect(buildReport(client, { since: SINCE, until: UNTIL })).rejects.toThrow(/malformed aggregate/);
		}
		// Grouped breakdowns get the same check: a NULL key or non-finite count
		// must fail loudly, not serialize as a 'null' bucket or JSON null.
		for (const rows of [[{ k: null, n: 1 }], [{ k: 'x', n: null }]]) {
			const client = {
				transaction: async () => ({
					execute: async (stmt) => {
						const sql = typeof stmt === 'string' ? stmt : stmt.sql;
						if (sql.includes('sqlite_master')) return { rows: REQUIRED_TABLES.map((name) => ({ name })) };
						if (sql.includes('GROUP BY')) return { rows };
						return { rows: [{ n: 0 }] };
					},
					commit: async () => {},
					rollback: async () => {}
				})
			};
			await expect(buildReport(client, { since: SINCE, until: UNTIL })).rejects.toThrow(/malformed aggregate/);
		}
	});
});
