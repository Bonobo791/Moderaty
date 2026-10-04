-- Replay the omitted 0064 DDL for databases already advanced to 0065.
-- Existing scheduler turns and previously applied migration hashes are preserved.
CREATE TABLE IF NOT EXISTS `cron_workload_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`next_workload` text DEFAULT 'preview' NOT NULL,
	CONSTRAINT "cron_workload_singleton" CHECK("cron_workload_state"."id" = 1),
	CONSTRAINT "cron_workload_kind" CHECK("cron_workload_state"."next_workload" IN ('preview', 'live'))
);
--> statement-breakpoint
-- Record 0064 only after its DDL has actually been replayed above.
INSERT INTO `__drizzle_migrations` (`hash`, `created_at`)
SELECT 'da0cfc786b88abfc6d1b32a8d6d9410d12bab723b5858f265c9fe1dcc759a80f', 1791063231735
WHERE NOT EXISTS (SELECT 1 FROM `__drizzle_migrations` WHERE `hash` = 'da0cfc786b88abfc6d1b32a8d6d9410d12bab723b5858f265c9fe1dcc759a80f');
