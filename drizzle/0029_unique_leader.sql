ALTER TABLE `organizations` ADD `stripe_subscription_id` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `stripe_subscription_status` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `stripe_subscription_period_start` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `stripe_subscription_period_end` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `stripe_subscription_cancel_at_period_end` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_stripe_customer_id_unique` ON `organizations` (`stripe_customer_id`) WHERE "organizations"."stripe_customer_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_stripe_subscription_id_unique` ON `organizations` (`stripe_subscription_id`) WHERE "organizations"."stripe_subscription_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `stripe_lifetime_slots` (
	`slot` integer PRIMARY KEY NOT NULL,
	`active_org_id` text,
	`active_entitlement_id` integer,
	`claimed_at` text,
	`released_at` text,
	FOREIGN KEY (`active_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `stripe_lifetime_slots_active_org_idx` ON `stripe_lifetime_slots` (`active_org_id`);--> statement-breakpoint
WITH RECURSIVE slots(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM slots WHERE n < 1000)
INSERT INTO `stripe_lifetime_slots` (`slot`) SELECT n FROM slots;--> statement-breakpoint
CREATE TABLE `stripe_subscription_periods` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`payment_intent_id` text,
	`charge_id` text,
	`period_key` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`included_credits` integer DEFAULT 100 NOT NULL,
	`consumed_credits` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'paid' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_subscription_periods_invoice_id_unique` ON `stripe_subscription_periods` (`invoice_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_subscription_periods_subscription_period_unique` ON `stripe_subscription_periods` (`subscription_id`,`period_key`);--> statement-breakpoint
CREATE INDEX `stripe_subscription_periods_org_period_idx` ON `stripe_subscription_periods` (`org_id`,`period_start`);--> statement-breakpoint
CREATE INDEX `stripe_subscription_periods_payment_intent_idx` ON `stripe_subscription_periods` (`payment_intent_id`);--> statement-breakpoint
CREATE INDEX `stripe_subscription_periods_charge_idx` ON `stripe_subscription_periods` (`charge_id`);--> statement-breakpoint
CREATE TABLE `stripe_lifetime_entitlements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`slot` integer NOT NULL,
	`checkout_session_id` text NOT NULL,
	`payment_intent_id` text,
	`charge_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`released_at` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`slot`) REFERENCES `stripe_lifetime_slots`(`slot`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_lifetime_entitlements_checkout_session_id_unique` ON `stripe_lifetime_entitlements` (`checkout_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_lifetime_entitlements_active_org_idx` ON `stripe_lifetime_entitlements` (`org_id`) WHERE "stripe_lifetime_entitlements"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_lifetime_entitlements_active_slot_idx` ON `stripe_lifetime_entitlements` (`slot`) WHERE "stripe_lifetime_entitlements"."status" = 'active';--> statement-breakpoint
CREATE INDEX `stripe_lifetime_entitlements_payment_intent_idx` ON `stripe_lifetime_entitlements` (`payment_intent_id`);--> statement-breakpoint
CREATE INDEX `stripe_lifetime_entitlements_charge_idx` ON `stripe_lifetime_entitlements` (`charge_id`);