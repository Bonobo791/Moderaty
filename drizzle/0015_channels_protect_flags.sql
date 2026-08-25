-- Per-channel protection settings (off by default; the backend/frontend wire
-- the toggles and scoring behavior separately). NOT NULL DEFAULT 0 fills
-- existing rows in place — no backfill statement needed (expand-only, I7).
ALTER TABLE `channels` ADD `protect_lgbtqia` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `channels` ADD `protect_women` integer DEFAULT 0 NOT NULL;
