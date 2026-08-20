CREATE TABLE `stripe_checkout_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` text NOT NULL,
	`org_id` text NOT NULL,
	`product` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`stripe_session_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_checkout_attempts_attempt_id_unique` ON `stripe_checkout_attempts` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_checkout_attempts_idempotency_key_unique` ON `stripe_checkout_attempts` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_checkout_attempts_stripe_session_id_unique` ON `stripe_checkout_attempts` (`stripe_session_id`);--> statement-breakpoint
CREATE INDEX `stripe_checkout_attempts_org_status_idx` ON `stripe_checkout_attempts` (`org_id`,`status`);