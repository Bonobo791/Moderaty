PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stripe_auto_topup_recoveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text,
	`attempt_at` text NOT NULL,
	`payment_intent_id` text,
	`refund_id` text,
	`last_checked_at` text,
	`last_error` text,
	`resolved_at` text
);
--> statement-breakpoint
INSERT INTO `__new_stripe_auto_topup_recoveries`("id", "org_id", "customer_id", "attempt_at", "payment_intent_id", "refund_id", "last_checked_at", "last_error", "resolved_at") SELECT "id", "org_id", NULL, "attempt_at", "payment_intent_id", "refund_id", "last_checked_at", "last_error", "resolved_at" FROM `stripe_auto_topup_recoveries`;--> statement-breakpoint
DROP TABLE `stripe_auto_topup_recoveries`;--> statement-breakpoint
ALTER TABLE `__new_stripe_auto_topup_recoveries` RENAME TO `stripe_auto_topup_recoveries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_auto_topup_recoveries_attempt_idx` ON `stripe_auto_topup_recoveries` (`org_id`,`attempt_at`);--> statement-breakpoint
CREATE INDEX `stripe_auto_topup_recoveries_payment_idx` ON `stripe_auto_topup_recoveries` (`org_id`,`payment_intent_id`);--> statement-breakpoint
CREATE INDEX `stripe_auto_topup_recoveries_pending_idx` ON `stripe_auto_topup_recoveries` (`resolved_at`,`last_checked_at`);--> statement-breakpoint
ALTER TABLE `mercado_pago_checkout_attempts` ADD `refunded_amount_cents` integer;--> statement-breakpoint
ALTER TABLE `organizations` ADD `auto_topup_attempt_at` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `auto_topup_submitted_at` text;--> statement-breakpoint
ALTER TABLE `stripe_pending_reversals` ADD `occurred_at` text;
