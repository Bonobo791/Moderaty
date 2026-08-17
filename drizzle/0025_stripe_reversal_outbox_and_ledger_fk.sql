CREATE TABLE `stripe_deletion_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_deletion_outbox_customer_id_unique` ON `stripe_deletion_outbox` (`customer_id`);--> statement-breakpoint
CREATE TABLE `stripe_pending_reversals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`charge_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_pending_reversals_charge_id_unique` ON `stripe_pending_reversals` (`charge_id`);--> statement-breakpoint
ALTER TABLE `credit_transactions` ALTER COLUMN "org_id" TO "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE cascade ON UPDATE no action;