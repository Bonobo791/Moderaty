DROP INDEX `feedback_digests_channel_window_unique`;--> statement-breakpoint
CREATE INDEX `feedback_digests_channel_window_idx` ON `feedback_digests` (`channel_id`,`window_start`,`window_end`);