DROP INDEX `stripe_pending_reversals_charge_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_pending_reversals_charge_reason_idx` ON `stripe_pending_reversals` (`charge_id`,`reason`);--> statement-breakpoint
DROP INDEX `stripe_events_type_object_idx`;--> statement-breakpoint
CREATE INDEX `stripe_events_type_object_idx` ON `stripe_events` (`event_type`,`object_id`);