CREATE TABLE `stripe_refund_observations` (
	`charge_id` text PRIMARY KEY NOT NULL,
	`refunded_amount_cents` integer NOT NULL,
	`occurred_at` text NOT NULL,
	`org_id` text
);
--> statement-breakpoint
ALTER TABLE `stripe_auto_topup_recoveries` ADD `lookup_cursor` text;--> statement-breakpoint
ALTER TABLE `stripe_auto_topup_recoveries` ADD `lookup_candidate_id` text;--> statement-breakpoint
CREATE INDEX `stripe_auto_topup_recoveries_customer_idx` ON `stripe_auto_topup_recoveries` (`customer_id`,`resolved_at`);