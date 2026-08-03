-- Moderaty — YouTube Comment Auto-Moderation Tool
-- Copyright (C) 2026 Andrew Philip Weilbacher
--
-- This program is free software: you can redistribute it and/or modify
-- it under the terms of the GNU Affero General Public License as published
-- by the Free Software Foundation, either version 3 of the License, or
-- (at your option) any later version.
--
-- This program is distributed in the hope that it will be useful,
-- but WITHOUT ANY WARRANTY; without even the implied warranty of
-- MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
-- GNU Affero General Public License for more details.
--
-- You should have received a copy of the GNU Affero General Public License
-- along with this program. If not, see <https://www.gnu.org/licenses/>.
--
-- Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- Retry guard: if a previous run aborted mid-rebuild (e.g. the copy hit the
-- CHECK on pre-existing violating rows), the temp table is still there.
DROP TABLE IF EXISTS `__new_channels`;--> statement-breakpoint
CREATE TABLE `__new_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`org_id` text,
	`title` text NOT NULL,
	`refresh_token_enc` text NOT NULL,
	`cursor` text,
	`next_page_token` text,
	`scan_cursor` text,
	`last_run_at` text,
	`lease_expires_at` text,
	`active` integer DEFAULT 1 NOT NULL,
	`tone_level` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "channels_org_requires_owner" CHECK("__new_channels"."org_id" IS NOT NULL OR "__new_channels"."user_id" IS NULL)
);
--> statement-breakpoint
INSERT INTO `__new_channels`("id", "user_id", "org_id", "title", "refresh_token_enc", "cursor", "next_page_token", "scan_cursor", "last_run_at", "lease_expires_at", "active", "tone_level", "created_at") SELECT "id", "user_id", "org_id", "title", "refresh_token_enc", "cursor", "next_page_token", "scan_cursor", "last_run_at", "lease_expires_at", "active", "tone_level", "created_at" FROM `channels`;--> statement-breakpoint
DROP TABLE `channels`;--> statement-breakpoint
ALTER TABLE `__new_channels` RENAME TO `channels`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `channels_user_id_idx` ON `channels` (`user_id`);--> statement-breakpoint
CREATE INDEX `channels_org_id_idx` ON `channels` (`org_id`);