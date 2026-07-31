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

export const channels = sqliteTable('channels', {
	id: text('id').primaryKey(), // YouTube channel ID (UC...)
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
});

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
	authorChannelId: text('author_channel_id').notNull(),
	authorName: text('author_name').notNull(),
	text: text('text').notNull(), // truncated to 500 chars on insert
	publishedAt: text('published_at').notNull(),
	status: text('status').notNull(), // 'pending' | 'approved' | 'held' | 'rejected' | 'deleted'
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
	action: text('action').notNull(), // 'hold' | 'reject' | 'delete' | 'ban' | 'approve' | 'queue' | 'dry-run'
	reason: text('reason').notNull(), // human-readable, e.g. "rule #4 (keyword)" or "ai score 0.91"
	actor: text('actor').notNull(), // 'system' | 'user'
	createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
});
