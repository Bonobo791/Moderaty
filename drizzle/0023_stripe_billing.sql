CREATE TABLE `credit_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`delta` integer NOT NULL,
	`reason` text NOT NULL,
	`ref_type` text NOT NULL,
	`ref_id` text NOT NULL,
	`payment_intent_id` text,
	`charge_id` text,
	`balance_after` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_transactions_org_ref_idx` ON `credit_transactions` (`org_id`,`ref_type`,`ref_id`);--> statement-breakpoint
CREATE INDEX `credit_transactions_org_created_idx` ON `credit_transactions` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `credit_transactions_pi_idx` ON `credit_transactions` (`payment_intent_id`);--> statement-breakpoint
CREATE INDEX `credit_transactions_charge_idx` ON `credit_transactions` (`charge_id`);--> statement-breakpoint
CREATE TABLE `stripe_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`object_id` text NOT NULL,
	`object_type` text NOT NULL,
	`received_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`processed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_events_event_id_unique` ON `stripe_events` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_events_type_object_idx` ON `stripe_events` (`event_type`,`object_id`);--> statement-breakpoint
ALTER TABLE `organizations` ADD `credits_remaining` integer;--> statement-breakpoint
ALTER TABLE `organizations` ADD `stripe_customer_id` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `stripe_default_pm_id` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `auto_topup_enabled` integer;--> statement-breakpoint
ALTER TABLE `organizations` ADD `auto_topup_threshold` integer;--> statement-breakpoint
ALTER TABLE `organizations` ADD `auto_topup_state` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `auto_topup_last_attempt_at` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `auto_topup_failures` integer;