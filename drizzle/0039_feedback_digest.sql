CREATE TABLE `feedback_digests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`status` text NOT NULL,
	`comments_classified` integer DEFAULT 0 NOT NULL,
	`comments_failed` integer DEFAULT 0 NOT NULL,
	`pooled_count` integer DEFAULT 0 NOT NULL,
	`credits_used` integer,
	`error` text,
	`emailed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_digests_channel_window_unique` ON `feedback_digests` (`channel_id`,`window_start`,`window_end`);--> statement-breakpoint
CREATE INDEX `feedback_digests_channel_created_idx` ON `feedback_digests` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `feedback_findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`digest_id` integer NOT NULL,
	`category` text NOT NULL,
	`summary` text NOT NULL,
	`supporter_count` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`digest_id`) REFERENCES `feedback_digests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feedback_findings_digest_idx` ON `feedback_findings` (`digest_id`);--> statement-breakpoint
CREATE TABLE `finding_evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`finding_id` integer NOT NULL,
	`comment_id` text NOT NULL,
	`sanitized_excerpt` text NOT NULL,
	`has_abuse` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`finding_id`) REFERENCES `feedback_findings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `finding_evidence_finding_idx` ON `finding_evidence` (`finding_id`);--> statement-breakpoint
ALTER TABLE `channels` ADD `feedback_enabled` integer;--> statement-breakpoint
ALTER TABLE `channels` ADD `feedback_cadence` text;--> statement-breakpoint
ALTER TABLE `channels` ADD `feedback_categories` text;--> statement-breakpoint
ALTER TABLE `channels` ADD `feedback_threshold` integer;--> statement-breakpoint
ALTER TABLE `channels` ADD `feedback_email` integer;--> statement-breakpoint
ALTER TABLE `channels` ADD `feedback_last_digest_at` text;