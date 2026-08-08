CREATE TABLE `channel_allowed_handles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` text NOT NULL,
	`handle` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `channel_allowed_handles_channel_idx` ON `channel_allowed_handles` (`channel_id`);--> statement-breakpoint
ALTER TABLE `audit_log` ADD `author_handle` text;