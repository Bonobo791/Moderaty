CREATE TABLE `invites` (
	`token` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`role` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` text NOT NULL,
	`accepted_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `invites_org_id_idx` ON `invites` (`org_id`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`user_id`, `org_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memberships_org_id_idx` ON `memberships` (`org_id`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`personal_for` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_personal_for_unique` ON `organizations` (`personal_for`);--> statement-breakpoint
ALTER TABLE `channels` ADD `org_id` text;--> statement-breakpoint
CREATE INDEX `channels_org_id_idx` ON `channels` (`org_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `active_org_id` text;--> statement-breakpoint
-- Backfill: one personal org per surviving user (tombstoned users get none —
-- their channels were already erased at deletion time), owner membership,
-- and channel tenancy. IDs are random hex, generated in SQL. Idempotent by
-- construction: personal_for is UNIQUE, memberships has a composite PK, and
-- the channel UPDATE only touches rows still missing org_id.
INSERT INTO organizations (id, name, plan, personal_for)
SELECT lower(hex(randomblob(16))), display_name, plan, id
FROM users
WHERE google_sub NOT LIKE 'deleted:%'
  AND id NOT IN (SELECT personal_for FROM organizations WHERE personal_for IS NOT NULL);
--> statement-breakpoint
INSERT INTO memberships (user_id, org_id, role)
SELECT personal_for, id, 'owner'
FROM organizations
WHERE personal_for IS NOT NULL
  AND personal_for NOT IN (SELECT user_id FROM memberships);
--> statement-breakpoint
UPDATE channels
SET org_id = (SELECT id FROM organizations WHERE organizations.personal_for = channels.user_id)
WHERE user_id IS NOT NULL AND org_id IS NULL;
