CREATE TABLE `feedback_history_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`text` text NOT NULL,
	`published_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `feedback_history_comments_channel_idx` ON `feedback_history_comments` (`channel_id`);--> statement-breakpoint
ALTER TABLE `channels` ADD `moderation_dry_run_used_at` text;--> statement-breakpoint
ALTER TABLE `channels` ADD `feedback_dry_run_used_at` text;--> statement-breakpoint
ALTER TABLE `channels` ADD `feedback_history_boundary` text;--> statement-breakpoint
ALTER TABLE `channels` ADD `feedback_history_page_token` text;--> statement-breakpoint
UPDATE channels SET moderation_dry_run_used_at = COALESCE((SELECT MIN(audit_log.created_at) FROM audit_log WHERE audit_log.channel_id = channels.id AND audit_log.action = 'dry-run'), dry_run_boundary) WHERE dry_run_boundary IS NOT NULL OR EXISTS (SELECT 1 FROM audit_log WHERE audit_log.channel_id = channels.id AND audit_log.action = 'dry-run');