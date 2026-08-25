CREATE TABLE `mercado_pago_checkout_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` text NOT NULL,
	`org_id` text NOT NULL,
	`bundle_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`preference_id` text,
	`init_point` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`amount_cents` integer NOT NULL,
	`payment_id` text,
	`paid_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mercado_pago_checkout_attempts_attempt_id_unique` ON `mercado_pago_checkout_attempts` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mercado_pago_checkout_attempts_idempotency_key_unique` ON `mercado_pago_checkout_attempts` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `mercado_pago_checkout_attempts_preference_id_unique` ON `mercado_pago_checkout_attempts` (`preference_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mercado_pago_checkout_attempts_payment_id_unique` ON `mercado_pago_checkout_attempts` (`payment_id`);--> statement-breakpoint
CREATE INDEX `mercado_pago_attempts_org_status_idx` ON `mercado_pago_checkout_attempts` (`org_id`,`status`);--> statement-breakpoint
CREATE INDEX `mercado_pago_attempts_payment_idx` ON `mercado_pago_checkout_attempts` (`payment_id`);