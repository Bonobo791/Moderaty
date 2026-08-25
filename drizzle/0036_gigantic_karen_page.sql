DROP INDEX `mercado_pago_attempts_payment_idx`;--> statement-breakpoint
ALTER TABLE `mercado_pago_checkout_attempts` ADD `credits` integer;