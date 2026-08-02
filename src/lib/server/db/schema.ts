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

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
	id: text('id').primaryKey(), // random hex
	googleSub: text('google_sub').notNull().unique(), // Google's stable `sub` claim
	email: text('email').notNull(),
	displayName: text('display_name').notNull(),
	plan: text('plan').notNull().default('free'), // future Stripe gating hook (hosted plans)
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
});

export const sessions = sqliteTable('sessions', {
	id: text('id').primaryKey(), // random 32-byte hex token; also the cookie value
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	expiresAt: text('expires_at').notNull(), // ISO timestamp; sliding 30-day expiry
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
}, (table) => [
	index('sessions_user_id_idx').on(table.userId)
]);

export const channels = sqliteTable('channels', {
	id: text('id').primaryKey(), // YouTube channel ID (UC...)
	userId: text('user_id'), // owning user; null = pre-accounts orphan, claimed on first login
	title: text('title').notNull(),
	refreshTokenEnc: text('refresh_token_enc').notNull(),
	cursor: text('cursor'), // ISO timestamp of newest comment seen; null = never polled
	nextPageToken: text('next_page_token'), // YouTube continuation token for an incomplete scan
	scanCursor: text('scan_cursor'), // high-water timestamp to commit once an incomplete scan ends
	lastRunAt: text('last_run_at'), // ISO timestamp of last cron run; rotation orders by it ASC (NULLs first)
	leaseExpiresAt: text('lease_expires_at'), // expiring cron claim; null or past = claimable
	active: integer('active').notNull().default(1),
	toneLevel: integer('tone_level'), // moderation sensitivity: null or 1 = omni only, 2 = omni + tone pass
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
}, (table) => [
	index('channels_user_id_idx').on(table.userId)
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
});

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
