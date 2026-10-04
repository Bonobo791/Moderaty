CREATE TABLE `welcome_discovery` (
	`campaign` text PRIMARY KEY NOT NULL,
	`after_user_id` text,
	`cycle_end_user_id` text,
	`claim_token` text,
	`lease_expires_at` text
);
