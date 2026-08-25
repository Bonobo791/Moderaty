-- Expand phase of the author-PII removal: relax the author columns to
-- nullable so pre- and post-change code coexist during rollout (a later
-- contract migration drops them). The table rebuild is also the wipe —
-- the INSERT SELECT carries NULL for both author columns, destroying
-- previously stored author identifiers.

CREATE TABLE `__new_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`author_channel_id` text,
	`author_name` text,
	`text` text NOT NULL,
	`published_at` text NOT NULL,
	`status` text NOT NULL,
	`decided_by` text NOT NULL,
	`matched_rule_id` integer,
	`ai_score` text,
	`created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);--> statement-breakpoint
INSERT INTO `__new_comments` (`id`, `channel_id`, `author_channel_id`, `author_name`, `text`, `published_at`, `status`, `decided_by`, `matched_rule_id`, `ai_score`, `created_at`)
SELECT `id`, `channel_id`, NULL, NULL, `text`, `published_at`, `status`, `decided_by`, `matched_rule_id`, `ai_score`, `created_at` FROM `comments`;--> statement-breakpoint
DROP TABLE `comments`;--> statement-breakpoint
ALTER TABLE `__new_comments` RENAME TO `comments`;
