CREATE TABLE `stripe_dispute_reversals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dispute_id` text NOT NULL,
	`charge_id` text NOT NULL,
	`payment_intent_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`source` text DEFAULT 'unknown' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`restored_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_dispute_reversals_dispute_id_unique` ON `stripe_dispute_reversals` (`dispute_id`);--> statement-breakpoint
CREATE INDEX `stripe_dispute_reversals_charge_idx` ON `stripe_dispute_reversals` (`charge_id`);--> statement-breakpoint
ALTER TABLE `stripe_pending_reversals` ADD `dispute_id` text;