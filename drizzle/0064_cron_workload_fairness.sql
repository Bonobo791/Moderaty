CREATE TABLE `cron_workload_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`next_workload` text DEFAULT 'preview' NOT NULL,
	CONSTRAINT "cron_workload_singleton" CHECK("cron_workload_state"."id" = 1),
	CONSTRAINT "cron_workload_kind" CHECK("cron_workload_state"."next_workload" IN ('preview', 'live'))
);
