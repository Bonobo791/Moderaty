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

-- Account deletion v2, in two parts:
--
-- 1. CONTRACT phase of the soft-delete removal: 0009/0010 added
--    users.deleted_at (+ index) for the 6-month soft delete that shipped in
--    PR #37; PR #42 removes every code path that reads it, so the column and
--    its index are dropped here. (0009/0010 stay in the journal — applied
--    migrations are immutable history.)
--
-- 2. Consent-evidence e-mail: the e-mail is statutory retention evidence
--    (LGPD Art. 16, III) and lives ONLY in the consent log, so account
--    deletion can wipe users.email entirely. Expand-only: nullable column +
--    backfill from the owning user. Accounts deleted BEFORE this ships carry
--    the tombstone sentinel users.email = '[deleted]' — NULLIF keeps that
--    sentinel out of the evidence log (their rows keep email NULL; that
--    history is unrecoverable by design, not a bug). The WHERE clause makes
--    the statement idempotent if ever re-run. The partial index serves the
--    10-year retention sweep (email IS NOT NULL AND created_at < cutoff).

DROP INDEX `users_deleted_at_idx`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `deleted_at`;--> statement-breakpoint
ALTER TABLE `consents` ADD `email` text;--> statement-breakpoint
UPDATE `consents`
SET `email` = NULLIF(
	(SELECT `email` FROM `users` WHERE `users`.`id` = `consents`.`user_id`),
	'[deleted]'
)
WHERE `consents`.`email` IS NULL;--> statement-breakpoint
CREATE INDEX `consents_email_retention_idx` ON `consents` (`created_at`) WHERE "consents"."email" is not null;
