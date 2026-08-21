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

ALTER TABLE `channels` ADD `history_next_page_token` text;--> statement-breakpoint
ALTER TABLE `channels` ADD `history_boundary` text;--> statement-breakpoint
-- Backfill (issue #70): a drain in flight at deploy time keeps walking from
-- where it was — its continuation state is COPIED into the history columns.
-- The old columns are deliberately left untouched: the current backend still
-- reads/writes them until the pipeline live/drain split ships (expand only,
-- per I7; no contract phase, nothing is dropped). Rows with a continuation
-- token but no scan boundary are NOT resumable drains (no defined end state),
-- so they are skipped rather than backfilled into an unresumable shape.
UPDATE `channels`
SET `history_next_page_token` = `next_page_token`,
    `history_boundary` = `scan_cursor`
WHERE `next_page_token` IS NOT NULL AND `scan_cursor` IS NOT NULL;
