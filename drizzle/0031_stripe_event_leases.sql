ALTER TABLE `stripe_events` ADD `processing_started_at` text;--> statement-breakpoint
ALTER TABLE `stripe_events` ADD `processing_attempts` integer DEFAULT 0 NOT NULL;