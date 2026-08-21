-- Moderaty — YouTube Comment Auto-Moderation Tool
-- Copyright (C) 2026 Andrew Philip Weilbacher
--
-- Licensed under the PolyForm Shield License 1.0.0; you may not use
-- this file except in compliance with the License. You may obtain a
-- copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
--
-- The software is provided "as is", without warranty or condition of
-- any kind, express or implied. See the License for the specific
-- language governing permissions and limitations under the License.
-- A copy of the License is included in the LICENSE file at the
-- repository root.
--
-- Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

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