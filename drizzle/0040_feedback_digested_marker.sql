ALTER TABLE `comments` ADD `feedback_digested_at` text;--> statement-breakpoint
CREATE INDEX `comments_channel_digested_idx` ON `comments` (`channel_id`,`feedback_digested_at`);