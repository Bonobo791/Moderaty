ALTER TABLE `contact_submissions` ADD `message` text;--> statement-breakpoint
ALTER TABLE `contact_submissions` ADD `notification_due_at` text;--> statement-breakpoint
ALTER TABLE `contact_submissions` ADD `notification_claim` text;--> statement-breakpoint
ALTER TABLE `contact_submissions` ADD `notification_sent_at` text;--> statement-breakpoint
CREATE INDEX `contact_submissions_notification_due_idx` ON `contact_submissions` (`notification_due_at`);