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

import { sqliteTable, text, integer, index, primaryKey, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
	id: text('id').primaryKey(), // random hex
	googleSub: text('google_sub').notNull().unique(), // Google's stable `sub` claim
	email: text('email').notNull(),
	displayName: text('display_name').notNull(),
	plan: text('plan').notNull().default('free'), // LEGACY — billing hooks live on organizations.plan; read nowhere
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
});

export const sessions = sqliteTable('sessions', {
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
	id: text('id').primaryKey(), // random hex
	name: text('name').notNull(),
	plan: text('plan').notNull().default('free'), // future Stripe gating hook (hosted plans)
	personalFor: text('personal_for').unique(), // users.id of the user this is the personal org for; null = shared org
	// Per-org BYOK OpenAI key (hosted plans), AES-256-GCM via crypto.ts —
	// owner-managed from the Team page; never serialized to the client.
	openaiKeyEnc: text('openai_key_enc'),
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
});

export const memberships = sqliteTable('memberships', {
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id, { onDelete: 'cascade' }),
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
	token: text('token').primaryKey(), // random 32-byte hex; also the URL path segment
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id, { onDelete: 'cascade' }),
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
	id: text('id').primaryKey(), // YouTube channel ID (UC...)
	userId: text('user_id'), // connected-by user (whose Google grant this channel uses); null = pre-accounts orphan, claimed on first login
	orgId: text('org_id'), // owning TENANT; null only for pre-accounts orphans (user_id IS NULL) awaiting first-login claim
	title: text('title').notNull(),
	refreshTokenEnc: text('refresh_token_enc').notNull(),
	cursor: text('cursor'), // scan boundary (ISO): comments older than this are never fetched. New connects start at connection time (no history analyzed); "analyze history" moves it back; null = legacy pre-window row (unbounded first scan)
	nextPageToken: text('next_page_token'), // YouTube continuation token for an incomplete scan
	scanCursor: text('scan_cursor'), // high-water timestamp to commit once an incomplete scan ends
	historyNextPageToken: text('history_next_page_token'), // history-drain continuation token (issue #70): the drain walks history independently so the live cursor keeps advancing on newest comments every run; null = no drain in flight
	historyBoundary: text('history_boundary'), // ISO timestamp the history drain started walking back from (its eventual end state: cursor = boundary)
	lastRunAt: text('last_run_at'), // ISO timestamp of last cron run; rotation orders by it ASC (NULLs first)
	leaseExpiresAt: text('lease_expires_at'), // expiring cron claim; null or past = claimable
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
	id: integer('id').primaryKey({ autoIncrement: true }),
	channelId: text('channel_id').notNull(),
	type: text('type').notNull(), // 'keyword' | 'regex' | 'user'
	pattern: text('pattern').notNull(), // keyword string | regex source | authorChannelId
	action: text('action').notNull(), // 'hold' | 'reject' | 'delete' | 'ban'
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
});

export const comments = sqliteTable('comments', {
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
	text: text('text').notNull(), // truncated to 500 chars on insert
	publishedAt: text('published_at').notNull(),
	status: text('status').notNull(), // 'pending' | 'approved' | 'held' | 'rejected' | 'deleted' | 'restoring' (in-flight undo)
	decidedBy: text('decided_by').notNull(), // 'rule' | 'ai' | 'human' | 'none'
	matchedRuleId: integer('matched_rule_id'),
	aiScore: text('ai_score'), // JSON string of the six category scores, or null
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
});

export const moderationActions = sqliteTable('moderation_actions', {
	commentId: text('comment_id').primaryKey(),
	channelId: text('channel_id').notNull(),
	action: text('action').notNull(), // 'hold' | 'reject' | 'delete' | 'ban'
	reason: text('reason').notNull(),
	state: text('state').notNull(), // 'pending' | 'dispatched' | 'completed' ('manual_review' legacy)
	lastAttemptAt: text('last_attempt_at'),
	lastManualRetryAt: text('last_manual_retry_at'),
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
}, (table) => [
	index('moderation_actions_channel_state_idx').on(table.channelId, table.state)
]);

export const auditLog = sqliteTable('audit_log', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	channelId: text('channel_id').notNull(),
	commentId: text('comment_id').notNull(),
	action: text('action').notNull(), // 'hold' | 'reject' | 'delete' | 'ban' | 'approve' | 'restore' | 'queue' | 'dry-run'
	reason: text('reason').notNull(), // human-readable, e.g. "rule #4 (keyword)" or "ai score 0.91"
	actor: text('actor').notNull(), // 'system' | 'user'
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
}, (table) => [
	// Dashboard ban counts (action='ban' + channel_id IN, issue #77) and the
	// per-channel log page both filter by channel_id; the composite serves
	// the ban query and its leftmost column serves channel-only reads.
	index('audit_log_channel_action_idx').on(table.channelId, table.action)
]);

// Evidentiary consent log (CDC Art. 6º, VIII; LGPD). One row per acceptance
// event — initial signup and every re-acceptance after a LEGAL_VERSION bump.
// Records exactly what was agreed to, when, and from where; never updated
// (except the cron sweep nulling `email` 10 years after acceptance). The
// e-mail lives HERE, not in the users row, because this log is the only
// place its retention is justified (Art. 16, III — blocked from any other
// use by architecture); account deletion wipes users.email entirely.
export const consents = sqliteTable('consents', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	email: text('email'), // retained consent evidence; nulled by the 10-year sweep
	docVersion: text('doc_version').notNull(), // LEGAL_VERSION accepted, e.g. 'v1.0'
	checkboxText: text('checkbox_text').notNull(), // exact text shown at acceptance
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
