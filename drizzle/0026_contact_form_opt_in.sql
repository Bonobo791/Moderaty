CREATE TABLE `contact_submissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`verification_token` text NOT NULL,
	`expires_at` text NOT NULL,
	`verified_at` text,
	`consent_text` text NOT NULL,
	`ip` text NOT NULL,
	`user_agent` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_submissions_verification_token_unique` ON `contact_submissions` (`verification_token`);--> statement-breakpoint
CREATE INDEX `contact_submissions_status_email_idx` ON `contact_submissions` (`status`,`email`);