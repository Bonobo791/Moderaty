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
-- Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

-- Per-channel protection settings (off by default; the backend/frontend wire
-- the toggles and scoring behavior separately). NOT NULL DEFAULT 0 fills
-- existing rows in place — no backfill statement needed (expand-only, I7).
ALTER TABLE `channels` ADD `protect_lgbtqia` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `channels` ADD `protect_women` integer DEFAULT 0 NOT NULL;
