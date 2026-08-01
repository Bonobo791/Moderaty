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

CREATE TABLE `consents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`doc_version` text NOT NULL,
	`checkbox_text` text NOT NULL,
	`ip` text NOT NULL,
	`user_agent` text NOT NULL,
	`marketing_opt_in` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `consents_user_id_idx` ON `consents` (`user_id`);