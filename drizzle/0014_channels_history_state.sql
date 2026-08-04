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

ALTER TABLE `channels` ADD `history_next_page_token` text;--> statement-breakpoint
ALTER TABLE `channels` ADD `history_boundary` text;--> statement-breakpoint
-- Backfill (issue #70): a drain in flight at deploy time keeps walking from
-- where it was — its continuation state is COPIED into the history columns.
-- The old columns are deliberately left untouched: the current backend still
-- reads/writes them until the pipeline live/drain split ships (expand only,
-- per I7; no contract phase, nothing is dropped).
UPDATE `channels`
SET `history_next_page_token` = `next_page_token`,
    `history_boundary` = `scan_cursor`
WHERE `next_page_token` IS NOT NULL;
