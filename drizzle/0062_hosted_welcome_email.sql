CREATE TABLE `welcome_emails` (
	`user_id` text NOT NULL,
	`campaign` text NOT NULL,
	`template_version` integer NOT NULL,
	`state` text NOT NULL,
	`cohort` text,
	`source` text NOT NULL,
	`message_id` text NOT NULL,
	`queued_at` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` text,
	`last_error` text,
	`next_retry_at` text,
	`claim_token` text,
	`lease_expires_at` text,
	`accepted_at` text,
	`provider_message_id` text,
	`suppression_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`user_id`, `campaign`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "welcome_emails_state" CHECK("welcome_emails"."state" IN ('never_sent', 'historical_unknown', 'queued', 'claimed', 'in_flight', 'accepted', 'retryable_failure', 'permanent_failure', 'suppressed', 'ambiguous'))
);
--> statement-breakpoint
CREATE INDEX `welcome_emails_due_idx` ON `welcome_emails` (`state`,`next_retry_at`);--> statement-breakpoint
CREATE INDEX `welcome_emails_lease_idx` ON `welcome_emails` (`state`,`lease_expires_at`);