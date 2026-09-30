CREATE TABLE `stripe_scrub_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` text NOT NULL,
	`org_id` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_scrub_outbox_customer_id_unique` ON `stripe_scrub_outbox` (`customer_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `zero_credits_warned_at` text;