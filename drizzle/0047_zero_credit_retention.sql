ALTER TABLE `users` ADD `zero_credits_since` text;--> statement-breakpoint
ALTER TABLE `users` ADD `zero_credits_notified_at` text;--> statement-breakpoint
ALTER TABLE `users` ADD `zero_credits_checked_at` text;--> statement-breakpoint
CREATE INDEX `users_zero_credits_checked_idx` ON `users` (`zero_credits_checked_at`);