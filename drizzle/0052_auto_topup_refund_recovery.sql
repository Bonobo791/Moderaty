CREATE TABLE `stripe_auto_topup_recoveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`attempt_at` text NOT NULL,
	`payment_intent_id` text,
	`refund_id` text,
	`last_checked_at` text,
	`last_error` text,
	`resolved_at` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_auto_topup_recoveries_attempt_idx` ON `stripe_auto_topup_recoveries` (`org_id`,`attempt_at`);--> statement-breakpoint
CREATE INDEX `stripe_auto_topup_recoveries_pending_idx` ON `stripe_auto_topup_recoveries` (`resolved_at`,`last_checked_at`);